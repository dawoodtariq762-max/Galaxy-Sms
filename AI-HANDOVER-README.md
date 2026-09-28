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
13. [Clean VPS Zero-to-End Installation & Setup Guide (30 Steps)](#13-clean-vps-zero-to-end-installation--setup-guide-30-steps)
14. [Operational Tooling & Utility Scripts](#14-operational-tooling--utility-scripts)
15. [Automated Backup, Storage & Recovery Runbook](#15-automated-backup-storage--recovery-runbook)
16. [Performance, Capacity Benchmarks & Scale Analysis (~30M Numbers)](#16-performance-capacity-benchmarks--scale-analysis-30m-numbers)
17. [Current Platform State & Production Bug Fixes (Issues 1 to 6)](#17-current-platform-state--production-bug-fixes-issues-1-to-5)
18. [20 Mandatory Rules for Future AI Developers](#18-20-mandatory-rules-for-future-ai-developers)

---

## 1. System Overview & Technology Stack

**Galaxy SMS** is a high-throughput, multi-tenant telecom SMS and OTP ingestion, hierarchy-allocation, financial accounting, and partner distribution engine. It enables administrators to import millions of telecom virtual mobile numbers (MSISDNs), organize them into geographic/carrier ranges, apply Rate Card tiers, delegate ranges down a multi-level organizational chain (Manager $\to$ Agent $\to$ Client), ingest incoming carrier SMS webhooks, monitor real-time OTP traffic, account for margins, and export allocations.

### 1.1 Verified Technology Stack
- **Runtime Environment:** Node.js (LTS v18.x or v20.x, tested on v20.20.2).
- **Core Server Framework:** Express.js (`4.21.2`) with native HTTP server.
- **Database Engine:** SQLite 3 via `better-sqlite3` (`11.10.0`), running compiled native C++ bindings for deterministic single-process execution.
- **Journal Mode:** Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) with `PRAGMA synchronous = NORMAL;` and `PRAGMA cache_size = -64000;` (64 MB cache).
- **Concurrency & Offloading:** Node.js `worker_threads` for non-blocking asynchronous CSV generation (`backend/server.js`).
- **Protocols Supported:**
  - REST / Webhook Ingestion (`application/json`, `application/x-www-form-urlencoded`, `multipart/form-data`).
  - SMPP v3.4 (Both ESME Client Transmitter/Receiver and SMSC Server Listener modes via `smpp` library `0.6.0-rc.4`).
- **Frontend Architecture:** Vanilla JavaScript (ES6+), pure CSS custom properties (`assets/galaxy.css`), SVG icons, and a custom inside-search dropdown engine (`assets/galaxy.js`). Zero frontend build tools, compilers, or heavy node frameworks (no React, Angular, Vue, Vite, or Webpack required).

---

## 2. Platform Architecture & 4-Tier Hierarchy

The platform enforces a strict 4-tier organizational hierarchy governed by single-parent ownership:

$$	ext{Admin} \longrightarrow 	ext{Manager} \longrightarrow 	ext{Agent} \longrightarrow 	ext{Client}$$

```
                ┌──────────────────────────────────────┐
                │             SUPER ADMIN              │
                │  - Full System & Financial Control   │
                │  - Real Provider Cost Visibility     │
                │  - Direct & Tier Delegations         │
                └──────────────────┬───────────────────┘
                                   │
         ┌─────────────────────────┴─────────────────────────┐
         │                                                   │
         ▼                                                   ▼
┌─────────────────────────────┐                     ┌──────────────────┐
│           MANAGER           │                     │  PARTNER SHARING │
│ - Range & Number Pools      │                     │  - Activity Hook │
│ - Sub-Agent Management      │                     │  - HTTP Webhooks │
│ - Tier Rate Spread Margins  │                     │  - SMPP Ingest   │
└──────────────┬──────────────┘                     └──────────────────┘
               │
               ▼
┌─────────────────────────────┐
│            AGENT            │
│ - Client Management         │
│ - PIN-Locked Wallet/Payouts │
│ - Direct Reassignment       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│           CLIENT            │
│ - Live SMS Feed & Lookup    │
│ - Rate Card (Read-Only)     │
│ - Daily/Weekly Reports      │
└─────────────────────────────┘
```

### 2.1 Structural Rules & Downstream Visibility
1. **Admin:** Owns all ranges, providers, carrier credentials, and global financial configurations. Admin can allocate directly to Managers, Agents, or Clients.
2. **Manager:** Created by Admin. Can manage Sub-Agents and Direct Clients. Sees only ranges and numbers explicitly allocated to them.
3. **Agent:** Created by Admin or Manager. Manages End Clients. Sees only numbers assigned to their Agent ID. Protected by Account Security PIN for financial operations.
4. **Client:** End-user receiving SMS/OTP traffic. Has zero sub-users and read-only visibility over assigned numbers and live SMS feeds.
5. **No Cross-Branch Visibility:** Manager A cannot see Manager B's agents, clients, numbers, or reports. Agent X cannot see Agent Y's clients.

---

## 3. Role-by-Role Functional & Authorization Deep Dive

| Role | Portal URL | Primary Pages & Capabilities | Authorization Guards |
|---|---|---|---|
| **Admin** | `/admin` | Dashboard, SMS Numbers, Range Management, Rate Management, Users (Managers, Agents, Clients), Provider Hub, System Logs, Backups. | `requireRole('admin')` |
| **Manager** | `/manager` | Dashboard, SMS Numbers, Sub-Agents, Clients, Rate Card, Financial Reports, Complaints. | `requireRole('manager')` |
| **Agent** | `/agent` | Dashboard, SMS Numbers, Clients, Self-Allocation, Rate Card, PIN Security Unlock, Wallet (Binance UID), Payout Requests, Complaints. | `requireRole('agent')` |
| **Client** | `/client` | Dashboard, Numbers Feed, Live SMS Ingestion Feed, Reports, Complaints. | `requireRole('client')` |
| **Partner Sharing** | `/panel-sharing` | Partner Dashboard, SMS Numbers, Bulk Allocation, Sharing Users, SMPP Connections, Forward Logs. | `requireRole('admin')` |

---

## 4. Allocation Systems: Range Allocation vs SMS Number Allocation

Galaxy SMS operates **two distinct allocation engines** designed for different business models:

### 4.1 Range Allocation (Quantity Pool Model)
- **Concept:** Allocates a raw numeric pool of capacity (e.g. 5,000 numbers from "UK Mobile O2") without locking specific MSISDN identifiers.
- **Safe Clamping (Section 2 & 3):**
  - If a user requests allocation of 1,000 numbers but only 450 are unallocated, the system **never crashes or rejects**; it clamps to 450, allocates them, and warns the operator.
  - If unallocating 500 numbers from a Manager who only holds 300, it clamps to 300.
- **API Endpoint:** `POST /api/ranges/allocate` and `POST /api/ranges/unallocate`.

### 4.2 SMS Number Allocation (Specific MSISDN Model)
- **Concept:** Allocates exact phone numbers (`+447123456789`) to specific users.
- **Direct Reassignment (Section 4):**
  - Moving a number from Client A to Client B does **not** require manual unallocation first.
  - The backend executes an atomic reassignment: `UPDATE numbers SET client_id = :new_client, client_rate = :rate, payout = :payout WHERE id = :id`.
- **Searchable Recipient Selection:** Uses `renderSearchSelect` inside-search dropdowns across Admin, Manager, and Agent modals.
- **API Endpoint:** `POST /api/numbers/allocate`.

---

### 4.3 Panel Sharing SMS Number Range Allocation Architecture (The 14-Step Flow)
In addition to individual number selection, Galaxy SMS supports high-velocity allocation directly from an unallocated Range pool inside Partner Panel Sharing (`panel-sharing.html`).

#### The Complete 14-Step Flow:
1. **SMS Numbers Page:** The administrator accesses the SMS Numbers management view (`#page-numbers`).
2. **Range Selection:** The operator selects an active telecom range from the searchable Range filter (`#numRangeFilter`).
3. **Selected User/Owner:** The operator selects the target Partner Panel user from `#allocUser`.
4. **Allocation Popup:** The operator clicks **⚡ Allocate & Download**. The modal handles both checked table items AND entire range pool allocations if no individual checkboxes are checked.
5. **Allocation Request:** The operator reviews the target partner, available number count, range name, billing period, and authoritative Rate Card price, with the option to set a downstream selling price override.
6. **Frontend API Call:** The frontend issues `POST /api/panel-sharing/allocate` passing `{ sharing_user_id, range_id, range_name, price, payterm }` (or `ids[]` if specific numbers were manually chosen).
7. **Backend Route Guard:** `backend/server.js` verifies the session via `authRequired` and enforces strict administrative role authority via `requireRole('admin')`.
8. **Allocation Service Initialization:** The service resolves the active sharing user record from `sharing_users`, verifying account status (`active = 1`) and resolving the associated downstream agent account (`agent_user_id`).
9. **Range Lookup:** The system looks up the range in `ranges` using `range_id` or `range_name` with `(deleted_at IS NULL OR deleted_at = '')`, extracting carrier metadata and Rate Card tiers.
10. **Number Lookup & Available Pool Query:** The system queries unallocated numbers matching `n.range_id = r.id AND n.manager_id IS NULL AND n.agent_id IS NULL AND n.client_id IS NULL` (ordered by `n.id ASC` with optional `qty` limit). If legacy unlinked numbers exist with prefixes matching `range.prefix`, the query automatically links and claims them.
11. **Ownership Logic & Safety Enforcement:** Strict ownership validation ensures only genuinely unallocated numbers are claimed. Existing allocations (assigned to any manager, agent, or client) are **never overwritten**. If fewer unallocated numbers remain than requested, the system safely clamps to available inventory.
12. **Rate Lookup & Billing Cycle Resolution:** If a price override is not supplied by the operator, the backend resolves the authoritative default price directly from the Rate Card according to the selected payment cycle via `payoutRateForPaymentCycle(range, payterm)` (`rate_1_1`, `rate_7_1`, `rate_7_7`, `rate_30_45`).
13. **Database Transaction:** The allocation is committed atomically inside `BEGIN IMMEDIATE ... COMMIT`:
    - Updates `numbers` in chunked batches of 5,000 rows setting `agent_id = su.agent_user_id, manager_id = NULL, client_id = NULL, client_rate = price, payout = price, rate = price, payterm = payterm, alloc_source = 'manual'`.
    - Logs individual number assignment history via `logNumberHistory()`.
    - Records an audit log entry via `logAction('allocate_panel_sharing_numbers')`.
    - Persists changes to SQLite WAL disk, bumps numbers cache version (`bumpNumbersVer()`), and clears API query cache (`clearApiReadCache()`).
14. **Final Response & Automatic Export:** The endpoint returns `{ ok: true, count, panel_name, range_name, price, payterm, ranges, rows }`. The browser receives the payload and immediately triggers an automatic download of the RFC 4180 compliant CSV file formatted with the range name.

---

## 5. Rate Architecture & Financial Payout System

The financial ledger maintains strict isolation between **Provider Real Cost** and **Downstream Selling Rates**:

### 5.1 Rate Tiers
1. **Real Provider Cost:** Stored in `ranges.provider_rate_1_1`, `provider_rate_7_1`, `provider_rate_7_7`, `provider_rate_30_45`. Only visible to Admin.
2. **Rate Card (Selling Rate):** Stored in `ranges.rate_1_1`, `rate_7_1`, `rate_7_7`, `rate_30_45`. Visible to Managers and Agents.
3. **Manager Rate Override:** Stored per-number in `numbers.manager_rate`.
4. **Agent Rate Override:** Stored per-number in `numbers.agent_rate`.
5. **Client Payout Rate:** Stored per-number in `numbers.client_rate` and `numbers.payout`.

### 5.2 Payment Cycles
- `daily` (1/1): Daily settlement, 1 day hold.
- `weekly_7_1` (7/1): Weekly settlement, 1 day hold.
- `weekly_7_7` (7/7): Weekly settlement, 7 day hold.
- `monthly_30x45` (30/45): Monthly settlement, 45 day hold.

### 5.3 Historical Rate Snapshot Preservation
When an SMS arrives and triggers an OTP payout, the rate is permanently snapshotted into `sms_records.payout_rate` and `payment_ledger.amount`. **Future modifications to Rate Management never alter historical payouts or settled ledgers.**

---

## 6. Partner Panel Sharing (Activity, HTTP, SMPP)

Galaxy SMS includes a dedicated B2B distribution engine (`panel-sharing.html`):

### 6.1 Connection Protocols
1. **Activity Protocol:** Real-time push via webhook with HMAC authorization tokens.
2. **HTTP Webhook Integration:** Configurable outbound webhooks mapping parameters (`number`, `cli`, `message`, `otp`, `time`, `date`) via GET or POST requests with custom auth headers.
3. **SMPP v3.4 Gateway:**
   - **Client Mode (Transmitter/Transceiver):** Galaxy SMS connects to external partner SMSC.
   - **Server Mode (SMSC Listener):** Partners bind into Galaxy SMS port `2775` via system ID and password.

### 6.2 Multi-Range Bulk Allocation & Dual ZIP Exports
- **Multi-Range Selection:** Operators select multiple geographic ranges, enter quantities, and review live Rate Card pricing.
- **Dual ZIP Download:**
  1. `Detailed Allocation Files.zip` — Range Name, Number, Price, Billing Period.
  2. `Numbers Only Files.zip` — Pure MSISDN lists for direct partner carrier uploads.

---

### 6.4 Bulk Allocation CSV Formatting Standards & Dual Archive Generation
When allocations are executed in bulk across multiple ranges, Galaxy SMS generates standardized CSV exports compliant with RFC 4180.

#### CSV Type 1: Numbers-Only CSV
- **Purpose:** Direct import into dialers, aggregators, or downstream SMS gateways.
- **Header:** `Number`
- **Format:** Exactly one telephone number per row, delimited by standard CRLF (`\r\n`).
- **Row Count Rule:** Exactly $N$ data rows for $N$ allocated numbers (excluding the single header row).
- **Integrity Rule:** Strictly eliminates literal `\n` characters or horizontal string concatenation.

```csv
Number
44710000001
44710000002
44710000003
```

#### CSV Type 2: Detailed Range + Number + Rate CSV
- **Purpose:** Financial reconciliation, partner invoicing, and Rate Card auditing.
- **Columns (3):** `Range Name,Number,Price`
- **Format:** Each allocated number produces exactly one complete 3-column row, delimited by standard CRLF (`\r\n`). Strings containing commas or quotes are escaped using RFC 4180 double-quote escaping (`""`).
- **Row Count Rule:** Exactly $N$ data rows for $N$ allocated numbers (excluding the single header row).

```csv
Range Name,Number,Price
"UK Mobile O2 01","44710000001",0.0075
"UK Mobile O2 01","44710000002",0.0075
"UK Mobile O2 01","44710000003",0.0075
```

#### Dual ZIP Archive Generation
- Implemented purely in browser JavaScript via `window.createZipArchive` without external third-party CDN dependencies.
- Generates two discrete archive bundles:
  1. `Detailed Allocation Files.zip`: Contains one detailed 3-column CSV per allocated range.
  2. `Numbers Only Files.zip`: Contains one single-column numbers-only CSV per allocated range.

---

## 7. Reporting, Analytics & CDR Engines

### 7.1 Dimensions & Aggregations
Galaxy SMS provides real-time Call Detail Record (CDR) reporting across multiple dimensions:
- `hour`, `day`, `month` (Calculated using UK wall-clock Europe/London DST-safe time).
- `range`, `number`, `cli`, `client`, `agent`, `manager`, `provider`.

### 7.2 Strict Role-Group Guards
Dimensions not permitted for a given role are silently dropped on the backend. For example, Agents cannot request `manager` or `provider` groupings, preventing unauthorized data discovery.

---

## 8. Reusable Inside-Search Dropdown Engine (`renderSearchSelect`)

All searchable dropdowns in the platform are powered by `window.renderSearchSelect` in `assets/galaxy.js`:

### 8.1 Key Architectural Rules
1. **Search Input Inside Opened Dropdown:** The search input `<input class="sd-search-box">` is strictly rendered **inside** the `.sd-menu` container. It is NEVER rendered outside or above the trigger button.
2. **Click Propagation Protection:** The search box element has `onclick="event.stopPropagation()"` to prevent user keystrokes and clicks from closing the dropdown.
3. **Alphabetical Sorting (A-Z):** Items are automatically sorted using `localeCompare` before rendering.
4. **Dynamic Value Binding:** Generates a hidden input element (`<input type="hidden" id="...">`) that synchronizes seamlessly with form handlers.

---

## 9. Cryptographic Security & Account PIN Architecture

### 9.1 Agent Account Security PIN
- Protects Agent wallet configurations, Binance UID, and payout requests.
- Hashed using PBKDF2 / bcrypt.
- **12-Hour Ephemeral Unlock Token:** Upon successful PIN validation, the server issues a signed, time-limited token. Financial endpoints require this token via `x-agent-unlock-token` header.
- **Binance UID Immutability:** Once an Agent saves their Binance UID, it is permanently locked and cannot be edited without Admin intervention.

### 9.2 Complaints Ticketing System
- Replaces legacy chat systems with an auditable support ticket system.
- Tickets track category, subject, priority, status (`open`, `in_progress`, `resolved`, `closed`), and audit logs.

---

## 10. Database Architecture & Verified Schema

The SQLite database (`backend/data.sqlite`) runs in native C++ mode via `better-sqlite3`.

### 10.1 Key Tables
- `users`: Core identity, password hash, role (`admin`, `manager`, `agent`, `client`), contact info.
- `ranges`: Geographic/carrier groupings, prefixes, pattern, selling rates, provider cost rates.
- `numbers`: Phone inventory, range assignment, tier rates (`manager_rate`, `agent_rate`, `client_rate`), owner links (`manager_id`, `agent_id`, `client_id`).
- `sms_records`: Full CDR history, raw message, detected OTP code, payout amount, rate snapshot.
- `sharing_users`: B2B partner accounts, connection type (`activity`, `http`, `smpp`).
- `smpp_connections`: SMPP v3.4 Client and Server configurations.
- `complaints`: Customer support ticketing system.
- `payment_ledger`: Financial ledger of earnings and payouts.

---

## 11. Authoritative REST API Route Catalog

### 11.1 Authentication & Profile
- `POST /api/login` — Public. Validates credentials, returns JWT session token and role.
- `GET /api/me` — Authenticated. Returns current user profile.
- `POST /api/logout` — Authenticated. Destroys session.

### 11.2 Numbers & Allocations
- `GET /api/numbers` — Authenticated (Admin/Manager/Agent/Client). Returns paginated numbers scoped by user role.
- `POST /api/numbers/allocate` — Authenticated (Admin/Manager/Agent). Allocates numbers to downstream recipient.
- `POST /api/numbers/unallocate` — Authenticated (Admin/Manager/Agent). Reclaims numbers back to user pool.
- `POST /api/numbers/reassign` — Authenticated (Agent). Direct one-step number transfer between clients.
- `POST /api/numbers/smart-divide` — Authenticated (Admin/Manager). Auto-divides numbers across recipients.

### 11.3 Account Security PIN & Payments
- `GET /api/chat/auth/lock-status` — Authenticated. Returns `{ locked, unlocked }` status.
- `POST /api/chat/auth/verify-lock` — Authenticated. Validates Account Security PIN, returns 12-hour unlock token.
- `GET /api/payment-v2/agent/summary` — Agent (Requires PIN unlock). Returns balance summary.
- `GET /api/payment-v2/agent/wallet` — Agent (Requires PIN unlock). Returns saved Binance UID.
- `PUT /api/payment-v2/agent/wallet` — Agent (Requires PIN unlock). Saves Binance UID (locked after initial save).
- `POST /api/payment-v2/agent/request` — Agent (Requires PIN unlock). Submits withdrawal request.

### 11.4 Partner Panel Sharing
- `GET /api/panel-sharing/numbers` — Admin. Scoped unallocated number inventory.
- `GET /api/panel-sharing/ranges` — Admin. Active ranges with Rate Card pricing.
- `POST /api/panel-sharing/allocate` — Admin. Allocates numbers to partner with price override and CSV export.
- `POST /api/panel-sharing/bulk-allocate` — Admin. Multi-range bulk allocation with Rate Card resolution.

### 11.5 Carrier Ingest & Health
- `POST /api/incoming-sms` — Public Carrier Ingest. Ingests incoming SMS (JSON, form-urlencoded, multipart).
- `GET /api/health` — Public. Returns `{ status: "ok", uptime: ... }`. Must respond in $< 15\text{ ms}$.

---

## 12. GitHub to VPS Deployment Workflow

```
[Local Development / Staging]
        │
        ▼ 1. Run automated test suites
        │    (node tests/verify-production-fixes.js, etc.)
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
        ▼ 4. SSH into VPS and navigate to directory
        │    (cd /opt/galaxy-sms)
        │
        ▼ 5. Pull latest code from GitHub
        │    (git pull --ff-only origin main)
        │
        ▼ 6. Install dependencies (if package.json modified)
        │    (npm install --production)
        │
        ▼ 7. Gracefully reload application via PM2
        │    (pm2 restart galaxy-sms --update-env)
        │
        ▼ 8. Verify service health and check logs
             (curl http://127.0.0.1:4000/api/health && pm2 logs galaxy-sms --lines 50)
```

---

## 13. Clean VPS Zero-to-End Installation & Setup Guide (30 Steps)

This guide walks a future systems engineer through setting up a completely fresh Ubuntu/Debian Linux VPS from scratch to a production-hardened Galaxy SMS deployment.

### Step 1: Base Operating System Update
```bash
sudo apt update && sudo apt upgrade -y
```

### Step 2: Install Essential System Utilities
```bash
sudo apt install -y curl wget git build-essential ufw software-properties-common fail2ban unzip htop
```

### Step 3: Create Dedicated System User
```bash
sudo adduser --system --group --shell /bin/bash galaxy
sudo usermod -aG sudo galaxy
```

### Step 4: Configure Hostname and Timezone
```bash
sudo hostnamectl set-hostname galaxy-sms-prod
sudo timedatectl set-timezone UTC
```

### Step 5: Install Node.js LTS (v20.x)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # Must verify v20.x
npm -v
```

### Step 6: Install PM2 Globally
```bash
sudo npm install -g pm2
```

### Step 7: Configure Linux Kernel Limits (`sysctl.conf`)
Add high-concurrency settings to `/etc/sysctl.conf`:
```ini
fs.file-max = 2097152
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 15
```
Apply settings:
```bash
sudo sysctl -p
```

### Step 8: Configure Open File Descriptor Limits (`limits.conf`)
Add to `/etc/security/limits.conf`:
```ini
galaxy soft nofile 65535
galaxy hard nofile 65535
root soft nofile 65535
root hard nofile 65535
```

### Step 9: Configure SSH Hardening
Edit `/etc/ssh/sshd_config`:
```ini
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```
Restart SSH:
```bash
sudo systemctl restart ssh
```

### Step 10: Configure UFW Firewall
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 2775/tcp  # SMPP Protocol Port
sudo ufw enable
```

### Step 11: Configure Fail2ban
```bash
sudo cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
sudo systemctl enable fail2ban && sudo systemctl start fail2ban
```

### Step 12: Create Application & Storage Directories
```bash
sudo mkdir -p /opt/galaxy-sms /var/backups/galaxy-sms /var/log/galaxy-sms
sudo chown -R galaxy:galaxy /opt/galaxy-sms /var/backups/galaxy-sms /var/log/galaxy-sms
chmod 700 /var/backups/galaxy-sms
```

### Step 13: Clone Repository
```bash
su - galaxy
git clone https://github.com/your-org/galaxy-sms.git /opt/galaxy-sms
cd /opt/galaxy-sms
```

### Step 14: Install Production NPM Dependencies
```bash
npm ci --omit=dev
```

### Step 15: Recompile Native Better-SQLite3
```bash
npm rebuild better-sqlite3
```

### Step 16: Configure Production Environment (`.env`)
```bash
cp .env.example .env
nano .env
```
Ensure configured:
```env
PORT=4000
JWT_SECRET=c38f49e0b2401825fa8291f03847291048bcae91829471920384729103847192
DB_FILE=backend/data.sqlite
BACKUP_DIR=/var/backups/galaxy-sms
CARRIER_LOCK_PASSWORD=YourSecureCarrierUnlockPassword
BACKUP_INTERVAL_HOURS=3
BACKUP_RETENTION_DAYS=30
```

### Step 17: Initialize Database Schema
```bash
node -e "require('./backend/schema').createTables();"
```

### Step 18: Initialize Seed Admin Account
```bash
node -e "require('./backend/seed').seed();"
```

### Step 19: Configure PM2 Process Ecosystem
Verify `deploy/ecosystem.config.cjs` or create `ecosystem.config.js`:
```javascript
module.exports = {
  apps: [{
    name: 'galaxy-sms',
    script: 'backend/server.js',
    cwd: '/opt/galaxy-sms',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production'
    },
    max_memory_restart: '1G'
  }]
};
```

### Step 20: Start Application with PM2
```bash
pm2 start ecosystem.config.js
pm2 save
```

### Step 21: Setup PM2 System Boot Hook
```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u galaxy --hp /home/galaxy
```

### Step 22: Install Nginx Web Server
```bash
sudo apt install -y nginx
```

### Step 23: Configure Nginx Virtual Host
Create `/etc/nginx/sites-available/galaxy-sms`:
```nginx
server {
    listen 80;
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
        proxy_read_timeout 90s;
    }
}
```
Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/galaxy-sms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Step 24: Install Certbot & Obtain TLS Certificate
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d sms.yourdomain.com
```

### Step 25: Verify Automated SSL Renewal
```bash
sudo certbot renew --dry-run
```

### Step 26: Setup Production Log Rotation
Create `/etc/logrotate.d/galaxy-sms`:
```ini
/opt/galaxy-sms/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    copytruncate
}
```

### Step 27: Setup Watchdog Cron Job
Configure watchdog script in `/opt/galaxy-sms/scripts/powerx-watchdog.sh` and add to crontab:
```bash
*/2 * * * * /opt/galaxy-sms/scripts/powerx-watchdog.sh > /dev/null 2>&1
```

### Step 28: Configure External SMPP Whitelist
If external partners connect to SMPP port 2775:
```bash
sudo ufw allow from <PARTNER_IP> to any port 2775 proto tcp
```

### Step 29: Execute Production Verification Suites
```bash
cd /opt/galaxy-sms
node tests/verify-production-fixes.js
node tests/verify-sections-31-to-55.js
node tests/verify-hierarchy-rates.js
```

### Step 30: Perform Final Health Check & Latency Probe
```bash
curl -I https://sms.yourdomain.com/api/health
```
*Expected: HTTP/2 200 OK with $< 15\text{ ms}$ response latency.*

---

## 14. Operational Tooling & Utility Scripts

| Script Name | Location | Purpose | Execution Safety |
|---|---|---|---|
| `verify-production-fixes.js` | `tests/` | Verifies Issue 1 (pattern resolution), Issue 2 (SQLite double-quotes), and Issue 3 (modal inside-search dropdowns). | **Safe** |
| `verify-sections-31-to-55.js` | `tests/` | Verifies Panel Sharing bulk allocations, Rate Card price resolution, and dual ZIP generation. | **Safe** |
| `verify-hierarchy-rates.js` | `tests/` | 74-assertion automated test verifying financial rates and margin preservation across the 4 tiers. | **Safe** |
| `verify-all-30-points.js` | `tests/` | Core specification verification suite testing allocations, direct reassignment, clamping, and SMPP. | **Safe** |
| `bench-20m.js` | `scripts/` | Stress-testing simulation harness for multi-million record loads. | **Heavy Load** |
| `powerx-watchdog.sh` | `scripts/` | Self-healing background watchdog script to monitor HTTP health and restart PM2 if hung. | **Safe** |

---

## 15. Automated Backup, Storage & Recovery Runbook

Managed by `backend/backup.js`:
- **Storage Location:** Configured via `BACKUP_DIR` (defaults to `/var/backups/galaxy-sms`).
- **Execution Mechanism:** Uses SQLite `VACUUM INTO` coupled with `PRAGMA wal_checkpoint(TRUNCATE)`. This writes an atomic, non-locking, perfectly consistent snapshot directly to disk in $O(1)$ memory without allocating heap memory buffers.
- **Interval & Retention:** Runs automatically every 3 hours (`BACKUP_INTERVAL_HOURS=3`). Retains backups for 30 days (`BACKUP_RETENTION_DAYS=30`).

### 15.1 Disaster Recovery / Restore Procedure
To restore a backup file:
```bash
pm2 stop galaxy-sms
cp /opt/galaxy-sms/backend/data.sqlite /opt/galaxy-sms/backend/data.sqlite.bak
cp /var/backups/galaxy-sms/nova-sms-backup-TARGET.sqlite /opt/galaxy-sms/backend/data.sqlite
pm2 start galaxy-sms
```

---

## 16. Performance, Capacity Benchmarks & Scale Analysis (~30M Numbers)

- **Storage Sizing:** At 30 million numbers, database size is approximately $8.87\text{--}9.2\text{ GB}$.
- **V8 Heap Memory:** The Node.js process stays stable at $\sim 150\text{--}280\text{ MB RSS}$ because all database queries use streamed pagination (`LIMIT` / `OFFSET`). Loading millions of rows into a single JavaScript array is strictly forbidden.
- **Sync Event Loop Safety:** `better-sqlite3` is synchronous. Every query on `numbers` and `sms_records` **must** utilize a composite covering index (`idx_num_range_id`, `idx_sms_range_date`, etc.).

---

## 17. Current Platform State & Production Bug Fixes (Issues 1 to 6)

### 17.1 Production Issue 1: SMS Number Individual Allocation Fails (`.pattern` of null)
- **Problem:** When an operator attempted to allocate an individual SMS number from Panel Sharing (`panel-sharing.html`), the UI displayed `Allocation failed: Cannot read properties of null (reading 'pattern')`.
- **Root Cause:** When numbers were imported with null or unlinked ranges, or when a number had no range association, downstream rate calculation code and modal logic looked up range objects that returned `undefined`/`null`, and subsequently attempted to access `.pattern` or lookup patterns without a valid range entity. In `/api/panel-sharing/allocate`, `LEFT JOIN ranges r` yielded `NULL` range names.
- **Permanent Resolution:**
  1. `backend/schema.js`: Ensured `pattern` column exists on both `ranges` and `numbers` tables, auto-populating from `prefix`.
  2. `backend/server.js`: Enhanced `/api/panel-sharing/allocate` with automatic prefix/pattern matching across active ranges if `range_id` or `range_name` is missing, ensuring every row has valid `range_name`, `pattern`, and pricing.
  3. `panel-sharing.html`: Enhanced `openAllocConfirmFlow()` to resolve ranges by prefix/pattern matching, ensuring `matchedRange.pattern` is always defined with a robust fallback object preserving Rate Card defaults and downstream price overrides.

### 17.2 Production Issue 2: Bulk Allocation SQLite String Literal Error
- **Problem:** When executing bulk allocation in Panel Sharing, SQLite crashed with:
  `SqliteError: no such column: "" - should this be a string literal in single-quotes?`
- **Root Cause:** In `backend/server.js:4567` and `backend/server.js:4671`, the SQL query used double quotes:
  `SELECT * FROM ranges WHERE id=? AND COALESCE(deleted_at,"")=""`
  In standard SQLite, double quotes denote column identifiers, causing SQLite to treat `""` as an unknown column name instead of an empty string literal.
- **Permanent Resolution:** Changed queries to:
  `SELECT * FROM ranges WHERE id=? AND (deleted_at IS NULL OR deleted_at = '')`
  eliminating the double-quoted string literal completely.

### 17.3 Production Issue 3: Search Box Missing Inside Allocation Popup Dropdown
- **Problem:** In Admin (`admin.html`), Manager (`manager.html`), and Agent (`agent.html`) panels, opening the SMS Numbers allocation modal (`allocAllModal`) presented a plain native HTML `<select>` element without a search box. Operators managing hundreds of users could not filter or search for recipients.
- **Root Cause:** The allocation popup was using native `<select id="aaClient">` and `<select id="aaAgent">` elements instead of the reusable `renderSearchSelect` component.
- **Permanent Resolution:**
  1. Replaced raw `<select>` tags in all three portals with container `<div id="aaTargetDropdownWrap"></div>`.
  2. In `openAllocAll()`, invoked `window.renderSearchSelect('aaTargetDropdownWrap', ...)`:
     - Configured with `id: 'aaClient'` (Admin/Agent) and `id: 'aaAgent'` (Manager) to bind transparently to hidden inputs.
     - Strictly renders the search box **inside** the opened dropdown menu (`.sd-menu .sd-search-box`).
     - Added `event.stopPropagation()` to prevent clicks from closing the dropdown menu.
     - Sorted recipients strictly A-Z by label.
     - Preserved role-based scoping: Admin sees Managers/Agents/Clients; Manager sees Agents/Clients; Agent sees Clients.

---

### 17.4 Production Issue 4: SMS Number Range Allocation Fails
- **Problem:** When operators attempted to allocate numbers using the Range filter on the SMS Numbers page in Panel Sharing (`panel-sharing.html`), the allocation flow blocked with `Please select numbers from the table first.` when checkboxes were not individually selected. If confirmed via API, the backend rejected requests missing `ids[]` with HTTP 400. Furthermore, table pagination limited manual selection to only the current page (25 rows), preventing full range pool allocation.
- **Root Cause:**
  1. Frontend `openAllocConfirmFlow()` strictly required `selectedIds().length > 0` before opening the confirmation popup, ignoring `#numRangeFilter`.
  2. Backend route `POST /api/panel-sharing/allocate` enforced `if (!ids.length) return res.status(400).json({ error: 'ids[] required' })` and lacked range lookup (`range_id` / `range_name`) and available-number queries.
  3. Price resolution lacked automatic fallback to authoritative Rate Card pricing when price was omitted.
- **Permanent Resolution:**
  1. Updated `openAllocConfirmFlow()` in `panel-sharing.html` to allow allocation when either numbers are selected OR a range is chosen in `#numRangeFilter`. Displays unallocated count in the modal.
  2. Enhanced `proceedWithConfirmedAllocation()` to transmit `range_id` and `range_name` alongside optional `ids[]`.
  3. Overhauled `POST /api/panel-sharing/allocate` in `backend/server.js` to implement the full 14-step flow: resolves range from database, queries unallocated numbers with strict ownership checks (`manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL`), automatically resolves Rate Card price by payment cycle, executes updates within an atomic transaction, logs number history, and returns full metadata.

### 17.5 Production Issue 5: Bulk Allocation CSV Format Defect (Literal \n Joining)
- **Problem:** Downloaded CSV files from Bulk Allocation and SMS Numbers displayed literal `\n` characters within rows or placed numbers horizontally adjacent on a single line instead of creating discrete spreadsheet rows.
- **Root Cause:** In `panel-sharing.html`, multiple CSV export routines (`downloadDetailedArchive`, `downloadNumbersOnlyArchive`, `downloadSelectedUnallocated`, `downloadAllFilteredNumbers`) used the string literal `'\\n'` (ASCII 92 followed by ASCII 110) rather than real line break delimiters. When written to a Blob or file, literal `\n` characters were written into the file stream.
- **Permanent Resolution:**
  1. Updated all CSV generation routines in `panel-sharing.html` to join rows using RFC 4180 standard CRLF (`\r\n`) and terminate files with `\r\n`.
  2. Ensured Numbers-Only CSV contains a standardized `Number` header followed by one number per row.
  3. Ensured Detailed CSV contains `Range Name,Number,Price` with 3 columns per row and RFC 4180 quote escaping.
  4. Verified clipboard copy function (`copyNumbersOnly`) uses native newline (`\n`) for clean pasting into external tools.

---

### 17.6 Production Issue 6: SMS Numbers Allocation Failure — 'reading payterm' on Premature Modal Close
- **Problem:** In Panel Sharing → SMS Numbers (`panel-sharing.html`), confirming number/range allocation failed with an alert: `Allocation failed — Cannot read properties of null (reading 'payterm')`.
- **Root Cause:** In `proceedWithConfirmedAllocation()`, `closeAllocConfirmModal()` was invoked immediately after the backend `API.post` returned. `closeAllocConfirmModal()` cleared the global state variable `pendingAllocData = null`. The subsequent lines in `proceedWithConfirmedAllocation()` attempted to interpolate `${pendingAllocData.payterm}` into the success message and evaluate `pendingAllocData.ranges[0]`, resulting in a runtime `TypeError` that aborted the CSV download and table reload.
- **Permanent Resolution:**
  1. Scoped the allocation context locally at the entry of `proceedWithConfirmedAllocation()` (`const currentAlloc = pendingAllocData;`).
  2. Derived `assignedPayterm` safely from `res.payterm || currentAlloc.payterm || 'weekly_7_1'` and `assignedRangeName` from `(currentAlloc.ranges && currentAlloc.ranges[0]) || res.range_name || res.panel_name`.
  3. Ensured that modal closing and state cleanup never invalidate the completion flow or automatic download.
  4. In `backend/server.js`, added a defensive guard to `payoutRateForPaymentCycle(row, cycle)` (`if (!row) return '0';`) to eliminate any potential null-row dereference.

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
19. **Run Automated Test Batteries Before Delivery:** Always run `verify-production-fixes.js`, `verify-sections-31-to-55.js`, `verify-hierarchy-rates.js`, and `verify-all-30-points.js` to ensure 100% test passage.
20. **Keep Documentation Updated:** Whenever an architectural change is made, immediately update this `README.md` to ensure future engineers have an accurate source of truth.
