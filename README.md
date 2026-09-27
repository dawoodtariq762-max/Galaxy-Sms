# GALAXY SMS — System Architecture, Operator Manual & Engineering Reference

> **Authoritative Technical Documentation**  
> **Target Audience:** Future AI Engineers, System Architects, and VPS DevOps Operators  
> **System Branding:** Galaxy SMS (Official)  
> **Platform Version:** 2026 Enterprise Edition  

---

## 1. System Overview & Technology Stack

**Galaxy SMS** is a high-throughput, carrier-grade SMS/OTP ingestion, management, and hierarchy-allocation platform. It routes and accounts for millions of SMS messages across multi-tiered organizations, provides dedicated partner panel sharing, and enforces cryptographic payment security.

### Core Technology Stack
- **Runtime:** Node.js (LTS v18 / v20)
- **Database Engine:** SQLite 3 via `better-sqlite3` (compiled native C++ bindings for deterministic single-process speed)
- **Database Journaling:** Write-Ahead Logging (`PRAGMA journal_mode = WAL;`)
- **Backend Framework:** Express.js with custom middleware (JWT authentication, role gating, atomic lock serialization)
- **Concurrency & Offloading:** Node.js `worker_threads` for non-blocking asynchronous CSV/data exports
- **Protocols Supported:**
  - HTTP Webhooks / REST API (Incoming SMS ingest, partner API callbacks)
  - SMPP v3.4 (Both Client Transmitter/Receiver and Server Listeners via `backend/smppService.js`)
- **Frontend Architecture:** Pure Vanilla JavaScript (ES6+), CSS custom property design system (`assets/galaxy.css`), and modular inside-search dropdowns (`assets/galaxy.js`). Zero heavy frontend framework overhead (no React, Vue, or Webpack compile steps required).

---

## 2. Platform Architecture & 4-Tier Hierarchy

The core system enforces a strict 4-tier organizational hierarchy. Each role possesses strictly scoped database visibility enforced at the query level:

```
                  ┌────────────────────────┐
                  │         ADMIN          │
                  │  Full System Authority │
                  └───────────┬────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
  ┌──────────────────┐                ┌──────────────────┐
  │     MANAGER      │                │   DIRECT AGENT   │
  │ Sub-tree Master  │                │ Under Admin      │
  └─────────┬────────┘                └─────────┬────────┘
            │                                   │
      ┌─────┴─────┐                             │
      ▼           ▼                             ▼
┌───────────┐ ┌───────────┐               ┌───────────┐
│SUB-AGENT 1│ │SUB-AGENT 2│               │  CLIENT   │
└─────┬─────┘ └─────┬─────┘               └───────────┘
      │             │
      ▼             ▼
┌───────────┐ ┌───────────┐
│  CLIENT   │ │  CLIENT   │
└───────────┘ └───────────┘
```

### Role Capabilities & Gating
1. **Admin (`admin.html`):**
   - Full system administration: Users, Numbers, Range Management, System Rate Cards, Daily/Weekly/Monthly Payment Schedules, Activity Logs, and System Backups.
   - Manages **Agent Account PINs** (formerly Chat Accounts) to safeguard agent payout destinations.
   - Configures carrier HTTP integrations and SMPP listeners.
2. **Manager (`manager.html`):**
   - Manages an isolated sub-tree of Agents and Clients.
   - Receives range allocations from Admin; delegates numbers down to sub-agents or directly to clients.
   - Views SMS traffic and financial margins strictly restricted to owned sub-agents and clients.
3. **Agent (`agent.html`):**
   - Direct distributor to end Clients.
   - Performs direct number reassignment between clients.
   - Manages withdrawal requests with mandatory **Account Security PIN** protection.
4. **Client (`client.html`):**
   - End-user OTP testing and live SMS monitoring.
   - Real-time tabular feed of incoming SMS messages and OTP codes on assigned numbers.
