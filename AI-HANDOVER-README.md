# GALAXY SMS — Complete AI Handover & Engineering Architecture Reference

> **AUTHORITATIVE HANDOVER DOCUMENTATION FOR FUTURE AI DEVELOPERS & SYSTEM ENGINEERS**  
> **Notice:** This document is completely self-contained. It assumes you have NO prior conversation history, NO access to previous chat prompts, and NO tribal knowledge of historical design discussions. Everything documented here reflects the **actual, audited, verified code and database state** of the Galaxy SMS platform.  
> **System Branding:** Galaxy SMS (Official)  
> **Repository Root:** `/home/user/Galaxy-Sms` (Local Workspace) / Target VPS Deploy Path: `/opt/galaxy-sms` or `F:\galaxy-sms`  

---

## Table of Contents
1. [System Overview & Technology Stack](#1-system-overview--technology-stack)
2. [Platform Architecture & 4-Tier Hierarchy](#2-platform-architecture--4-tier-hierarchy)
3. [Role-by-Role Functional & Authorization Deep Dive](#3-role-by-role-functional--authorization-deep-dive)
4. [Allocation Systems: Range Allocation vs SMS Number Allocation](#4-allocation-systems-range-allocation-vs-sms-number-allocation)
5. [Rate Architecture & Financial Payout System](#5-rate-architecture--financial-payout-system)
6. [Partner Panel Sharing (Activity, HTTP, SMPP)](#6-partner-panel-sharing-activity-http-smpp)
7. [Reporting, Analytics & CDR Engines](#7-reporting-analytics--cdr-engines)
8. [Reusable Inside-Search Dropdown Engine (`renderSearchSelect`)](#8-reusable-inside-search-dropdown-engine-rendersearchselect)
9. [Cryptographic Security & Account PIN Architecture](#9-cryptographic-security--account-pin-architecture)
10. [Database Architecture & Verified Schema](#10-database-architecture--verified-schema)
11. [Authoritative REST API Route Catalog](#11-authoritative-rest-api-route-catalog)
12. [GitHub to VPS Deployment Workflow](#12-github-to-vps-deployment-workflow)
13. [Clean VPS Zero-to-End Installation & Setup Guide](#13-clean-vps-zero-to-end-installation--setup-guide)
14. [Operational Tooling & Utility Scripts](#14-operational-tooling--utility-scripts)
15. [Automated Backup, Storage & Recovery Runbook](#15-automated-backup-storage--recovery-runbook)
16. [Performance, Capacity Benchmarks & Scale Analysis (~30M Numbers)](#16-performance-capacity-benchmarks--scale-analysis-30m-numbers)
17. [Current Platform State](#17-current-platform-state)
18. [20 Mandatory Rules for Future AI Developers](#18-20-mandatory-rules-for-future-ai-developers)

---

## 1. System Overview & Technology Stack

**Galaxy SMS** is a high-throughput, multi-tenant telecom SMS and OTP ingestion, hierarchy-allocation, financial accounting, and partner distribution engine. It enables administrators to import millions of telecom virtual mobile numbers (MSISDNs), organize them into geographic/carrier ranges, apply Rate Card tiers, delegate ranges down a multi-level organizational chain (Manager $\to$ Agent $\to$ Client), ingest incoming carrier SMS webhooks, monitor real-time OTP traffic, account for margins, and export allocations.

### 1.1 Verified Technology Stack
- **Runtime Environment:** Node.js (LTS v18.x or v20.x, tested on v20.20.2).
- **Core Server Framework:** Express.js (`4.21.2`) with native HTTP server.
- **Database Engine:** SQLite 3 via `better-sqlite3` (`11.10.0`), running compiled native C++ bindings for deterministic single-process execution.
- **Journal Mode:** Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) with `PRAGMA synchronous = NORMAL;`.
- **Concurrency & Offloading:** Node.js `worker_threads` for non-blocking asynchronous CSV generation (`backend/server.js`).
- **Protocols Supported:**
  - REST / Webhook Ingestion (`application/json`, `application/x-www-form-urlencoded`, `multipart/form-data`).
  - SMPP v3.4 (Both ESME Client Transmitter/Receiver and SMSC Server Listener modes via `smpp` library `0.6.0-rc.4`).
- **Frontend Architecture:** Vanilla JavaScript (ES6+), pure CSS custom properties (`assets/galaxy.css`), SVG icons, and a custom inside-search dropdown engine (`assets/galaxy.js`). Zero frontend build tools, compilers, or heavy node frameworks (no React, Angular, Vue, Vite, or Webpack required).

---

## 2. Platform Architecture & 4-Tier Hierarchy

The core system enforces an explicit 4-tier organizational hierarchy. Permissions, database query scoping, rate visibility, and number pools are strictly isolated at the database layer:

```
                          ┌────────────────────────┐
                          │         ADMIN          │
                          │ Full System Controller │
                          └───────────┬────────────┘
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
         ┌──────────────────┐                  ┌──────────────────┐
         │     MANAGER      │                  │   DIRECT AGENT   │
         │  Sub-Tree Master │                  │   (Under Admin)  │
         └─────────┬────────┘                  └─────────┬────────┘
                   │                                     │
         ┌─────────┴─────────┐                           │
         ▼                   ▼                           ▼
   ┌───────────┐       ┌───────────┐               ┌───────────┐
   │SUB-AGENT 1│       │SUB-AGENT 2│               │  CLIENT   │
   └─────┬─────┘       └─────┬─────┘               └───────────┘
         │                   │
         ▼                   ▼
   ┌───────────┐       ┌───────────┐
   │  CLIENT   │       │  CLIENT   │
   └───────────┘       └───────────┘
```

### 2.1 The Hierarchy Chain
1. **Admin:** Master operator. Owns all numbers, creates Ranges, sets Carrier Provider Rates, creates Managers and Direct Agents, sets Master Rate Cards, and oversees all system billing.
2. **Manager (`parent_id` = Admin ID):** Oversees their dedicated sub-tree. Admin allocates a quantity of numbers from a Range to a Manager. The Manager can then allocate those numbers down to their subordinate Agents or directly to Clients.
3. **Agent (`parent_id` = Manager ID or Admin ID):** Direct customer-facing tier. Receives numbers from Manager (or Admin), reassigns numbers directly between clients, monitors OTPs, and requests payouts. Payout modifications are protected by their **Account Security PIN**.
4. **Client (`parent_id` = Agent ID, Manager ID, or Admin ID):** Consumes numbers. Logs into `client.html` to view assigned numbers and incoming SMS messages/OTPs in real time.
5. **Test Panel (`test.html`):** Public/internal diagnostic panel for live testing of numbers, OTP detection, and CLI masking.

---

## 3. Role-by-Role Functional & Authorization Deep Dive

Role authorization is enforced on the server by the `requireRole(...roles)` middleware in `backend/server.js`. The client-side UI routes are also guarded by `API.guard(role)` in `api.js`.

### 3.1 Admin Portal (`admin.html`)
- **Access Route:** `/admin` (Redirects to `/panel-login` if unauthenticated).
- **Backend Permission:** `requireRole('admin')`.
- **Core Functions:**
  - **Live Dashboard:** Displays System Health, Total Numbers, Active Ingest, Real Carrier Cost Today, Payout Liability Today, Gross Margin, and 7-day volume bar charts.
  - **Range Management:** Create, edit, and configure geographic/telecom ranges. Configures real carrier base costs: `provider_rate_daily`, `provider_rate_weekly`, `provider_rate_monthly`.
  - **SMS Numbers Pool:** Browse, search, filter, and allocate numbers across the entire system. Uses custom inside-search dropdowns for Range and Owner filters.
  - **Rate Management (Rate Card):** Configures default selling price tiers (Daily, Weekly, Monthly) per range.
  - **User Management:** Create, edit, activate, or disable Managers, Agents, and Clients.
  - **Agent Account PIN:** Manage Agent Security PINs (unlock/reset passwords, toggle PIN lock, clear brute-force lockouts).
  - **Financial Management (`payMgmt`):** Configure withdrawal minimums, daily/weekly/monthly payout schedules, review and approve/reject agent withdrawal requests.
  - **Support Complaints:** View, respond to, and update statuses of support complaints submitted by agents and clients.
  - **Carrier Integrations & Sync:** Configure HTTP webhook callbacks and background telecom provider pull synchronizers.
  - **SMPP Protocol Management:** Add, configure, start, and stop SMPP Client binds and Server listeners.
  - **Database & Backups:** View database engine status, WAL checkpoint status, trigger manual VACUUM backups, and restore snapshots.

### 3.2 Manager Portal (`manager.html`)
- **Access Route:** `/manager` (Guarded: `role === 'manager'`).
- **Backend Scope:** Scoped strictly by `manager_id = req.user.id`. A Manager cannot see or access numbers, agents, clients, or SMS traffic belonging to other managers.
- **Core Functions:**
  - **Dashboard:** Sub-tree metrics (total assigned numbers, today's SMS volume, active sub-agents, active clients).
  - **Sub-Agent & Client Management:** Create sub-agents and subordinate clients.
  - **Range & SMS Numbers Allocation:** Allocate quantities from assigned range pools to sub-agents or clients.
  - **Safe Unallocation:** Reclaim unallocated quantities back to the manager pool without stealing numbers actively holding OTPs.
  - **Sub-Tree Reports & Detailed CDR:** Filter SMS history by Range, Agent, and Client using inside-search dropdowns.
  - **Financial Overview:** View earnings based on the margin between the Manager Rate and Sub-Agent Rate.

### 3.3 Agent Portal (`agent.html`)
- **Access Route:** `/agent` (Guarded: `role === 'agent'`).
- **Backend Scope:** Scoped strictly by `agent_id = req.user.id`.
- **Core Functions:**
  - **SMS Numbers Management:** View assigned numbers. Direct reassignment allows moving numbers from Client A to Client B instantly with a single dropdown selection.
  - **Live SMS Feed:** Real-time incoming OTP feed with automatic polling.
  - **Payment & Wallet Section (`#page-payment`):**
    - **Security Lock:** Access to balances, wallet settings, and withdrawal submission is **strictly blocked** until the agent enters their **Account Security PIN**.
    - **Binance UID Lock:** Agents configure their 8–12 digit Binance UID. Once saved, it is cryptographically locked in `agent_wallets` to prevent payout hijacking.
    - **Withdrawal Requests:** Submit withdrawal requests against open ledger balances once the minimum threshold is met.
  - **Complaints Ticketing:** File support tickets directly to Admin.

### 3.4 Client Portal (`client.html`)
- **Access Route:** `/client` (Guarded: `role === 'client'`).
- **Backend Scope:** Scoped strictly by `client_id = req.user.id`.
- **Core Functions:**
  - **Live Numbers View:** View active numbers assigned to the client.
  - **Real-Time SMS & OTP Feed:** Displays timestamp, Range Name, Number, Sender CLI, and highlighted OTP code.
  - **SMS Detailed Report:** Search historical SMS logs on client numbers.
  - **Test Panel Access:** Test active numbers directly.

---

## 4. Allocation Systems: Range Allocation vs SMS Number Allocation

The platform maintains two fundamentally different allocation paradigms: **Range Allocation (Quantity Pool)** and **SMS Number Allocation (Specific Numbers)**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RANGE ALLOCATION                                  │
│  - Quantity-based pool reservation.                                         │
│  - Does NOT assign specific phone numbers to users.                         │
│  - Establishes quota in `range_allocations` table.                          │
│  - Clamped safely to available inventory: min(requested, available).       │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SMS NUMBER ALLOCATION                                │
│  - Assigns SPECIFIC rows in `numbers` table.                                │
│  - Sets `numbers.manager_id`, `agent_id`, and `client_id`.                  │
│  - Attaches effective selling rate (`numbers.client_rate`, `numbers.payout`)│
│  - Direct Reassignment: Move from Client A to Client B in 1 step.           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Range Allocation Mechanics
- **Target Table:** `range_allocations (range_id, user_id, quantity, ...)`.
- **Quantity Handling & Clamping:**
  When allocating $N$ numbers from Range $R$ to User $U$:
  1. The system checks total physical numbers in Range $R$: $Total$.
  2. It calculates already allocated quantity across all users: $Allocated$.
  3. Available quota is: $Available = Total - Allocated$.
  4. If the user requests $N > Available$, the system **safely clamps** the allocation to $Available$, allocating what is truly available without failing or generating negative quotas.
- **Safe Unallocation / Reduction:**
  When reducing an allocation:
  The reduction is strictly clamped to the user's current owned allocation:
  $$Quantity_{new} = \max(0, Quantity_{current} - Reduction)$$

### 4.2 SMS Number Allocation Mechanics
- **Target Table:** `numbers (id, number, range_id, manager_id, agent_id, client_id, rate, payout, ...)`.
- **Selection Isolation:**
  When Admin allocates numbers to Manager:
  ```sql
  WHERE range_id = ? AND manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL
  ```
  Only numbers that have **never been allocated** down the chain can be claimed. Numbers already held by direct Agents or Clients are 100% protected.
- **Direct Reassignment (Zero Unallocation Friction):**
  In `agent.html`, an agent can directly select a number assigned to Client A and reassign it to Client B via a single dropdown action (`POST /api/numbers/reassign` or `PUT /api/numbers/:id`). The backend atomically updates `client_id = Client_B` without requiring a tedious manual unallocation step.
- **Atomic Serialization:**
  All allocation modifications execute within SQLite `BEGIN IMMEDIATE ... COMMIT` transaction blocks. Concurrent requests attempting to allocate the same range are queued, preventing race conditions or duplicate number assignments.

---

## 5. Rate Architecture & Financial Payout System

A cornerstone of Galaxy SMS is the strict financial separation between **Carrier Provider Cost** (upstream expense) and **Customer Selling Price** (downstream revenue).

### 5.1 Provider Base Rates (Real Upstream Cost)
- Configured in the `ranges` table:
  - `provider_rate_daily`: Base carrier cost per SMS for daily billing.
  - `provider_rate_weekly`: Base carrier cost per SMS for weekly billing.
  - `provider_rate_monthly`: Base carrier cost per SMS for monthly billing.
- **IMMUTABILITY RULE:** These columns represent the actual telecom supplier cost. Downstream users, allocations, or partner overrides can **NEVER** alter these values.

### 5.2 Selling Rates & Rate Card Hierarchy
- **Master Rate Cards:** Defined per range for Daily, Weekly, and Monthly tiers.
- **Hierarchy Rate Columns in `numbers`:**
  - `manager_rate`: Effective rate earned by the Manager.
  - `agent_rate`: Effective rate earned by the Agent.
  - `client_rate` / `payout`: Rate credited to the Client / partner per received OTP.
- **Override Handling:** When an Admin or Manager allocates numbers and specifies a custom selling price, the backend updates `numbers.client_rate` and `numbers.payout` for the selected numbers while leaving `ranges.provider_rate_*` completely untouched.

### 5.3 Financial Ledger Flow on Incoming SMS
When an incoming SMS is received on number $N$:
1. The carrier webhook delivers the SMS payload to `POST /api/incoming-sms`.
2. The system looks up number $N$ in `numbers` and retrieves its hierarchy: `manager_id`, `agent_id`, `client_id`, `manager_rate`, `agent_rate`, `client_rate`.
3. If an OTP is detected:
   - Carrier expense is calculated using `ranges.provider_rate_*`.
   - Agent payout is calculated using `numbers.agent_rate`.
   - Client payout is calculated using `numbers.client_rate`.
   - The transaction is recorded in `sms_records` with snapshot financial fields.
   - A credit entry is inserted into `payment_ledger` for the receiving agent/client with status `'open'`.
4. Historical integrity is permanent: updating the master Rate Card tomorrow will **never** alter historical SMS financial records or ledger balances.

---

## 6. Partner Panel Sharing (Activity, HTTP, SMPP)

Located at `/panel-sharing` (`panel-sharing.html`), this portal provides B2B number allocations and multi-protocol forwarding for external partner systems.

### 6.1 Multi-Range Bulk Allocation
- Partners can select multiple ranges simultaneously from an inside-search dropdown.
- Authoritative Rate Card prices are dynamically retrieved based on the selected Billing Period (`Daily`, `Weekly`, `Monthly`).
- Confirmed allocations generate and automatically download **two separate ZIP archives**:
  1. **`Detailed Allocation Files.zip`**: Contains per-range CSV files with 3 columns:
     ```csv
     Range Name,Number,Price
     United Kingdom Galaxy NX,447100000001,0.050
     ```
  2. **`Numbers Only Files.zip`**: Contains per-range CSV files with 1 column:
     ```csv
     Number
     447100000001
     ```

### 6.2 The Three Connection Types
In `sharing_users`, partner connections are configured via `connection_type`:

#### 1. Activity Connection (`connection_type = 'activity'`)
- Standard portal view. The partner logs into the panel sharing web interface and monitors live OTPs in real time via SSE/long-polling.

#### 2. HTTP Webhook Connection (`connection_type = 'http'`)
- When an SMS is received on a shared number, the backend automatically dispatches an HTTP request to the partner's endpoint.
- Configured via JSON in `sharing_users.http_config`:
  ```json
  {
    "url": "https://partner-domain.com/webhook",
    "method": "POST",
    "auth_type": "bearer",
    "auth_token": "token_string",
    "auth_header": "X-API-Key",
    "auth_username": "username",
    "auth_password": "password",
    "auth_query": "token",
    "map": {
      "cli": "cli",
      "number": "number",
      "message": "message",
      "date": "date",
      "time": "time",
      "otp_code": "otp_code",
      "range_name": "range_name",
      "sms_id": "sms_id"
    },
    "custom_params": {
      "partner_id": "GALAXY_PARTNER_01"
    }
  }
  ```
- **Forwarding Execution:**
  - `POST` dispatches JSON payload with configurable variable mapping.
  - `GET` appends mapped parameters to the query string.
  - Execution outcome is logged to `sharing_forward_logs`.

#### 3. SMPP Connection (`connection_type = 'smpp'`)
- Inbound SMS messages are queued into SMPP outbox via `smppService.queueOutbound(connectionId, number, message, cli)`.
- The partner system connects as an ESME receiver and receives `deliver_sm` PDUs in standard telecom format.

---

## 7. Reporting, Analytics & CDR Engines

### 7.1 Report Types
1. **SMS Reports:** Aggregated volume and delivery metrics grouped by Date, Range, or Provider.
2. **SMS Detailed Reports:** Filterable message logs displaying exact timestamp, CLI, MSISDN, OTP, and status.
3. **Detailed CDR (Call Detail Record):** Carrier-level telecom audit report containing ingress timestamps, routing IDs, provider names, latency, and full financial ledger data.

### 7.2 Backend-Enforced AND-Combined Filtering
All reporting queries enforce multiple simultaneous filters combined via SQL `AND`:
- **Date Range:** `date_from` and `date_to` (formatted as `YYYY-MM-DD HH:MM:SS`).
- **Number & CLI Search:** Substring match on `number LIKE ?` or `cli LIKE ?`.
- **Range Filter:** `range_id = ?`.
- **Organizational Filters:** `manager_id = ?`, `agent_id = ?`, `client_id = ?`.
- **Provider Filter:** `provider_id = ?`.

### 7.3 Asynchronous Background CSV Exports
For high-volume export requests ($> 10{,}000$ rows):
- The API dispatches a background Node.js worker thread (`backend/server.js` using `worker_threads`).
- The worker queries the database in streamed chunks and writes directly to an export file in `EXPORT_DIR`.
- The main event loop remains 100% free to process real-time SMS ingestion.
- The UI polls `GET /api/exports/:jobId` and initiates file download when complete.

---

## 8. Reusable Inside-Search Dropdown Engine (`renderSearchSelect`)

All dropdown filters across the platform use the standardized custom dropdown component defined in `assets/galaxy.js`.

### 8.1 Visual & Structural Specification
- **Search Placement:** The search input is located strictly **INSIDE** the opened dropdown container at the very top. It is never rendered outside or above the closed dropdown.
- **Structure:**
  ```html
  <div class="searchable-dropdown" id="dd_wrap_{id}">
    <div class="sd-trigger" onclick="toggleSearchDropdown(...)">
      <span class="sd-label">Selected Option</span>
      <span class="sd-caret">▾</span>
    </div>
    <div class="sd-menu" style="display:none">
      <div class="sd-search-box" onclick="event.stopPropagation()">
        <input type="text" placeholder="Search..." oninput="filterSearchDropdown(...)">
      </div>
      <div class="sd-options">
        <div class="sd-option" data-value="1">Option 1</div>
        <div class="sd-option" data-value="2">Option 2</div>
      </div>
    </div>
    <input type="hidden" id="{id}" value="initial_value">
  </div>
  ```
- **Sorting:** All items are automatically sorted in alphabetical order (A–Z) by label.
- **Global Click-Outside Listener:** Clicking anywhere outside an active dropdown automatically closes all open `.sd-menu` elements.
- **Integrated Surfaces:**
  - `admin.html`: Numbers Range filter, Manager filter, Test Panel Range selector, SMS Reports filters, Detailed CDR filters.
  - `manager.html`: Numbers Range and Agent filters, SMS Reports filters, Detailed CDR filters.
  - `agent.html`: Numbers Range and Client filters, SMS Reports filters, Detailed CDR filters.
  - `client.html`: Numbers Range filter, Detailed Report Range filter, SMS Test Panel Range selector.
  - `panel-sharing.html`: Numbers Range filter, Billing Period selector, Multi-Range Bulk Allocation Range selector.
  - `test.html`: Test Panel Range selector and number lookup.

---

## 9. Cryptographic Security & Account PIN Architecture

### 9.1 Authentication & Session Management
- **Password Hashing:** User passwords and security PINs are hashed using `bcryptjs` with a cost factor of 10 (`bcrypt.hashSync(password, 10)`).
- **JWT Authorization:** Panel sessions use JSON Web Tokens signed with `JWT_SECRET`. Tokens expire after 24 hours and contain `{ id, username, role }`.

### 9.2 Agent Payment Security PIN
To prevent payout theft if an agent session is left open or compromised:
1. **Credentials Isolation:** Salted bcrypt hashes for security PINs are stored in `chat_credentials` (`chat_password_hash`).
2. **Payment Gating:** Endpoints under `/api/payment-v2/agent/*` enforce the `requireAgentChatUnlock` middleware.
3. **Session Unlock Token:**
   - To unlock the payment section, the agent enters their PIN via `POST /api/chat/auth/verify-lock`.
   - On success, the server issues a dedicated 12-hour unlock token (`type: 'account_pin_unlocked'`).
   - The frontend transmits this token via the `x-pin-unlock-token` or `x-chat-unlock-token` header.
4. **Brute-Force Rate Limiting:** 5 consecutive incorrect PIN entries trigger an automatic 15-minute freeze (`locked_until`).
5. **Binance UID Immutability:** Once an agent saves their 8–12 digit Binance UID, it is locked in `agent_wallets`. Subsequent modifications require Admin authorization.

---

## 10. Database Architecture & Verified Schema

The database is an optimized SQLite 3 database located at `backend/data.sqlite`.

### 10.1 Active Core Tables
- **`users`:** `(id, username, password, role, name, email, whatsapp, contact, skype, parent_id, active, created_at)`
- **`ranges`:** `(id, name, country, operator, provider_rate_daily, provider_rate_weekly, provider_rate_monthly, rate_daily, rate_weekly, rate_monthly, is_active, ...)`
- **`numbers`:** `(id, number, range_id, manager_id, agent_id, client_id, manager_rate, agent_rate, client_rate, payout, rate, status, ...)`
- **`sms_records`:** `(id, number, cli, message, otp_code, received_at, range_id, manager_id, agent_id, client_id, provider_id, manager_rate, agent_rate, client_rate, payout_amount, ...)`
- **`payment_ledger`:** `(id, agent_id, manager_id, sms_record_id, amount, payment_type, status, created_at)`
- **`payment_requests_v2`:** `(id, agent_id, manager_id, payment_type, amount, binance_uid, status, processed_by, ...)`
- **`agent_wallets`:** `(agent_id, binance_uid, network, updated_at)`
- **`chat_credentials`:** `(user_id, chat_password_hash, chat_enabled, failed_attempts, locked_until, ...)`
- **`complaints` & `complaint_replies`:** Support ticketing system.
- **`sharing_users` & `sharing_forward_logs`:** Panel sharing partner credentials and HTTP forwarding logs.
- **`smpp_connections` & `smpp_seen`:** SMPP client and server connection configurations and inbound deduplication ledger.

### 10.2 Mandatory Indexes
Covering indexes ensure sub-millisecond lookups and prevent main-thread event loop freezes:
- `idx_numbers_range_status ON numbers(range_id, status)`
- `idx_numbers_hierarchy ON numbers(manager_id, agent_id, client_id)`
- `idx_sms_records_number_time ON sms_records(number, received_at)`
- `idx_sms_records_hierarchy ON sms_records(manager_id, agent_id, client_id)`
- `idx_ledger_agent_status ON payment_ledger(agent_id, status)`

---

## 11. Authoritative REST API Route Catalog

All routes are prefixed with `/api`. Unauthenticated routes are explicitly noted.

### 11.1 Authentication & Profile
- `POST /api/login` — Public. Validates credentials, returns JWT session token and role.
- `GET /api/me` — Authenticated. Returns current user profile.
- `POST /api/logout` — Authenticated. Destroys session.

### 11.2 Numbers & Allocations
- `GET /api/numbers` — Authenticated (Admin/Manager/Agent/Client). Returns paginated numbers scoped by user role.
- `POST /api/numbers/allocate` — Authenticated (Admin/Manager). Allocates specific numbers to downstream users.
- `POST /api/numbers/unallocate` — Authenticated (Admin/Manager/Agent). Reclaims numbers back to user pool.
- `POST /api/numbers/reassign` — Authenticated (Agent). Direct one-step number transfer between clients.
- `POST /api/numbers/smart-divide` — Authenticated (Admin/Manager). Bulk allocates $N$ unallocated numbers.

### 11.3 Account Security PIN & Payments
- `GET /api/chat/auth/lock-status` — Authenticated. Returns `{ locked, unlocked }` status.
- `POST /api/chat/auth/verify-lock` — Authenticated. Validates Account Security PIN, returns 12-hour unlock token.
- `GET /api/payment-v2/agent/summary` — Agent (Requires PIN unlock). Returns balance summary.
- `GET /api/payment-v2/agent/wallet` — Agent (Requires PIN unlock). Returns saved Binance UID.
- `PUT /api/payment-v2/agent/wallet` — Agent (Requires PIN unlock). Saves Binance UID (locked after initial save).
- `POST /api/payment-v2/agent/request` — Agent (Requires PIN unlock). Submits withdrawal request.

### 11.4 Partner Panel Sharing
- `GET /api/panel-sharing/numbers` — Authenticated. Scoped number inventory for partner panel.
- `POST /api/panel-sharing/allocate` — Authenticated. Assigns range with downstream price override.
- `POST /api/panel-sharing/bulk-allocate` — Authenticated. Multi-range bulk allocation with Rate Card resolution.

### 11.5 Carrier Ingest & Health
- `POST /api/incoming-sms` — Public Carrier Ingest. Ingests incoming SMS (JSON, form-urlencoded, multipart).
- `GET /api/health` — Public. Returns `{ status: "ok", uptime: ... }`. Must respond in $< 15\text{ ms}$.

---

## 12. GitHub to VPS Deployment Workflow

The intended development and operational release cycle:

```
[Local Work / Staging]
        │
        ▼ 1. Implement & run automated test suites
        │    (node tests/verify-galaxy-cleanup-and-security.js, etc.)
        │
        ▼ 2. Commit verified changes to git
        │    (git add . && git commit -m "...")
        │
        ▼ 3. Push to GitHub repository (origin main)
        │    (git push origin main)
        │
─────────────────────────────────────────────────────────────
[Production VPS]
        │
        ▼ 4. SSH into VPS and navigate to application directory
        │    (cd /opt/galaxy-sms)
        │
        ▼ 5. Pull latest code from GitHub
        │    (git pull --ff-only origin main)
        │
        ▼ 6. Install production dependencies (if package.json changed)
        │    (npm install --production)
        │
        ▼ 7. Gracefully reload application via PM2
        │    (pm2 restart galaxy-sms --update-env)
        │
        ▼ 8. Verify service health and check production logs
             (curl http://127.0.0.1:4000/api/health && pm2 logs galaxy-sms --lines 50)
```

---

## 13. Clean VPS Zero-to-End Installation & Setup Guide

This guide walks a future engineer through deploying a completely fresh, empty Linux VPS (Ubuntu 22.04 / 24.04 LTS or Debian 12) to a fully operating Galaxy SMS production environment.

### Step 1: Base Server Update
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential ufw software-properties-common
```

### Step 2: Install Node.js LTS (v20.x)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # Must verify v20.x
npm -v
```

### Step 3: Install PM2 Process Manager Globally
```bash
sudo npm install -g pm2
```

### Step 4: Clone the Galaxy SMS Repository
```bash
sudo mkdir -p /opt/galaxy-sms
sudo chown -R $USER:$USER /opt/galaxy-sms
git clone <GITHUB_REPOSITORY_URL> /opt/galaxy-sms
cd /opt/galaxy-sms
```

### Step 5: Install Production Dependencies
```bash
npm install --production
```

### Step 6: Configure Environment Variables
```bash
cp .env.example .env
nano .env
```
Ensure you configure:
- `PORT=4000`
- `JWT_SECRET=<STRONG_64_CHAR_HEX_STRING>`
- `DB_FILE=backend/data.sqlite`
- `BACKUP_DIR=/var/backups/galaxy-sms`
- `CARRIER_LOCK_PASSWORD=<SECURE_CARRIER_UNLOCK_PASSWORD>`

### Step 7: Create Storage & Backup Directories
```bash
mkdir -p backend logs /var/backups/galaxy-sms
chmod 700 /var/backups/galaxy-sms
```

### Step 8: Initialize Database Schema
```bash
node -e "require('./backend/db').init('./backend/data.sqlite'); require('./backend/schema').createTables();"
```

### Step 9: Configure Firewall (UFW)
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 2775/tcp   # SMPP Protocol Port (if external carrier binds are enabled)
sudo ufw enable
```

### Step 10: Configure Nginx as Reverse Proxy with SSL
Install Nginx and Certbot:
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```
Create `/etc/nginx/sites-available/galaxy-sms`:
```nginx
server {
    server_name sms.yourdomain.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 90s;
    }
}
```
Enable site and obtain SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/galaxy-sms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sms.yourdomain.com
```

### Step 11: Start Application via PM2
```bash
cd /opt/galaxy-sms
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # Follow the printed command to configure automatic system boot
```

### Step 12: Verify Deployment Health
```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done
```
*Expected response: `< 0.015s` latency per probe.*

---

## 14. Operational Tooling & Utility Scripts

All scripts reside in `scripts/` or `tests/`:

| Script Name | Location | Purpose | Execution Safety |
|---|---|---|---|
| `verify-galaxy-cleanup-and-security.js` | `tests/` | Comprehensive test verifying schema cleanliness, PIN security, complaints ticketing, and dropdown consistency. | **Read-Only / Safe** (Uses temporary SQLite DB in `/tmp`). |
| `verify-sections-31-to-55.js` | `tests/` | Verifies Panel Sharing bulk allocations, Rate Card price resolution, and dual ZIP generation. | **Safe** |
| `verify-hierarchy-rates.js` | `tests/` | 74-assertion automated test verifying financial rates and margin preservation across the 4 tiers. | **Safe** |
| `verify-all-30-points.js` | `tests/` | Core specification verification suite testing allocations, direct reassignment, clamping, and SMPP. | **Safe** |
| `bench-20m.js` | `scripts/` | Stress-testing simulation harness for multi-million record loads. | **Heavy Load** — Run only on dedicated test environments. |
| `powerx-watchdog.sh` | `scripts/` | Self-healing background watchdog script to monitor HTTP health and restart PM2 if hung. | **Production Safe** |

---

## 15. Automated Backup, Storage & Recovery Runbook

Managed by `backend/backup.js`:
- **Storage Location:** Configured via `BACKUP_DIR` (defaults to `~/nova-sms-backups` outside the project folder).
- **Execution Mechanism:** Uses SQLite `VACUUM INTO` coupled with `PRAGMA wal_checkpoint(TRUNCATE)`. This writes an atomic, non-locking, perfectly consistent snapshot directly to disk in $O(1)$ memory without allocating heap memory buffers.
- **Interval & Retention:** Runs automatically every 3 hours (`BACKUP_INTERVAL_HOURS=3`). Retains backups for 30 days (`BACKUP_RETENTION_DAYS=30`).

### 15.1 Manual Backup Command
From the Admin Panel UI (Settings $\to$ Backup) or via CLI:
```bash
node -e "const db = require('./backend/db'); db.init('./backend/data.sqlite'); const b = require('./backend/backup'); b.createBackup(db, 'manual-cli');"
```

### 15.2 Disaster Recovery / Restore Procedure
To restore a backup file (`nova-sms-backup-YYYY-MM-DDTHH-MM-SS.sqlite`):
1. Stop the PM2 process:
   ```bash
   pm2 stop galaxy-sms
   ```
2. Copy the current database to a safety copy:
   ```bash
   cp backend/data.sqlite backend/data.sqlite.bak
   ```
3. Restore from the selected snapshot:
   ```bash
   cp /var/backups/galaxy-sms/nova-sms-backup-TARGET.sqlite backend/data.sqlite
   rm -f backend/data.sqlite-wal backend/data.sqlite-shm
   ```
4. Restart PM2 and verify health:
   ```bash
   pm2 start galaxy-sms
   curl http://127.0.0.1:4000/api/health
   ```

---

## 16. Performance, Capacity Benchmarks & Scale Analysis (~30M Numbers)

> **Important Notice:** The metrics below represent previously tested and observed laboratory findings. They serve as architectural design references rather than an absolute production guarantee.

### 16.1 Storage Footprint & Data Calculation
- **Row Footprint:** Each record in `numbers` consumes $\sim 300\text{ bytes}$ including all B-Tree indexes.
- **Scale Calculation:**
  $$\text{Storage at 30,000,000 Numbers} \approx 30{,}000{,}000 \times 300\text{ bytes} \approx 8.87\text{ to }9.2\text{ GB}$$
- **V8 Heap Behavior:** The Node.js process stays stable at $\sim 150\text{--}280\text{ MB RSS}$ because all database queries use streamed pagination (`LIMIT` / `OFFSET`). Loading millions of rows into a single JavaScript array is strictly forbidden.

### 16.2 Sync Query Event Loop Blocking & Health Probe Delays
- **The Event Loop Phenomenon:** `better-sqlite3` is synchronous. If a query runs an unindexed sequential table scan across 30 million rows, it locks the Node.js event loop for $1.5\text{--}4.0\text{ seconds}$.
- **Health Check Spike:** During that window, `/api/health` probes timeout, and carrier webhooks receive HTTP 504 errors.
- **Enforced Architectural Mitigation:**
  1. Every query on `numbers` and `sms_records` **must** utilize a composite covering index.
  2. Large file exports ($> 10{,}000$ rows) must use background Node.js `worker_threads` (`startExportJob`).

---

## 17. Current Platform State

### 17.1 Active Core Features
- 4-Tier Hierarchy (Admin, Manager, Agent, Client).
- Range Management with Carrier Cost isolation.
- Range Allocation (Quantity Pool with safe clamping).
- SMS Number Allocation with Direct Reassignment.
- B2B Partner Panel Sharing with Multi-Range Bulk Allocation and dual ZIP exports (`Detailed Allocation Files.zip` & `Numbers Only Files.zip`).
- Activity, HTTP Webhook, and SMPP v3.4 Protocol forwarding.
- Real-time incoming SMS and OTP detection.
- Payout ledger with Daily, Weekly, and Monthly schedules.
- Agent Account Security PIN lock and Binance UID immutability.
- Complaints support ticketing engine.
- Reusable inside-search dropdown engine (`renderSearchSelect`).
- Automated $O(1)$ memory backups (`VACUUM INTO`).

### 17.2 Completely Removed Features
- **Panel Request:** All public panel requests, OTP emails, `backend/pubreq.js`, `public-request.html`, `set-password.html`, `panel_requests` table, and `password_setup_tokens` have been **100% removed**.
- **Previous AI Assistant:** All assistant tables (`assistant_knowledge`, `assistant_settings`), `backend/assistant.js`, and UI functions have been **100% removed**.
- **Separate Standalone Chat System:** Android APKs (`galaxy-chat-v1.apk`, `galaxy-chat-v2.apk`), `mobile-app/` source, chat conversations, channel posts, and message tables have been **100% removed**.

---

## 18. 20 Mandatory Rules for Future AI Developers

Follow these strict rules to prevent system corruption, regressions, or operational downtime:

1. **Never Guess System Behavior:** Always read the source code in `backend/` and `assets/` before making assumptions.
2. **Inspect the Real Database Schema:** Inspect `backend/schema.js` and `backend/db.js` before writing or modifying any SQL queries.
3. **Verify API Routes & Middlewares First:** Always check route handlers, authentication middlewares (`authRequired`, `requireRole`, `requireAgentChatUnlock`), and parameter parsing before editing endpoints.
4. **Preserve Shared Infrastructure:** Never delete or rewrite authentication, security PIN, session, or encryption logic when cleaning up a specific feature.
5. **No Blind Global Renames:** Do not rename internal database column names or API keys (`chat_credentials`, `client_rate`, `provider_rate_*`) simply because a customer-facing UI label changed.
6. **Protect Provider Base Rates:** Never write code that allows downstream users, allocations, or partner overrides to alter `ranges.provider_rate_*`.
7. **Maintain Inside-Search Dropdown Consistency:** All new dropdowns must use `window.renderSearchSelect(...)` with the search input placed strictly **INSIDE** the opened menu.
8. **Never Run Unindexed Queries on `numbers` or `sms_records`:** Unindexed full-table scans freeze the Node.js event loop and cause health check timeout failures.
9. **Offload Heavy File Operations:** Any export or calculation exceeding 10,000 rows must run in an asynchronous worker thread or streamed cursor.
10. **Use Atomic Transactions for Allocations:** Always wrap multi-row selection and updates inside SQLite `BEGIN IMMEDIATE ... COMMIT` blocks to eliminate race conditions.
11. **Preserve Single-Process Architecture:** Never convert the PM2 configuration to `cluster` mode; background timers, carrier sync loops, and SQLite WAL locks require a single master process.
12. **Do Not Expose Secrets:** Never commit passwords, JWT secrets, SMPP credentials, or API keys into git repositories or documentation files.
13. **Sanitize HTML and Inputs:** Use `pesc()` or DOM text nodes when rendering user-submitted text to prevent Cross-Site Scripting (XSS).
14. **Keep Backups Out-of-Process:** Always ensure backup routines utilize `VACUUM INTO` to prevent loading multi-GB database files into V8 RAM.
15. **Enforce Role-Based Query Isolation:** Managers and Agents must only query records matching their assigned IDs (`manager_id`, `agent_id`). Never rely on frontend UI to hide unauthorized records.
16. **Never Break Reassignment:** Direct number reassignment between clients must remain a seamless one-step operation without requiring manual unallocation.
17. **Clamping Over Failure:** When an allocation or unallocation request exceeds available inventory, clamp safely to available inventory rather than crashing or throwing unhandled errors.
18. **Always Test Inline Scripts:** When updating HTML files, validate all inline `<script>` blocks using Node's `vm.Script` to catch syntax errors before deployment.
19. **Run Automated Test Suites Before Delivery:** Always run `verify-galaxy-cleanup-and-security.js`, `verify-sections-31-to-55.js`, `verify-hierarchy-rates.js`, and `verify-all-30-points.js` to ensure 100% test passage.
20. **Keep Documentation Updated:** Whenever an architectural change is made, immediately update this `README.md` to ensure future engineers have an accurate source of truth.
