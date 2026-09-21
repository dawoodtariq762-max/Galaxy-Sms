# P20 — CDR / SMS Detailed Report Rebuild — FINAL REPORT

**Date:** 2026-09-18 · **Result: 54/54 PASS (P20 suite) + full regression battery 806/806 PASS — 0 failures**
(Total across all suites this session: **860 PASS / 0 FAIL**)

---

## 1. Scope — delivered

The SMS Detailed Report (CDR) was rebuilt to the reference-screenshot design across all four panels, with the **backend as the single source of truth** for filtering, grouping, role scope, payout math and pagination.

| # | Requirement | Status |
|---|-------------|--------|
| 1 | AND-combined backend filters (Date, Time window, Range, SEARCH NUMBER, SEARCH CLI, Provider, Manager/Agent/Client) — filters never overwrite each other | ✅ Verified (R-section) |
| 2 | Role-restricted group-by dimensions, **backend-enforced** (not just hidden in UI) | ✅ Verified (R3–R6, U1) |
| 3 | MY PAYOUT / CLIENT PAYOUT columns + Totals row | ✅ Verified (R1, R2, C1) |
| 4 | Server-side pagination that **preserves filters**, with constant grand totals | ✅ Verified (R27–R31) |
| 5 | Reset clears **everything** (selects, text searches, group-by, date/time) | ✅ Verified (U12) |
| 6 | Client = "SMS Detailed Report" with only CLI / Number / Range / Date-Time filters | ✅ Verified (U2–U4, D9) |
| 7 | Provider filter = Admin-only, sourced from existing Provider Management | ✅ Verified (R19–R21, C2) |
| 8 | Client sees only own records; Manager/Agent confined to their hierarchy; Admin broadest | ✅ Verified (R22–R26) |
| 9 | Existing Date/Time filtering preserved (client's working Time filter kept) | ✅ Verified (C3, R16) |
| 10 | No breakage: Normal SMS Reports, Dashboard, PMS, Rate Management, allocation, Provider Management | ✅ Verified (full battery, §7) |

## 2. Root cause — what was wrong

1. **Old design was a facet/tick UI, not a detailed report.** The pre-P20 "SMS Detailed Report" was the P19 FIX#3 facet design (tick a dimension → value list → click to drill). It could not express the reference panel: multi-dimension Group-by, SEARCH NUMBER / SEARCH CLI free-text, per-role filter selects, MY/CLIENT payout columns, or paginated grouped results. Multiple filter sources (tick state, drill pick, date/time, report filters) lived in separate state objects that could overwrite each other.
2. **Typed search values were never part of the query.** The rebuilt panels initially had the same flaw the old one had: `SEARCH NUMBER` / `SEARCH CLI` inputs were rendered but their values were never synced into the filter state, so typing into them changed nothing (found by the P20 suite itself — U11 initially failed; see §6 bug #1).
3. **No grouped/paginated report endpoint existed.** `/api/sms/paged` paginates raw rows only; grouped aggregation with role-restricted dimensions, AND-combined filters, grand totals and sort did not exist. The old code grouped in the frontend from a capped row dump — wrong beyond the cap and unauditable for scope.
4. **Client panel was a "SMS Stats" page** with a filter set that didn't match the reference (missing Number search, wrong heading).

## 3. Backend changes (`backend/server.js`)

### 3.1 NEW endpoint — `GET /api/sms/report` (the CDR engine)

Single grouped-report endpoint reused by all four panels (no per-role duplicates):

- **Dimensions** — `REPORT_GROUP_DIMS` table with **role gating**:
  `hour, day, month, range, number, cli, currency` → all roles · `client` → admin/manager/agent · `agent` → admin/manager · `manager, provider` → **admin only**.
  Disallowed dims are **silently dropped server-side**; if nothing valid remains → `400`. (Verified: manager `group=provider` → 400; agent drops `agent` dim; client keeps only cli/currency-class dims.)
- **Filters — one AND-combined WHERE** (reuses `buildSmsPagedQuery`, so the CDR and the raw detail drill share the exact same scope+filter engine):
  `from/to` (UK-local date → UTC window), `tfrom/tto` (UK wall-clock time-of-day window, DST-safe, overnight windows supported), `range`, `number_like` / `cli_like` (case-insensitive contains), `provider` (**admin-only** — param ignored for every other role), `manager` / `agent` / `client` (username params).
- **Payout math** (both computed server-side per group):
  - `my_payout` = `SUM(payout_amount)` — **paid only** (zero-rate / over-OTP-limit rows contribute 0).
  - `client_payout` = `SUM(numbers.payout)` over rows with `client_id>0` — **payout-lock × every client row**, including zero-rate rows. (Verified C1: my=0.040 vs client=0.080 on the same dataset.)
- **Time buckets in UK wall-clock** — `ukOffsetSegments` builds a CASE expression so `hour`/`day`/`month` buckets follow UK DST across the whole range (verified with a 2026-07-10 23:30 UTC SMS bucketing to UK 2026-07-11 BST).
- **Pagination** — `page`/`limit` (role-capped, `all` allowed up to role max), `totalPages`, and `totals` = **grand totals over the full filtered set** (constant while paging — verified R29/R30). Last-page clamp verified (R31).
- **Sort** — default: first dim ASC (empty last), then SMS DESC. `sort=sms|payout|client_payout` + `dir=asc|desc` override (grouped-column sorting from the panel headers).
- Cached 1.2 s (panels re-call on every page click).

### 3.2 Extended — `GET /api/sms/paged` (detail drill)

Now selects `r.currency AS range_currency, r.provider AS range_provider` and accepts `number_like` / `cli_like` + the same time-window params — so the ungrouped detail view shows Currency/Provider columns and honors the same searches. Exact `number=`/`cli=` params and all other callers unchanged.

### 3.3 Untouched (deliberately)

`/api/sms`, `/api/sms/clis`, `/api/sms/numbers`, `/api/stats-summary/*`, stats reconcile, PMS, rate management, allocation, Provider Management endpoints — zero changes (regression battery proves it, §7).

## 4. Frontend changes

| Panel | Change |
|-------|--------|
| `admin.html` | SMS Detailed Report rebuilt: SEARCH NUMBER + SEARCH CLI text inputs, Range/Manager/Agent/Client/Provider selects (Provider last, options from existing `/api/providers-info`), Group-by checkbox row (11 dims), Date + Time window, Reset. Grouped table: group columns + Total OTPs + **My Payout + Client Payout** + Totals row + server-side pagination + sortable headers. Ungrouped = detail rows (Date, Range, Number, CLI, Currency, Message). |
| `manager.html` | Same rebuild, role-filtered: no Manager/Provider selects or dims (9 group dims). Grouped columns: Total OTPs + My Payout + Client Payout. |
| `agent.html` | Same rebuild (8 group dims; no Agent dim). Same payout columns. |
| `client.html` | Rebuilt as **"SMS Detailed Report"** (heading + welcome-step text): **only** SEARCH CLI, SEARCH NUMBER, Range select, Date + Time window (+ Day/Number/CLI/Currency group-by). **No Provider/Manager/Agent/Client filters anywhere** (U4 source + runtime check). Grouped view = group + SMS + Totals row only — **no payout columns** (client has no payout concept). Existing Time filter behaviour preserved (C3). |

All four panels: single filter-state object (`sdSelAll()`), text inputs synced into it on every render, `sdReset` returns to defaults and clears text inputs + group ticks + sort.

## 5. Role behavior matrix (all backend-enforced)

| | Admin | Manager | Agent | Client |
|---|---|---|---|---|
| Group dims | 11 (incl. manager, provider) | 9 | 8 | 7 (no user/provider dims) |
| Filter selects | Range, Manager, Agent, Client, Provider | Range, Agent, Client | Range, Client | Range only |
| Text search | Number + CLI | Number + CLI | Number + CLI | Number + CLI |
| Provider param | ✅ | ignored | ignored | ignored |
| `client_payout` column | ✅ | ✅ | ✅ | — (no payout columns) |
| Data scope | all | own subtree | own subtree | own records only |

## 6. Real bugs found & fixed **by the verification suites** (not by eyeballing)

1. **Typed search never reached the query** — `renderSmsDetail` read only the select state; `sdNumSearch`/`sdCliSearch` values were never picked up. Fixed: input→state sync at the top of `renderSmsDetail` (admin/manager/agent + client's `renderStats` equivalent), and the old write-back inside `sdSyncFilterSelects` removed (it would have re-clobbered the state). Live-verified: CLI search filters 8→4 rows with grouping active.
2. **Reset left stale text filters** — `sdReset` cleared selects but not the text inputs, so the next render synced the old value back in. Fixed in all panels (reset now clears `sdNumSearch`/`sdCliSearch` values).
3. **Manager/agent lost three function definitions in the rebuild** — the block-replacement anchors overlapped (`sdReset` anchor matched the new block's `sdReset` and cut through `sdFmtDim`/`gxSdGroupSort`/`fillSdFilterSelects`). Symptom: `ReferenceError: fillSdFilterSelects is not defined` at panel boot — caught by the p19-ui regression suite (UI-M1/UI-G1 "0 uncaught script errors" checks). Fixed by re-inserting the three definitions before `groupRows`; both panels re-verified boot-clean and `check-html-scripts` 0 FAIL.

## 7. Evidence

### 7.1 P20 suite — `tests/p20-cdr-verify.js` → **54 PASS / 0 FAIL**

Fixture (fresh DB, port 8098): chain M1(manager) > A1(agent) > C1(client); numbers N1,N2,N4→M1; N1,N4→A1; N4→C1 (payout-lock 0.020). Ranges PK-ONE (USD/ProvA/0.014), PK-TWO (EUR/ProvB/0.020). 8 webhook SMS today (incl. 44LIMIT daily=2 → 2 paid + 2 zero-rate) + 3 backdated (UK-DST boundary rows).

- **F1–F3** fixture integrity (chain, allocation, range config).
- **R1–R31** backend: expected totals matrix (admin 11 SMS/0.144/0.100; manager same; agent 10; client 5; PK-ONE 6/0.084; PK-TWO 5/0.060/0.100; today 8/0.096/0.080) · group=range/number+client/range+number/day (DST-exact 2026-07-11 + 2026-01-15)/hour (exact UK wall-clock)/month/currency/provider · role dim-dropping (manager provider→400, agent, client) · AND-combos (date+cli_like+range; provider+year; user= params) · contains-search (number_like/cli_like) · client unauthorized range→0 · payout semantics (my=paid-only 0.040 vs client_payout=all-client-rows 0.080) · pagination (page-continue, constant grand totals, last-page clamp) · grouped sort asc · no-group→400 · empty→0.
- **C1–C4** detail drill `/api/sms/paged`: `range_currency` + `range_provider` present, `number_like`/`cli_like`, time-window honored.
- **U1–U16** panels (jsdom, live server): role dim rows 11/9/8/7 · client rename incl. welcome text · client has no provider/manager/agent/client filter anywhere (source-level) · admin grouped render (grouped table + Totals + 17 pagination buttons) · CLI search live-filters 8→4 · Reset restores default (8) · detail mode Date+Currency+Message · client grouped = Day+SMS only + Totals row, no payout columns.

### 7.2 Regression battery — **all green**

| Suite | Result |
|-------|--------|
| p20-cdr-verify | **54 / 0** |
| p19k-verify (C15–C17/D9 reworked to P20 UI; C-section API multi-filter etc. untouched) | **108 / 0** |
| p19-verify | 112 / 0 |
| p19-ui-verify (facet-flow tests reworked to Group-by equivalents; M1/G1 boot checks caught bug #3) | **36 / 0** |
| p19b / p19c / p19d / p19e-chat / p19f / p19g / p19i / p19j | 35 · 57 · 63 · 94 · 35 · 35 · 95 · 69 — all 0 FAIL |
| p12-regression (seeded fresh DB: vibepk pw + demo_mgr→demo_agt→demo_cli real-ID chain, `ASSISTANT_USER_RPM=25`) | **67 / 0** |

**Total: 860 PASS / 0 FAIL.** Shared surfaces (Normal SMS Reports, Dashboard, PMS/payment cycles, Rate Management, allocation/ownership, Provider Management, AI assistant) all verified unbroken.

## 8. How to run

```bash
# P20 suite (boots own server on :8098, fresh /tmp/p20cdr.db)
node tests/p20-cdr-verify.js

# regression battery
for t in p19 p19b p19c p19d p19e-chat p19f p19g p19i p19j p19k p19-ui p20-cdr; do node tests/$t-verify.js; done

# p12 (needs seeded DB + RPM):
#   fresh boot -> set vibepk pw Test123! via PUT /api/users/:id (numeric id, active:1)
#   -> create demo_mgr/demo_agt/demo_cli chain with REAL parent ids
#   -> re-boot with ASSISTANT_USER_RPM=25, then:
P12_DB=/tmp/p12test.db node tests/p12-regression.js
```

## 9. Limitations

- **UI verification is jsdom, not a real browser.** All four panels boot with 0 uncaught script errors and every interaction (group tick → render, search → live filter, reset, pagination buttons, sort headers) is exercised against a live backend through the panels' own code paths — but pixel-level layout/CSS was not browser-tested.
- Group-by checkbox rows are **runtime-generated from array literals** in the panel HTML (source-level greps must use the literal form, e.g. `'hour','Hour'` — not `id="sdGb_hour"`).
- `limit=all` is capped per role (`ROLE_ALL_MAX`) — a full export is intentional, not a defect.
- The legacy `/api/stats-summary/:by` endpoint and its P19 facet consumers remain in the codebase (dashboard widgets still use stats endpoints); the SMS Detailed Report no longer calls them.

## 10. Open items

None. All acceptance criteria verified with evidence (§7).