5. **Panel Sharing (`panel-sharing.html`):**
   - Dedicated B2B Number Sharing Portal for external partners.
   - Multi-Range Bulk Allocation with authoritative Rate Card resolution.
   - Dual ZIP Archive generation: `Detailed Allocation Files.zip` (3 columns) and `Numbers Only Files.zip` (1 column).
   - Supports 3 connection modes: **Activity Ingest**, **HTTP Webhook**, and **SMPP Connection**.

---

## 3. High-Capacity Benchmarks & Scale Analysis (~30M Numbers)

The Galaxy SMS database engine is designed to scale up to **30,000,000+ numbers** and sustained loads of **70+ SMS/sec**. The following findings, measurements, and architectural safeguards must be understood by any engineer working on this repository:

### 3.1 Data Footprint & Storage Calculation
- **Row Footprint:** Each number record in the `numbers` table consumes approximately **300 bytes** (including indexed B-Tree overhead for `number`, `range_id`, `manager_id`, `agent_id`, `client_id`, and `created_at`).
- **Database Size at Scale:**
  $$\text{Database File Size} \approx 30{,}000{,}000 \times 300\text{ bytes} \approx 8.87\text{ to }9.2\text{ GB}$$
- **Filesystem Placement:** Always store the database (`data.sqlite`) and backups on high-speed NVMe or SSD storage. Never place the active database on a `tmpfs` (RAM-disk) or network-mounted NFS share due to risk of Out-Of-Memory (OOM) or corrupted file locking.

### 3.2 RAM Behavior & V8 Heap Limits
- **Node.js Heap Isolation:** The Node.js V8 engine has a default memory limit (~2 GB to 4 GB). If a query attempts to load millions of rows into a single JavaScript array (e.g. `const rows = db.all('SELECT * FROM numbers')`), the process will instantly crash with:
  ```txt
  FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
  ```
- **Pagination & Cursors:** All number and SMS queries are strictly paginated using indexed `LIMIT` and `OFFSET` or key-based cursor queries (`WHERE id > ? LIMIT 500`).
- **Memory Footprint:** With proper indexing and pagination, the Node.js memory footprint remains remarkably low and stable: **~120 MB to 280 MB RSS**, even when operating over an 8.87 GB database.

### 3.3 SQLite WAL (Write-Ahead Log) Operation
- The database operates in WAL mode (`PRAGMA journal_mode = WAL;` and `PRAGMA synchronous = NORMAL;`).
- **Concurrent Readers & Single Writer:** WAL allows multiple simultaneous readers without blocking the single writer thread.
- **Checkpoint Starvation Warning:** If a long-running read query (e.g., a massive sequential scan or unindexed query) remains active, SQLite cannot checkpoint the WAL file back into `data.sqlite`. This can cause the WAL file (`data.sqlite-wal`) to swell to several gigabytes.
- **Mitigation:**
  - Database checkpoints are automatically executed (`PRAGMA wal_autocheckpoint = 1000;`).
  - Heavy exports are offloaded to isolated worker threads or run during non-peak windows.

### 3.4 Sync Query Event Loop Blocking & Health Check Delays
- **CRITICAL ARCHITECTURAL WARNING:** `better-sqlite3` runs synchronously on Node.js's main event loop thread. While this provides raw query execution speeds of sub-millisecond per indexed query, **any unindexed sequential table scan will completely freeze the Node.js event loop**.
- **The Health Check Delay Phenomenon:**
  - When an unindexed query scans 30 million rows, the CPU is locked for 1.5 to 4.0 seconds.
  - During those 4 seconds, Node.js cannot process any other incoming HTTP request.
  - As a result, the VPS health probe (`GET /api/health`) or monitoring daemon (PM2/Nginx) will register a timeout or delay (`health 3.82s`). External SMS providers attempting webhook deliveries may receive HTTP 504 Gateway Timeouts or 429 rate limit errors.
