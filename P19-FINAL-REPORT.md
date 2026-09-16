# GALAXY SMS — P19 FINAL REPORT (FIX #1–#4 + NEW FEATURE)

**Task:** "GALAXY SMS — REQUIRED FIXES + NEW FEATURES" (4 items)
**Date:** 2026-09-15 · **Base commit:** `1e0e004` (main)
**Verdict:** All 4 items implemented and verified. Backend suite **112/112 PASS**, UI suite **36/36 PASS**. During verification **1 pre-existing CRITICAL bug** (not caused by this task) was found and minimally fixed — see item 15. No unrelated system was changed.

---

## 1. Overall summary (what changed, in one screen)

| Fix | What it does now | Files |
|---|---|---|
| FIX #1 AI allocation limit | Default 500→**100**, admin-configurable 1–5000, backend-enforced, survives restart. Panel/admin/manager limits untouched. | `backend/assistant.js`, `backend/schema.js`, `admin.html` |
| FIX #2 delete + SMS cleanup | Number deleted WITH its SMS ⇒ records vanish from dashboard/stats/reports immediately; no resurrection on refresh; DST-safe; ledger immutable. Delete WITHOUT SMS ⇒ old behaviour kept. | `backend/server.js` |
| FIX #3 CLI filter | "SMS Support" page (= **SMS Report**) me CLI dropdown/box **removed** for Admin/Manager/Agent. CLI filtering now lives in **SMS Detailed Report** as a server-side, role-scoped **facet** (tick CLI → list of CLIs + SMS + payout → click → filtered). Client panel untouched. | `backend/server.js`, `admin.html`, `manager.html`, `agent.html` |
| FIX #4 (NEW) Admin allocation rate override | Rate Management range rate = default; **only Admin** may override per-allocation (stored on `numbers.rate`); two allocations to same agent with different rates coexist; payment ledger snapshots rate at SMS time; rate ≠ payment frequency. | `backend/server.js`, `admin.html` |

`api.js` **unchanged** (0 diff) → **no `?v=` bump needed**. `client.html` **unchanged**. Single Node process + single SQLite file preserved (PM2 instances:1).

---

## 2. FIX #1 — Root cause & exact behaviour

- **Before:** AI assistant's allocation flow allowed up to 500/quantity with no configurable cap; the hard-coded limit lived only inside the assistant intent code.
- **Now (exact behaviour):**
  - Default **100** per range (`AI_ALLOC_DEFAULT_MAX = 100`, `backend/assistant.js:39`).
  - Admin can change it in the **existing AI Knowledge settings UI** (`admin.html` AI Settings → "AI Allocation Limit" input + Save). Stored in the **existing settings architecture** (`assistant_settings` KV table, key `alloc_max`) — **no new settings system**.
  - Backend enforcement at **both** steps of the AI flow: quantity entry (`assistant.js:391`) and confirm step re-check (`assistant.js:411`). Over-limit reply: *"The maximum I can provide is N numbers per range."* Under-limit quantities pass normally (availability may still refuse for pool reasons — unchanged behaviour).
  - Range 1–5000 (hard cap `AI_ALLOC_HARD_CAP`), integer only. Invalid values → HTTP 400.
  - **Only the AI flow is capped.** Panel (admin/manager) bulk allocation and smart-divide panel paths are untouched (verified: panel allocated 8 when AI limit was 5).
  - Survives restart (value read from DB each time; verified in restart test P2-1/P2-3).

## 3. FIX #1 — APIs / schema / implementation locations

