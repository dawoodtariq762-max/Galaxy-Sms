# Multi-Tier Explicit Allocation Rates — Implementation & Verification Report

**Galaxy SMS Panel — Multi-Tier Hierarchy Allocation Architecture**  
**Date:** September 22, 2026  
**Status:** ✅ Fully Implemented & 100% Verified (74/74 Test Cases PASS + 112/112 Regression Tests PASS)

---

## 1. Executive Summary

The Galaxy SMS panel rate architecture has been updated from a single-tier override model to a comprehensive **Multi-Tier Explicit Allocation Rate Architecture**.

Under this model:
1. **Tier Independence:** Every hierarchy level has its own explicit rate tier:
   - **Provider / Real Cost:** Stored on the `ranges` table (`provider_rate_1_1`, `provider_rate_7_1`, `provider_rate_7_7`, `provider_rate_30_45`), completely isolated from customer and reseller pricing.
   - **Admin Allocation Rate:** Configured by Admin when assigning to Managers, direct Agents, or direct Clients.
   - **Manager Allocation Rate:** Assigned by Manager when delegating numbers to child Agents or direct Clients.
   - **Agent Allocation Rate:** Assigned by Agent when delegating numbers to Clients.
   - **Client Allocation Rate / Payout:** Final rate/payout credited to Client for OTPs.
2. **Exact Rate Delivery:** The exact rate specified during allocation becomes the effective rate for the recipient.
3. **Upstream Preservation:** Modifying downstream rates (e.g. Manager allocating to Agent, or Agent allocating to Client) **never** alters the sender's own upstream rate or the Provider Real Cost.
4. **Rate Management Fallback:** When an allocation rate is left blank, the number cleanly falls back to the Rate Management default rate card for that range and payterm.
5. **Historical Immutability:** Changing Rate Management rate cards or parent defaults does **not** recalculate or mutate historical allocations, SMS logs, or financial ledger records.

---

## 2. Database Schema Changes

To avoid table fragmentation and record duplication, three lightweight columns were added to the `numbers` table:

```sql
ALTER TABLE numbers ADD COLUMN manager_rate TEXT DEFAULT '';
ALTER TABLE numbers ADD COLUMN agent_rate   TEXT DEFAULT '';
ALTER TABLE numbers ADD COLUMN client_rate  TEXT DEFAULT '';
```

### Auto-Migration & Backfill
Implemented in `Galaxy-Sms/backend/schema.js` via `ensureColumn`:
- `manager_rate`: Backfilled from existing `rate` for rows where `manager_id IS NOT NULL`.
- `agent_rate`: Backfilled from existing `rate` for rows where `agent_id IS NOT NULL AND manager_id IS NULL`.
- `client_rate`: Backfilled from existing `payout` for rows where `client_id IS NOT NULL`.

---

## 3. Allocation Matrix & Implementation Details

### Allocation Paths (`/api/numbers/allocate` & `/api/numbers/smart-divide`)

| Sender | Recipient | DB Fields Updated | Upstream Preserved |
|---|---|---|---|
| **Admin** | **Manager** | `manager_id = M, manager_rate = R, rate = R, agent_id = NULL, agent_rate = '', client_id = NULL, client_rate = '', payout = '0'` | Unallocated pool -> Manager rate set |
| **Admin** | **Agent** (Direct) | `agent_id = A, agent_rate = R, rate = R, manager_id = NULL, manager_rate = '', client_id = NULL, client_rate = '', payout = '0'` | Direct Admin -> Agent link |
| **Admin** | **Client** (Direct) | `client_id = C, client_rate = R, payout = R, manager_id = NULL, agent_id = NULL` | Direct Admin -> Client link |
| **Manager** | **Agent** | `agent_id = A, agent_rate = R, client_id = NULL, client_rate = '', payout = '0'` | `manager_id` & `manager_rate` & `rate` **preserved** |
| **Manager** | **Client** (Direct) | `client_id = C, client_rate = R, payout = R, agent_id = NULL, agent_rate = ''` | `manager_id` & `manager_rate` **preserved** |
| **Agent** | **Client** | `client_id = C, client_rate = R, payout = R` | `manager_id`, `manager_rate`, `agent_id`, `agent_rate` **preserved** |

### Tier-Aware Number Projection (`numberSelectSql`)
In `backend/server.js`, `effective_rate` is projected based on the authenticated caller's role:
- **Manager:** Reads `COALESCE(NULLIF(n.manager_rate,''), NULLIF(n.rate,''), cardRate)`
- **Agent:** Reads `COALESCE(NULLIF(n.agent_rate,''), (CASE WHEN n.manager_id IS NULL THEN NULLIF(n.rate,'') END), cardRate)`
- **Client:** Reads `COALESCE(NULLIF(n.client_rate,''), NULLIF(n.payout,''), '0')`
- **Admin:** Reads `COALESCE(CASE WHEN n.manager_id THEN manager_rate/rate WHEN n.agent_id THEN agent_rate/rate WHEN n.client_id THEN client_rate/payout ELSE rate END, cardRate)`