- **Enforced Mitigation Rules:**
  1. **Mandatory Covering Indexes:** Never run a query on `numbers` or `sms_records` without a supporting composite index.
  2. **No Full Table Scans in API Requests:** Filter queries must include `range_id`, `manager_id`, `agent_id`, or `client_id`.
  3. **Offloaded CSV Exports:** All large bulk exports use Node.js `worker_threads` (`startExportJob` in `backend/server.js`) to ensure the main event loop never freezes.

---

## 4. Security & Cryptographic Protection

### 4.1 Payment Security PIN Mechanism
To protect agent funds from session hijacking, unauthorized withdrawals, or modified payout addresses:
- **PIN Isolation:** Agents have a dedicated **Account Security PIN** stored as a salted bcrypt hash in `chat_credentials`.
- **Unlock Session Token:**
  - Accessing payment information, updating Binance UIDs, or requesting withdrawals requires a temporary JWT unlock token (`chat_unlocked` / `account_pin_unlocked`).
  - Supported request headers: `x-pin-unlock-token` or `x-chat-unlock-token`.
- **Brute-Force Lockout:** 5 consecutive failed PIN attempts trigger an automatic 15-minute freeze on the user's PIN verification.
- **Fail-Safe Gate:** All endpoints under `/api/payment-v2/agent/*` enforce `requireAgentChatUnlock`. If an agent has not unlocked their PIN session, the server rejects requests with HTTP 403.
- **Binance UID Immutability:** Once an agent enters their Binance UID, it is permanently locked in `agent_wallets`. Subsequent updates require administrative authorization.

### 4.2 Downstream Price Preservation & Provider Rate Protection
- When allocating numbers through Admin, Manager, Agent, or Panel Sharing, the system enforces a strict separation between **Upstream Provider Cost** and **Downstream Selling Price**:
  - `ranges.provider_rate_daily`, `ranges.provider_rate_weekly`, `ranges.provider_rate_monthly`: Protected base cost paid to the telecom carrier. Downstream users or allocations can NEVER alter or overwrite these columns.
  - `numbers.client_rate`, `numbers.payout`, `numbers.rate`: The downstream price assigned to the client/partner.
- When an override is specified during allocation, the system updates `numbers.client_rate` and `numbers.payout` without touching historical transactions or upstream carrier rates.

---

## 5. UI Architecture & Consistency

### 5.1 Inside-Search Dropdown Engine (`renderSearchSelect`)
To maintain consistent UX and avoid standard HTML `<select>` limitations, all dropdowns across the platform utilize the custom inside-search dropdown engine defined in `assets/galaxy.js`:
- **Search Placement:** The search input is located strictly **INSIDE** the opened dropdown menu at the top.
- **Alphabetical Sorting:** Items are automatically sorted A-Z by display label.
- **Global Click-Outside Listener:** Clicking anywhere outside an open dropdown automatically closes it.
- **Integrated Portals:**
  - `admin.html`: SMS Numbers Range filter, Manager filter, Test Panel Range selector, SMS Reports Range/Manager/Agent/Client filters, CDR Reports filters.
  - `manager.html`: SMS Numbers Range and Agent filters, SMS Reports Range filter, Detailed CDR filters.
  - `agent.html`: SMS Numbers Range and Client filters, SMS Reports filters, Detailed CDR filters.
  - `client.html`: SMS Numbers Range filter, Detailed Report Range filter, SMS Test Panel Range selector.
  - `panel-sharing.html`: SMS Numbers Range filter, Billing Period selector, Multi-Range Bulk Allocation Range selector.
  - `test.html`: SMS Test Panel Range selector and number lookup.

### 5.2 Complaints Support Ticketing
The standalone chat app has been decommissioned. Customer support is unified under a streamlined **Complaints Ticketing Engine**:
- Ticket creation with subject and description (`POST /api/complaints`).
- Admin reply and status workflow (`Open`, `In Progress`, `Resolved`, `Closed`).
- Real-time unread complaints badge counter on user topbars.

---

## 6. Directory Structure