- **API:** `GET /api/assistant/knowledge` → response now includes `settings.alloc_max` (`assistant.js:296`). `PUT /api/assistant/knowledge-settings` accepts `alloc_max` (`assistant.js:326–333`); admin-only (manager/agent get 403 — pre-existing role gate, unchanged).
- **Schema:** `backend/schema.js:253` — seed `INSERT INTO assistant_settings (key,value) VALUES ('alloc_max','100')` if absent (settings/migration affects future only; existing DBs get the default on next boot; admin's saved value always wins).
- **UI:** `admin.html:447–448` input `#aiAllocMax` + Save button; `admin.html:1638` auto-fill from settings; `admin.html:1659` `saveAiAllocMax()` (PUT) with client-side 1–5000 guard and Roman-Urdu alert.

## 4. FIX #1 — Tests performed + results (all PASS)

Default=100 (F1-1) · flow mentions "max 100" (F1-2) · qty 150 refused with exact message (F1-3) · qty 100 passes limit (F1-4) · admin sets 50 → qty 60 refused (F1-5/6) · invalid `abc`/`0`/`-5`/`5001`/`2.5` → 400 (F1-7 — `2.5` rejection was **hardened during testing**, see item 16) · manager PUT → 403, agent PUT → 403 (F1-8) · 100/200/500/1000 accepted (F1-9) · AI executes 3 at limit 5 (F1-11) · AI refuses 6 at limit 5 with exact message (F1-12) · panel allocates 8 > AI limit 5 unaffected (F1-13) · value survives restart + still enforced after restart (P2-1/P2-3) · UI auto-fill, save path, invalid-UI-block (UI-A2…A5).

---

## 5. FIX #2 — Root cause

When a number was deleted together with its SMS, the `sms_records` rows were deleted, but the **daily stats table kept the aggregate rows** (sms count / payout per UK date+owner+CLI). Additionally the **read caches** (dashboard, stats-summary, sms lists) were keyed by version counters that were **not bumped** by the delete, so stale summaries kept being served and "re-appeared" after refresh. A second, subtler bug: the stats-decrement computed the UK date of each deleted SMS with a fixed `+60min` offset — **wrong during BST for winter (GMT) timestamps**, so winter rows could survive as stale aggregates.

## 6. FIX #2 — Implementation (files/locations)

- `backend/server.js` `deleteNumbersFromRows()` (line 2293):
  - For each deleted SMS row the daily-stats decrement now uses **`ukStatDate(ts)`** (line 87) — the exact DST-safe UK-date helper the ingest path uses — instead of the fixed +60min offset. Old line preserved in comment for rollback.
  - Calls `bumpNumbersVer()` after the delete.
- Cache invalidation (already-existing version-key system, **reused** — no new cache layer): `numbers_ver` is now passed as `verKey` to `cachedJson(...)` on: **dashboard summary, `/api/stats-summary/*`, `/api/sms/clis`, `/api/sms-numbers`, `/api/sms/paged` (cached variant)**. Effect: any delete/import/allocation instantly invalidates all derived views.
- Ledger untouched (immutability preserved). Delete-without-SMS path untouched.

## 7. FIX #2 — Tests performed + results (all PASS)

Baseline 9-today/10-total (incl. 1 winter GMT row + 1 UK-boundary row inserted exactly as ingest would key them) → delete n0 WITH sms: `deleted_sms=4` (F2-3) · dashboard drops 3/4 **immediately** (F2-4/5) · **second refresh identical — no resurrection** (F2-6) · deleted CLIs 111/222 gone, survivors 333/444/555/888 intact (F2-7/8) · **winter row removed under the correct UK key 2026-01-15** — the old buggy code would have keyed 2026-01-16 during BST and left the row stale (F2-9) · report rows gone (F2-10/11) · no orphan/negative stats rows (F2-12) · **payment ledger count unchanged** before=8 after=8 (F2-13) · `sms_records` fully deleted (F2-14) · delete n2 WITHOUT sms: history/reports/dashboard all preserved (F2-15…18) · dashboard consistent after server restart (P2-4).

---

## 8. FIX #3 — Terminology mapping (decision, as instructed)

- Owner's **"SMS Support"** = the **SMS Report** page (CDR Stats → SMS Report) in all three panels.
- Owner's **"Grade"** = **Range** (existing filter, kept as-is; action identical either way).
- **CLI filtering belongs in SMS Detailed Report.**

## 9. FIX #3 — Backend implementation

- **Removed from SMS Report data path:** the CLI select population for admin/manager/agent (rollback comments left in place: `admin.html:1261`, `manager.html:905`, `agent.html:760`).
- **SMS Detail is now facet-based**, powered by the existing `/api/stats-summary/:by` endpoint (`backend/server.js:2752`) which was extended with the **`cli` and `provider` dimensions** (admin/manager/agent; per-role allowed dims already existed). The endpoint is **server-side role-scoped** (same scope engine as every other report — no frontend-only hiding), respects **UK timezone date rules**, and combines with **Date / Time window / Range / Number / Manager|Agent / search** filters. Facet results return exactly: **CLI + N SMS + $ payout**.
- Detail drill uses the existing `/api/sms/paged` with a `cli` param (role+date scoped) — efficient pagination, no global CLI dump into the frontend.
- `/api/sms/clis` (older endpoint) left intact for the client panel.

## 10. FIX#3 — Panel UI changes

- **admin / manager / agent:** SMS Report filter row now has Date/Time/Range/Number/Manager(+Agent) only — **the CLI dropdown and the "All CLI" box are gone and were NOT replaced by another dropdown**. SMS Detailed Report gained the facet UI: tick **CLI** (or Number/Range/Manager/Provider) → results area lists the values **from the current authorized, dated dataset** (CLI · Total OTPs · Total Payout) → **click a value** → detail rows filter to it (chip shows the active pick, ✕ clears; changing a tick resets the drill). No selection = all rows.
  - Panel dim sets: admin `cli>number>range>manager>provider` · manager `cli>number>range>agent` · agent `cli>number>range>client` (agent also got the **Time filter wired** into the SMS Detail query — it existed in HTML but was not part of the query args before).
  - Legacy duplicated (dead) `renderSmsDetail` copies at the top of manager/agent were neutralized in-place (`*_legacy_dead_P19` + early `return`) — the LIVE bottom definitions win; **nothing was deleted**.
- **client.html: zero changes** — `stCli` behaviour preserved (verified).

## 11. FIX #3 — Tests performed + results (all PASS)

Admin facet = today's dataset only, no global dump (F3-1) · payout math per allocation rate, 333 = 2×0.013 = 0.026 (F3-2) · **agent sees only own CLIs** 333/555/666 (F3-3) · **manager sees subtree only** 333/555/666/888 — not direct-admin A2 CLIs 444/121/131 (F3-4) · client sees only own data (F3-5) · UK boundary SMS (yesterday 23:30Z = UK today) excluded from UK-yesterday, included in UK-today (F3-6/7) · combos: cli+range+provider (F3-8), cli+manager (F3-9), range-facet narrowed by CLI pick (F3-10), provider facet (F3-11), cli+time-window (F3-12) · drill `/sms/paged?cli=333` → only 333 rows (F3-13) · `/sms/clis` role+date scoped (F3-14) · UI: srCli absent + other filters intact in all three panels, facet→pick→chip→unpick flow against live data (UI-A6…A11, UI-M2/M5, UI-G2/G4/G5/G6), client stCli present (UI-C2).

---

## 12. FIX #4 (NEW) — Backend implementation

- **Validation:** `validatedAllocationRate(user, raw)` (`server.js:2051`) — **only admin** rate params are honoured; manager/agent rate params are **silently ignored** (same pattern the codebase already uses for payout → manager gets **no new ability**). Valid = positive decimal ≤ 6 decimal places ≤ 100000, stored as **decimal string** (project convention). Rejects: negative (sign-check added — see item 16), malformed, 7-dp, huge, zero.
- **Storage:** `handleAllocate` (`server.js:2080–2118`) — admin sends `rate` ⇒ stored on the allocated rows in **`numbers.rate`** (per-number = allocation-level; empty string = "use Rate Management default"). Same for the admin **smart-divide** path (`server.js:2539` rate param + `rate_override` audit field). **Rate Management values are never modified by allocation.**
- **Coexistence:** because the rate lives per number, two allocations to the same agent with different rates coexist (verified F4-E).
- **Payment engine — reused, not duplicated:** `payoutRateForPaymentCycle()` (`server.js:1192`) now checks **`number_rate` (the allocation override) first**, for **all four payment cycles**, then falls back to the range cycle rate. The SMS row and the **payment ledger snapshot the rate at SMS time** (existing engine behaviour — no historical recalculation; verified F4-F3: old rows keep 0.013 even after Rate Management changed to 0.025).
- **Rate ≠ frequency:** `numbers.payterm` (cycle) and `numbers.rate` are independent columns; `users.payment_type` is **never** touched by allocation (P12 rule preserved — before/after verified F4-P12).
- **Rate-lock on moves:** Admin→Manager and Manager→Agent moves **keep** the admin-set rate (manager cannot change it — has no rate param anyway). Agent→Client keeps rate and sets the client `payout` (existing rule). Unallocate clears the override (`rate=''`).

## 13. FIX #4 — Admin UI

- **Bulk "Allocate" modal** (`allocAllModal`): new **Rate** input `#aaRate` prefilled with the **Rate Management default of the selected numbers' range** for the chosen cycle (`aaRefreshDefaultRate()`), with hint: *"Default rate Rate Management se aata hai. Value change karne par sirf YEH allocation override hota hai — Rate Management / Agent ka global rate change NAHI hota."*
- **Range Allocation toolbar:** Rate input `#allocRate` + refresh on range/cycle change.
- **Per-range row:** Rate input `ar<i>` prefilled with that range's cycle rate.
- Manager/agent panels: **no rate UI at all** (verified UI-M3/G3).

## 14. FIX #4 — Tests performed + results (all PASS)

A: admin→agent default ⇒ `numbers.rate` stays '' (F4-A) · B: override 0.013 lands on both numbers (F4-B) · C/D: admin→manager default + override kept (F4-C/D) · **D2: smart-divide with rate 0.017** (F4-D2) · E: coexisting rates ''+0.013 on same agent (F4-E) · M1/M2: **manager→agent keeps admin 0.013 (rate-lock)**, manager's own rate param silently ignored (F4-M1/M2) · AC: agent→client keeps rate + sets payout (F4-AC) · V1–V6: negative/malformed/7-dp/too-large/zero/smart-divide-bad all 400 (F4-V*) · H: payouts use range 0.020 when no override; **allocation rate 0.013 beats range 0.010**; ledger amount snapshots 0.013 (F4-H1…H4) · F: existing override survives Rate Mgmt change; old SMS keeps 0.013 snapshot; new allocation (no override) uses NEW range rate 0.025 (F4-F0…F4) · G: rate+frequency independent (0.010/daily, 0.013/weekly_7_7, ''/monthly ⇒ 0.020) with matching payouts + payment types (F4-G) · P12 untouched (F4-P12) · numbers list `effective_rate` shows override (F4-DISP) · unallocate clears rate (F4-U) · rates survive restart (P2-2) · **UI E2E: default auto-fill 0.020 from Rate Management, override 0.019 via the real modal flow lands on the number, Rate Management unchanged** (UI-A12…A17).

---

## 15. BONUS FIX — pre-existing CRITICAL allocation bug (found by this task's tests, fixed minimally)

- **Bug:** commit `f31ee62` (2026-09-13, Phase-1 audit guard #21–#25) introduced an `ownGuard` in `handleAllocate` that only allowed **fully-unallocated** numbers. Consequence in production: **Manager→Agent and Agent→Client allocations from the panel were silently SKIPPED** (`allocated:0, skipped:N`) — and the panels alerted "✅ N numbers allocated" using the *selected* count, so users never saw the failure. Verified failing on **pristine HEAD** (worktree test, no P19 changes).
- **Why in scope:** FIX #4's specified tests (manager→agent rate-lock, agent→client rate+payout) exercise exactly these flows; they cannot pass with the bug.
- **Fix** (`server.js:2155`): for **manager/agent callers** the scope filter already restricts to their own pool, so the guard now requires only *"target slot free or already the target's"* — **silent X→Y steal between two agents remains impossible** (unallocate or explicit force still required). **Admin keeps the strict fully-unallocated rule** (force for deliberate reassignment, audit-logged). Previous line preserved in comment for rollback.
- **Verified:** pristine-HEAD repro (fail) → fixed code (pass); manager→agent and agent→client now allocate via the exact panel payload (no `force`); role subtree scoping re-verified end-to-end (F3-3/F3-4/F3-14).

## 16. BONUS FIX — two validation hardenings found by the suite

1. `alloc_max='2.5'` was silently truncated to 2 by `parseInt` → now rejected 400 (strict digit-string check, `assistant.js:326`).
2. Rate `'-0.5'` had its **sign silently dropped** by `normalizeDecimalString` (`BigInt('-0')`) and was stored as `0.5` → raw negative inputs now rejected 400 before normalization (`server.js:2051`).

---

## 17. Full test inventory (how to re-run everything)

| Suite | Checks | Result | Command (from repo root) |
|---|---|---|---|
| Backend/API verification (self-contained: fresh DB, real server, real webhook ingests, restart persistence) | 112 | **112 PASS / 0 FAIL** | `node tests/p19-verify.js` |
| UI verification (jsdom DOM-level: all 4 panels boot + FIX#1/3/4 flows against live server; mobile = static analysis) | 36 | **36 PASS / 0 FAIL** | `node tests/p19-ui-verify.js` (needs `npm i jsdom` in a scratch dir; run the backend suite first — it creates the fixture DB) |
| Inline-script syntax check, all 4 panels | 8 blocks | 0 FAIL | `node scripts/check-html-scripts.js admin.html` (repeat per panel) |

Honest limits of testing: the sandbox has **no real browser and no root** — desktop UI was verified at DOM level via jsdom with the live backend (real API data, real click handlers), and **mobile was verified by static analysis only** (viewport meta, media queries, no over-wide fixed inputs). A quick eyeball on a real phone after deploy is recommended.

## 18. Unrelated systems — unchanged confirmation + remaining notes

- **Unchanged (verified):** `api.js` (0 diff → no `?v=` bump needed), `client.html`, payment ledger engine & immutability, permissions/role matrix, webhook/ingest pipeline, imports, backups, SMPP, sharing panel, existing Date/Time/Range/Number/Manager filters and UK-date behaviour everywhere else.
- **Known leftovers (intentional, harmless):** `gxOptList()` helper + `sdListArgs` in manager/agent are now unused but still defined (never called — renders nothing); the dead legacy `renderSmsDetail_*_legacy_dead_P19` copies were neutralized, not deleted; `admin smsClis` API reference remains only inside the dead path. Clean-up can be a separate task.
- **Pre-existing quirk (documented, NOT changed):** the admin smart-divide **picker** selects numbers with `manager_id IS NULL` — it can therefore take numbers that are currently assigned to agents (admin-only action, audit-logged, same as before P19). Flagged for a future task if unwanted.
- **UI text style:** all new user-facing one-liners are short professional Roman-Urdu (existing style).

## 19. Deployment (copy-paste) + rollback

**Deliverable:** `galaxy-sms-p19-fixes.tar.gz` — contains only changed/new files; extracts over the repo root.

**On your PC:**
```bash
cd path/to/Galaxy-Sms
tar -xzf /path/to/galaxy-sms-p19-fixes.tar.gz
git add -A
git commit -m "P19: AI alloc limit, delete+SMS cleanup, SMS Report CLI removal + SMS Detail CLI facet, admin allocation rate override"
git push origin main
```

**On the VPS:**
```bash
cd /opt/galaxy
git fetch && git reset --hard origin/main
npm install --omit=dev
pm2 restart galaxy
```
> PM2 process name: the current VPS runs the app as **`galaxy`** (per handover). If that errors, run `pm2 list` and use the name shown in the first column. Repo's `ecosystem.config.js` names it `powerx` — only relevant if you ever start fresh via `pm2 start ecosystem.config.js`. **Never start a second copy** — the app must stay a single process (one SQLite writer).

**Smoke test after deploy (2 minutes):** Admin → AI Settings → limit shows 100, set 50, Save, restart pm2, still 50 · SMS Report page has no CLI box · SMS Detail: tick CLI → CLIs listed → click one → filtered · Numbers → select → Allocate → Rate field pre-filled from Rate Management; change it → only that allocation's rate changes · Manager: allocate own-pool numbers to an agent → succeeds (this was the silently-broken flow).

**Rollback:** every changed block carries a rollback comment (`P19`/`P18` style) documenting the previous line; `git revert <commit>` restores previous behaviour. The ownGuard rollback line is in `server.js:2155`'s comment.

---
---

# P19b ADDENDUM — 2 follow-up fixes reported after first deploy (map + delete leftovers)

**Reported:** "1) Globe map Russia/Afghanistan par bina kisi real message ke counts dikha raha hai. 2) Numbers + unka OTP data delete karne ke baad bhi dashboard par data dikh raha hai — payouts aur OTPs sab sath delete hone chahiye."

## 20. Root cause — map (issue 1): three bugs found in `sms_by_country` (dashboard world map)

1. **TEST/DEMO rows counted as real traffic.** The map queries read `sms_records` **without** the `is_test=0` filter that every other real-stat view uses. The admin Test Panel / demo generator inserts `is_test=1` rows with fake numbers — those fake numbers' prefixes painted **Russia (7…) / Afghanistan (93…) etc. on the map with no real message ever received**. (Dashboard cards excluded them, which is exactly why the map disagreed with everything else.)
2. **Naive country attribution.** Old logic: take first 2 digits, look up; else first 1 digit if it's 1 or 7. UK numbers stored in **national format (7xxx…)** therefore showed as **Russia**; 3-digit country codes (353 Ireland etc.) never showed at all.
3. **Wrong "today" window.** The map used `received_at >= today 00:00 UTC` while the cards use the **UK day** — the two disagreed around DST/midnight.

## 21. Map fix — exact behaviour now

- **Test/demo rows are excluded** (`COALESCE(s.is_test,0)=0`) — map shows REAL traffic only, consistent with cards/reports.
- **"Today" = the same UK-day window the cards use** (`ukDayOffsetSql`).
- **Attribution is authoritative first:** the number's **Range country** (what you set in Range Management; alias map UK/United Kingdom/England→gb, USA→us, UAE→ae, plus all E.164 names) → **fallback: proper E.164 longest-prefix (3→2→1 digits)**. National-format UK numbers now show under **United Kingdom**, not Russia. Ireland/Portugal etc. (3-digit codes) now work.
- **Junk guard:** numbers shorter than 7 digits (shortcodes, junk) are attributed to **no country**.
- Numbers with no range and an unresolvable prefix simply don't appear.
- Role scoping (admin/manager/agent/client see only their own tree) retained — re-verified.

## 22. Root cause + fix — delete leftovers (issue 2)

Two real gaps found (beyond the P19 fixes, which re-verified green):

1. **Range-delete orphan SMS:** when a range was deleted with "delete SMS", numbers' linked SMS were decremented from stats, but **orphan rows** (SMS of numbers deleted earlier *without* SMS) were raw-deleted **without decrementing stats** → dashboard kept showing them. **Fixed:** the range-delete path now decrements stats for those rows first (shared helper).
2. **Phantom-row hazard:** the stats decrement used `INSERT … ON CONFLICT DO UPDATE` with **positive** values — if a stats row was ever missing/mismatched, the delete would **insert a positive phantom row** (dashboard *gains* deleted data). **Fixed:** the shared `decrementSmsDailyStats()` now inserts **negative** values with `+` upsert — a missing key nets to zero and is cleaned up; stats can never inflate from a delete.
3. **Repair tool for already-stale counters:** deletes performed under the OLD code (before the P19 deploy) left stale rows in `sms_daily_stats`. New admin button **"Rebuild Stats"** (Numbers page → DB tools row, 🔄 icon) calls the existing `POST /admin/backfill-stats {reset:true}` — rebuilds all dashboard counters from `sms_records` (test rows excluded automatically). **Click it ONCE after deploying this fix** to repair history.

## 23. Files changed in P19b

| File | Change |
|---|---|
| `backend/server.js` | `sms_by_country` block rewritten (is_test filter, UK-day window, range-country + longest-prefix attribution, junk guard); new shared `decrementSmsDailyStats()` (phantom-safe) used by number-delete AND range-delete orphan path; rollback comments inline |
| `assets/galaxy.js` | `GX.countryOf` (numbers-table Country column): same longest-prefix + min-7-digits rule |
| `admin.html` | "Rebuild Stats" button + `rebuildDashboardStats()` (confirm-gated, Roman-Urdu messages) |
| `manager.html`, `agent.html`, `client.html` | `galaxy.js?v=gal-8` → `?v=gal-9` (cache-bust, required) |
| `tests/p19b-verify.js` | NEW suite (below) |

## 24. P19b tests + results, deploy & verify steps

**Suite:** `node tests/p19b-verify.js` — **35/35 PASS**:
- Map: E.164 UK → gb ✓ · **no Russia from test rows or national-format numbers** ✓ · national-format 74… → gb via range country ✓ · 3-digit code 353 → Ireland ✓ · shortcodes → no country ✓ · UK-day boundary SMS (yesterday 23:30Z = UK today) counted ✓ · manager/agent scoping ✓ · delete number+SMS → map AND cards drop immediately ✓
- Delete: range-delete orphans decremented (old code: stuck) ✓ · delete-without-SMS still preserves history ✓ · **no positive phantom row when a stats row is missing** ✓ · payment ledger untouched ✓

**Regression:** full P19 suite re-run after the refactor — **112/112 PASS**; UI suite — **36/36 PASS** (plus 4-panel inline-script checks + `?v=gal-9` present in all four).

**Deploy (VPS):**
```bash
cd /opt/galaxy
git fetch && git reset --hard origin/main
npm install --omit=dev
pm2 restart galaxy     # (or the name from: pm2 list)
```

**After deploy (one time):** Admin panel → **Numbers** page → **Rebuild Stats** (🔄 button next to "Delete by Range") → confirm. This repairs any dashboard counters that went stale from deletes made under the old code. Then hard-refresh the browser (Ctrl+Shift+R) so the new `galaxy.js?v=gal-9` loads.

**Verify (1 minute):** Dashboard map now shows only real countries (no Russia/Afghanistan unless you truly have such numbers — range country wins) · delete a number with OTP data → cards, payouts AND map all drop immediately and stay dropped on refresh.

---

# P19c — 3 FINAL FIXES (Client Week Payout · Exact Client Payout · Deleted-Data Dashboards)

**Files changed (P19c only):**
| File | Change |
|---|---|
| `client.html` | FIX#1 dashboard card + binding; FIX#2 Payout column + `cliPay()` formatter (both loaders + both renderers) |
| `tests/p19c-verify.js` | NEW — 57 checks covering all 3 fixes incl. owner's TEST A–D and jsdom UI verification |

**APIs changed:** NONE. No backend file touched in P19c — verified by inspection that `/api/dashboard` already returns `payout_week` (Monday-start UK week) and `/api/numbers` already returns `payout` for clients; only the client UI bound/ignored them.
**DB changes:** NONE.
**`api.js` unchanged** → no `?v=` cache-bust needed in the four panels.

## FIX#1 — Client dashboard "This Month Payout" → REAL "This Week Payout"

- **Implementation:** card label changed (client.html ~370) and the 4th card now binds `'$ '+pay3(d.payout_week)` (client.html ~573). `payout_week` is computed by the SAME existing engine the admin panel uses: UK (`Europe/London`) stat-dates, week window = **Monday → today**. No new calculation was written (no duplicate system).
- **Week-payout implementation (existing, reused):** `sms_daily_stats.payout_sum` summed over `stat_date BETWEEN monday AND today`, scoped to the logged-in client's numbers only.
- **Test proof (week ≠ month):** inserted a client stats row dated previous Monday (payout_sum 5.00) → `payout_month` included it (5.02), `payout_week` did NOT (0.02) — proves the card is genuinely weekly, not a label rename. Admin/manager/agent dashboards untouched.

## FIX#2 — Client panel shows EXACT agent-assigned allocation payout

- **Payout source (full trace):** agent allocates → `POST /api/numbers/allocate` stores the entered value **verbatim** into `numbers.payout` ('0', '1', '2', '0.013') → `/api/numbers` returns `SELECT n.*` (field `payout`, all roles incl. client) → client panel renders it. **No fallback** to range rate / manager rate / agent default / global rate — the value displayed is exactly the agent's allocation.
- **Zero / 1 / 2 / custom preservation:** new `cliPay(v)` formatter — empty → `$0.00`; ≤2 decimals → `$X.XX` (`$0.00`, `$1.00`, `$2.00`); >2 decimals → **exact raw string** (`$0.013`). Values stored as exact decimal strings in DB (verified `"0","1","2","0.013"`).
- **UI:** new **Payout** column after Status (header + LIVE renderer + legacy renderer + empty-state colspan 6→7; `data-label="Payout"` for mobile card view). Range Management rate stayed `0.010` — no leakage.
- **Test cases:** same client, 4 numbers with payouts 0/1/2/0.013 → each correct + coexisting + stable after refresh (UI-C6…UI-C10).

## FIX#3 — Deleted numbers/OTP no longer counted in Admin dashboard (root cause)

**Owner's 6 questions — direct answers:**

1. **Why CDR/SMS stats were correct while Admin Dashboard still counted:** they read different tables. CDR / SMS Detail read `sms_records` — the delete removed those rows, so CDR went clean immediately. Dashboard cards ("This Year OTPs", "This Month Payout", all others) read pre-aggregated `sms_daily_stats` — the old delete path **never decremented** that table, so dashboard numbers stayed stale forever.
2. **Which API/query/table/cache was responsible:** `/api/dashboard` → `statSum()`/`statPay()` queries on table `sms_daily_stats`. There is also a 15-second dashboard cache in memory — but it is version-keyed (`verKey`) and invalidated by deletes, so cache was NOT the culprit; the missing decrement was.
3. **What changed (in P19/P19b, re-verified for P19c):** `POST /api/numbers/delete` now decrements `sms_daily_stats` for selected numbers, "select all" (filtered), range-delete, and orphaned SMS — phantom-safe upsert (no row is created for deleted data; no negatives).
4. **Why the new implementation keeps consistency:** deletes and dashboard both go through `sms_daily_stats`; CDR goes through `sms_records`; both are updated in the same delete transaction, so they can never disagree again.
5. **How unrelated-data preservation was verified:** TEST D — a second number's SMS/CDR/stats survived the delete intact; payment ledger untouched (immutable business rule — it never feeds dashboard totals, so no change needed there); client payouts and range rates unchanged.
6. **Important for your live VPS:** any staleness created by deletes made **before** P19 is historical residue in `sms_daily_stats`. After deploying this bundle, run **Rebuild Stats once** (Numbers page → 🔄) — it recomputes the stats table from `sms_records` and permanently removes the old residue. New deletes need no rebuild.

**TEST A–D results (dedicated numbers `447200000001/2`, controlled SMS, real delete API):**
- **A (before):** today 6, month 11, year 13 (incl. 2 backdated March rows), payout_month 5.06, CDR showed TN1 CLIs 9101:2 / 9102:1.
- **B (delete + delete_sms):** number gone, 5 sms_records gone, CDR clean (9101/9102 no longer listed), **This Year OTPs 13 → 8** (−5: 3 today + 2 March), **This Month 11 → 8** (−3), **This Month Payout 5.06 → 5.03** (−0.030 = exactly this-month rows; March payout only affects year-level stats), today 6→3, total 13→8. No negative/orphan rows.
- **C (cache/reload):** immediate re-read, re-login, and `_nocache=1` all show the same post-delete values — no resurrection.
- **D (unrelated data):** TN2's number, SMS, CDR CLI 9201:1 and dashboard counts all intact; payment ledger rows preserved.

## Tests (all run in this sandbox)

| Suite | Result |
|---|---|
| `tests/p19c-verify.js` (NEW — FIX#1/#2/#3 + TEST A–D + jsdom client panel) | **57 / 57 PASS** |
| `tests/p19-verify.js` (regression) | 112 / 112 PASS |
| `tests/p19b-verify.js` (regression) | 35 / 35 PASS |
| `tests/p19-ui-verify.js` (regression, incl. client.html mobile/viewport checks) | 36 / 36 PASS |
| `scripts/check-html-scripts.js` × 4 panels | 0 FAIL |

UI verified via jsdom on a live server (desktop DOM) + static mobile checks (viewport, 7 media queries, `data-label` card layout). True visual browser rendering isn't possible in this sandbox — a quick look on your phone after deploy is the final confirmation.

## Unrelated functionality — unchanged

Admin/manager/agent dashboards, payment frequency, Rate Management, allocation rules (`handleAllocate` untouched — FIX#2 only *reads* what it stores), auth/permissions, SMS provider/webhook logic, payment ledger (immutable), CDR behaviour, filters/date behaviour, single-process architecture.

## Remaining issues / notes

- **Rebuild Stats (one time)** is still required on the VPS to clear pre-P19 stale residue — included in deploy steps below.
- Client "This Week Payout" reflects SMS-payout engine values (range-rate based), the same engine used for every other payout figure; the per-number allocation payout is a display field (FIX#2 column) by existing design — unchanged, per scope.
- No other open issues from these 3 fixes.

**Deploy (VPS):**
```bash
cd /opt/galaxy
git fetch && git reset --hard origin/main
npm install --omit=dev
pm2 restart galaxy     # (or the name from: pm2 list)
```

**After deploy (one time, if not already done for P19b):** Admin → Numbers → **Rebuild Stats** (🔄) → confirm. Then hard-refresh browsers (Ctrl+Shift+R).

**Verify (1 minute):** log in as a client → dashboard 4th card reads **This Week Payout** and shows only this week's amount → Numbers tab shows a **Payout** column with the agent's exact values ($0.00 / $1.00 / $2.00 / $0.013) → refresh page → values stable. As admin: delete a test number with OTP data → This Year OTPs and This Month Payout drop immediately and stay dropped after re-login/refresh.

---

# P19d — FIX AGAIN + FULL END-TO-END PROOF (Client Payout · Dashboard-After-Delete)

**This round the bugs were REPRODUCED FIRST, then fixed, then re-tested end-to-end through the real panels (jsdom UI + live API + direct DB). Reproduction script: `tests/p19d-repro.js` (kept as evidence). Full E2E suite: `tests/p19d-verify.js` — 63/63 PASS.**

**Files changed (P19d):**
| File | Change |
|---|---|
| `backend/server.js` | (1) `handleAllocate`: agent→client payout now ALWAYS written — empty/omitted ⇒ `'0'`. (2) smart-divide client allocation: explicit `payout='0'`. (3) `backfillSmsStats` (Rebuild Stats): stat_date keying now per-row `ukStatDate` (DST-safe) instead of one fixed SQL offset. |
| `tests/p19d-repro.js` | NEW — reproduces all 3 defects on the old code, passes after the fix |
| `tests/p19d-verify.js` | NEW — 63 E2E checks (real agent modal, real client panel, real admin panel, TEST A–D, phantom+rebuild, DST chain) |

**APIs changed:** behaviour of `POST /api/numbers/allocate` (agent payout-empty case) and `POST /api/admin/backfill-stats` (correct keying) — no new endpoints, no API contracts broken. **DB changes:** none (no schema change; `sms_daily_stats` content repaired by Rebuild Stats). `api.js` **unchanged** → no `?v=` bump needed. No frontend file changed in P19d.

## FIX#1 — Client allocation payout: exact value (owner's 6 cases)

1. **What was wrong:** the payout shown to a client could be a value from a PREVIOUS allocation (not the one actually applied to this allocation) when the Agent left the payout field empty.
2. **Exact root cause:** `handleAllocate` only wrote `numbers.payout` when the payout param was non-empty (`payout !== undefined && payout !== ''`). On empty it left the old value — so re-allocating a number (e.g. force move from client A to client B) kept client A's payout for client B. Reproduced: A gets `"2"`, force re-alloc to B with payout empty → B saw `"2"`.
3. **What changed:** agent→client allocation now always writes payout: empty/omitted ⇒ `'0'`, otherwise the exact entered string (`'0'`, `'1'`, `'2'`, `'0.013'` stored verbatim). Smart-divide/Range-Allocation (no payout input by design) explicitly sets `'0'`. No fallback to range/manager/agent/global rate anywhere — verified Range Management rate stayed `0.010` throughout. Rollback comments are in the code.
4. **Exact test performed (through the REAL agent panel UI — "Allocate Selected Numbers" modal, not just API):** for each case the suite checks the modal checkbox → opens the modal → types the payout → Allocate; then verifies **DB string → client API string → client panel rendered cell → full page reload**. Cases: field cleared (empty), `0`, `1`, `2`, `0.013`, plus two numbers with different payouts (`1` and `2`) on the same client, plus Range-Allocation (smart-divide) from its real page, plus force re-allocation with empty payout.
5. **Before (reproduced):** empty payout on re-allocation → new client inherited the OLD client's `"2"`; DB kept stale `"2"`. (The always-explicit cases 0/1/2/0.013 already stored exactly — P19c had verified that.)
6. **After (all PASS):** empty ⇒ `"0"`; `0` ⇒ `"0"`; `1` ⇒ `"1"`; `2` ⇒ `"2"`; `0.013` ⇒ `"0.013"`; NB1 `$1.00` and NB2 `$2.00` side-by-side, each its own; re-allocation with empty ⇒ new client sees `$0.00` (not `$2.00`); client panel shows `$0.00 / $0.00 / $1.00 / $2.00 / $0.013` exactly; Range-Allocation number ⇒ `$0.00`.
7. **After reload:** YES — a fresh client panel session (full re-login DOM) showed identical values (C-UI9).
8. **Remaining issue:** none for these cases. Note: `numbers.payout` values written by allocations made BEFORE this deploy keep whatever the old code stored — an agent can correct any number by unallocate → re-allocate with the intended payout (or force re-allocate).

## FIX#2 — Dashboard still showing old statistics after delete

1. **What was wrong:** after deleting a number + its OTP/SMS, CDR/SMS pages went clean but Admin Dashboard totals (This Year OTPs, This Month Payout, others) stayed stale — and **the same happened after running Rebuild Stats** for SMS received in the other DST half of the year.
2. **Exact root cause (two independent causes, both real):**
   - **(a) Historical residue (your live VPS):** dashboard cards read the pre-aggregated `sms_daily_stats` table; CDR reads `sms_records`. Deletes made under the PRE-P19 code removed `sms_records` but never decremented `sms_daily_stats` — those orphan "phantom" rows stay counted forever. New deletes decrement correctly, but they cannot remove residue for SMS that no longer exists — **only Rebuild Stats can** (it recomputes the whole table from live `sms_records`). This is why your dashboard can show 125,000 OTPs / $183 while CDR shows less.
   - **(b) Rebuild Stats DST bug (found this round, reproduced):** the rebuild keyed every historical row's `stat_date` using **today's** UK offset (`date(received_at, '+60 minutes')` in summer). A winter SMS at 23:30 GMT (correct UK date 15 Jan) was rebuilt onto 16 Jan. Ingest and delete use the per-row DST-correct `ukStatDate` — so after a rebuild, deleting that number decremented the CORRECT key while the stats row sat on the WRONG key: the row survived, and the dashboard kept counting deleted SMS. Reproduced end-to-end: rebuild put the row on `2026-01-16`; delete left it there; dashboard year stayed the same.
3. **What changed:** `backfillSmsStats` now groups rows with the SAME per-row `ukStatDate` function used by ingest (`recordSmsStats`) and by delete (`decrementSmsDailyStats`) — all three key sources can no longer disagree. Nothing was subtracted, hidden, or hardcoded; the dashboard still computes from `sms_daily_stats`, which is now guaranteed to equal a recomputation from live `sms_records` after Rebuild Stats. Payment ledger untouched (immutable history — it does not feed dashboard totals).
4. **Exact test performed:** owner's TEST A–D exactly — dedicated numbers `447500000001/2/3`, controlled SMS (3 today via the real webhook + 2 winter rows at the Jan 15 23:30 GMT boundary + 1 surviving winter row), before-values recorded (dashboard API, CDR per CLI, ledger row count, DB counts, and the ADMIN PANEL's rendered "This Year" card and "Payout — This Month" chip); then delete with `delete_sms:true` **through the panel's own API transport**; then cached reload / re-login / `_nocache` direct API / panel re-render; then unrelated-data checks; then a phantom-residue simulation (42,000 SMS + $99 inserted as pre-P19 residue) repaired via the panel's Rebuild Stats button path; then delete of a winter-row number AFTER rebuild to prove the rebuilt keys decrement correctly.
5. **Before (reproduced):** rebuild keyed the winter row `2026-01-15 23:30 UTC` as `2026-01-16`; after delete the row survived and the dashboard still counted it (year stayed unchanged). Phantom residue inflated year by 42,000 / payout by $99 with no way for deletes to remove it.
6. **After (all PASS):** TEST B — This Year OTPs 7→2 (−5: 3 today + 2 winter), This Month 4→1 (−3), This Month Payout 0.04→0.01 (−0.030 exactly the deleted this-month rows), today 4→1, total 7→2, winter stats row fully gone, no negative/leftover rows, ledger unchanged. TEST C — reload / re-login / `_nocache` / admin panel cards all identical post-delete values (no resurrection). TEST D — the other number's SMS/CDR/winter row intact, payouts intact, ledger intact. Phantom — after Rebuild Stats: year 42,002→2 == live `sms_records` count, payout 99.01→0.01 == live sum, winter row re-keyed to the correct `2026-01-15`. Delete-after-rebuild — year 2→1, winter row gone, **final dashboard == live sms_records exactly (dash=1, db=1)**.
7. **After reload:** YES — TEST C and the final panel assertions are post-reload/re-login reads.
8. **Remaining issue / ACTION REQUIRED ON VPS (one time):** the residue created by pre-P19 deletes on your live DB cannot be decremented by any delete (those SMS rows no longer exist). After deploying this bundle, run **Admin → Numbers → Rebuild Stats (🔄)** once. With the P19d fix the rebuild is now DST-correct, so it fully replaces `sms_daily_stats` with an exact recomputation from live data. If you already ran Rebuild Stats on the previous bundle, run it once more after this deploy (the old rebuild may have left winter-edge rows on shifted dates). Note: the panels also have a tiny 3-second client-side GET cache for `/dashboard` (cleared instantly on any panel action) — if you delete from one browser and stare at an already-open dashboard in another, it can lag ≤3 seconds; a page reload always shows fresh values.

## Tests (all run in this sandbox, single Node process + single SQLite file — architecture unchanged)

| Suite | Result |
|---|---|
| `tests/p19d-verify.js` (NEW — full E2E: real agent modal → DB → client panel → reload; TEST A–D; phantom+rebuild; DST chain) | **63 / 63 PASS** |
| `tests/p19d-repro.js` (NEW — bug reproduction; FAIL on old code, clean after fix) | documented evidence |
| `tests/p19-verify.js` | 112 / 112 PASS |
| `tests/p19b-verify.js` | 35 / 35 PASS |
| `tests/p19c-verify.js` | 57 / 57 PASS |
| `tests/p19-ui-verify.js` (incl. client.html mobile/viewport checks) | 36 / 36 PASS |
| `scripts/check-html-scripts.js` × 4 panels | 0 FAIL |

## Unrelated functionality — unchanged

Rate Management, payment frequency/eligibility engine, payment ledger (immutable), allocation rules (only the payout-write condition changed), auth/permissions, SMS provider/webhook logic, CDR behaviour, filters/date behaviour, admin/manager/agent dashboards' calculation source, single-process architecture. No frontend file was modified in P19d.

**Deploy (VPS):**
```bash
cd /opt/galaxy
git fetch && git reset --hard origin/main
npm install --omit=dev
pm2 restart galaxy     # (or the name from: pm2 list)
```

**After deploy (REQUIRED, one time):** Admin → Numbers → **Rebuild Stats** (🔄) → confirm. Then hard-refresh browsers (Ctrl+Shift+R).

**Verify on your live data (2 minutes):** after Rebuild Stats finishes, check Dashboard: This Year OTPs and This Month Payout should now match reality (CDR counts). Then delete one test number with OTP data (choose "delete associated SMS") → This Year OTPs and This Month Payout must drop immediately and stay dropped after re-login/refresh. As a client: Numbers tab shows each number's exact allocated payout, stable on refresh.