### Tiered Unallocation (`/api/numbers/unallocate`)
- **Agent unallocating Client:** Clears `client_id`, `client_rate`, and `payout` to `'0'`. Preserves `agent_id`, `agent_rate`, `manager_id`, `manager_rate`.
- **Manager unallocating Agent:** Clears `agent_id`, `agent_rate`, `client_id`, `client_rate`, `payout`. Preserves `manager_id`, `manager_rate`.
- **Admin unallocating:** Clears all levels (`manager_id`, `agent_id`, `client_id`, `manager_rate`, `agent_rate`, `client_rate`, `rate`, `payout`).

### SMS Ingestion & Financial Ledger (`processIncomingSmsPayload`)
When incoming OTP SMS is detected, the payout rate is computed for the actual owning recipient:
```javascript
const effectiveNumberRate = n.agent_id
  ? (n.agent_rate || (!n.manager_id ? n.rate : ''))
  : (n.manager_id ? (n.manager_rate || n.rate) : (n.rate || ''));
```
The exact rate assigned to the recipient tier is locked into `sms_records.payout_amount` and `payment_ledger.amount`.

---

## 4. Frontend UI Enhancements

1. **`admin.html`:**
   - Updated `allocAllModal` recipient selector to display Managers, Agents, and Clients.
   - Updated `openAllocAll` and `confirmAllocAll` to support rate overrides across all three target tiers.
2. **`manager.html`:**
   - Updated `allocAllModal` recipient selector to display Agents and direct Clients.
   - Added `Allocation Rate` input to `allocAllModal` with explainer hint: *"Sets the effective rate for the recipient. Your own rate remains unchanged."*
   - Added `Allocation Rate` optional input to `smartModal` (Smart Divide) for distributing ranges across Agents at custom rates.
3. **`agent.html`:**
   - Updated `confirmAllocAll` to supply both `rate` and `payout` matching the Client rate specification.

---

## 5. Verification & Test Results

### Suite 1: `verify-hierarchy-rates.js` (74 PASS / 0 FAIL)
- **Schema Validation:** Verified `manager_rate`, `agent_rate`, and `client_rate` exist on `numbers`.
- **Case 1 (Admin -> Manager):**
  - Explicit rate `0.050` verified on DB (`manager_rate = 0.05`) and Manager query (`effective_rate = 0.05`).
  - Blank rate verified falling back to Rate Management default `0.010`.
- **Case 2 (Admin -> Agent Direct):**
  - Explicit rate `0.045` verified on DB (`agent_rate = 0.045`, `manager_id = NULL`) and Agent query (`effective_rate = 0.045`).
  - Blank rate verified falling back to Rate Management default `0.010`.
- **Case 3 (Admin -> Client Direct):**
  - Explicit rate `0.025` verified on DB (`client_rate = 0.025`, `payout = 0.025`) and Client query (`payout = 0.025`).
- **Case 4 (Manager -> Agent):**
  - Manager allocating to Agent with `0.040` sets Agent rate to `0.040`.
  - **Manager rate `0.050` 100% PRESERVED.**
  - **Range Provider Cost `0.005` 100% PRESERVED.**
  - Manager sees own rate `0.050`, Agent sees assigned rate `0.040`.
- **Case 5 (Manager -> Client):**
  - Manager allocating to Client with `0.007` sets Client payout to `0.007`.
  - Manager rate `0.010` preserved.
- **Case 6 (Agent -> Client):**
  - Agent allocating to Client with `0.020` sets Client payout to `0.020`.
  - Agent rate `0.040` preserved.
  - Manager rate `0.050` preserved.
  - Number linked across all three tiers: `manager_id = M1`, `agent_id = A1`, `client_id = C1`.
- **End-to-End Chain & Financials:**
  - SMS ingested on full-chain number: `sms_records.payout_amount` recorded as `0.040` (Agent's assigned payout).
  - `payment_ledger` credited `0.040` to Agent.
  - Admin dashboard Real Provider Cost calculated accurately.
- **Rate Card Immutability:**
  - Range rate card updated from `0.010` to `0.099`.
  - Number rates remained unchanged (`manager_rate = 0.050`, `agent_rate = 0.040`, `client_rate = 0.020`).
  - Historical SMS records and ledger entries remained unchanged at `0.040`.
- **Tiered Unallocation:**
  - Agent unallocating Client cleared Client fields while preserving Agent (`0.040`) and Manager (`0.050`).
  - Manager unallocating Agent cleared Agent fields while preserving Manager (`0.050`).
  - Admin unallocating cleared all tiers.

### Suite 2: `p19-verify.js` (112 PASS / 0 FAIL)
- All AI allocation limit controls (F1-1 through F1-13): 100% PASS.
- Number delete and stats cleanup (F2-1 through F2-18): 100% PASS.
- CLI facet filtering and scoping (F3-1 through F3-14): 100% PASS.
- Rate override persistence and server restart checks (P2-1 through P2-4): 100% PASS.

### Suite 3: `verify-numbers-copy-feature.js` (60 PASS / 0 FAIL)
- Current-page-only copying across Admin, Manager, Agent, and Client: 100% PASS.

### Suite 4: `verify-number-import-robustness.js` (22 PASS / 0 FAIL)
- Benin 5,000 numbers file, BOM handling, delimiters, Excel imports: 100% PASS.