```txt
Galaxy-Sms/
├── admin.html                    <- Admin Portal
├── manager.html                  <- Manager Portal
├── agent.html                    <- Agent Portal
├── client.html                   <- Client Portal
├── panel-sharing.html            <- B2B Partner Panel Sharing Portal
├── test.html                     <- Public / Internal SMS Test Panel
├── login.html                    <- Unified Login Portal (redirects from /panel-login)
├── api.js                        <- Frontend API Client & Session Guard
├── assets/
│   ├── galaxy.css                <- Main Galaxy Dark Theme Stylesheet
│   ├── galaxy-light.css          <- Galaxy Light Theme Stylesheet
│   ├── galaxy.js                 <- Core UI Utilities, renderSearchSelect & Pure JS ZIP Builder
│   ├── chat.js                   <- Complaints Ticketing Engine & PIN Unlock Modals
│   ├── galaxy-logo.png           <- Master Galaxy SMS Branding Logo
│   └── galaxy-favicon.png        <- Official Favicon
├── backend/
│   ├── server.js                 <- Primary Express Application & Route Controller
│   ├── db.js                     <- better-sqlite3 Database Connection & WAL Config
│   ├── schema.js                 <- Authoritative Database Tables & Indexes
│   ├── chat.js                   <- Account Security PIN Endpoints & Complaints Ticketing
│   ├── smppService.js            <- SMPP Client & Server Runtime Engine
│   ├── providerSync.js           <- Background Telecom Carrier Synchronization
│   └── pubreq.js                 <- Public Account Requests & Onboarding Mailer
├── tests/
│   ├── verify-galaxy-cleanup-and-security.js <- Full Modern Regression Suite
│   ├── verify-sections-31-to-55.js          <- Panel Sharing & Allocation Test Suite
│   ├── verify-all-30-points.js              <- Core 30-Point Specification Suite
│   └── verify-hierarchy-rates.js            <- 74-Point Multi-Tier Rate Verification
├── scripts/
│   ├── bench-20m.js              <- High-Scale 20M Benchmark Simulation Harness
│   └── powerx-watchdog.sh        <- Background Service Watchdog Script
├── ecosystem.config.js           <- PM2 Production Configuration
└── package.json                  <- Node.js Dependencies & Configuration
```

---

## 7. Operational Runbook & Production Deployment

### 7.1 Production Environment Requirements
- **OS:** Ubuntu 22.04 / 24.04 LTS or Debian 12
- **Node.js:** v20.x LTS
- **Process Manager:** PM2 (`npm install -g pm2`)
- **Web Server:** Nginx (Reverse proxy with SSL termination)
- **Disk:** Minimum 40 GB NVMe SSD for high-volume logs and database storage.

### 7.2 Installation & Startup
```bash
# Clone or extract repository
cd /home/user/Galaxy-Sms

# Install production dependencies
npm install --production

# Initialize database tables and indexes
node -e "require('./backend/db').init('./backend/data.sqlite'); require('./backend/schema').createTables();"

# Start application via PM2
pm2 start ecosystem.config.js --name "galaxy-sms"
pm2 save
```

### 7.3 Health Check Verification
To verify that the service is operational without event-loop delay:
```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done
```
*Expected latency: `< 0.015s` per request.*

### 7.4 Running Automated Verification Suites
Before deploying any configuration or code change, run the verified automated test suites:
```bash
# 1. Galaxy Modern Cleanup, PIN Security & UI Dropdown Suite
node tests/verify-galaxy-cleanup-and-security.js

# 2. Panel Sharing, Downstream Rates & Bulk Allocation Suite
node tests/verify-sections-31-to-55.js

# 3. Multi-Tier Hierarchy Financials & Rate Card Integrity Suite
node tests/verify-hierarchy-rates.js

# 4. 30-Point Specification Verification Suite
node tests/verify-all-30-points.js
```
*All suites must report 100% PASS with 0 failures.*
