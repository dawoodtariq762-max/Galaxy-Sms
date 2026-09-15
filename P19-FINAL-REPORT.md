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
