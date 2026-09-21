# Power X SMS — Background Provider Sync

```
Provider API  ->  Background Sync Service  ->  Local Database
                                                     |
                                        Power X Backend (/api/*)
                                                     |
                        Admin / Manager / Agent / Client panels
```

**Panels never call a provider API.** They only read the local database through
the existing endpoints. Only `backend/providerSync.js` talks to providers.

---

## How it works

1. A scheduler tick runs every `SYNC_INTERVAL_SECONDS` (default 12s).
2. Each active provider is polled on its own `interval_seconds`.
3. The connector requests only records newer than
   `last_sync_at − overlap_seconds` (default 30s safety window).
4. Every record is deduplicated on `(provider_id, provider_ref)` using a
   **UNIQUE index**, so the overlap can never create duplicates.
5. New records go through `processIncomingSmsPayload()` — the same function the
   live carrier webhook uses — so allocation, payout, OTP extraction, CLI limits
   and role scoping behave identically.
6. The whole batch is written in **one transaction** (`beginBatch`/`endBatch`),
   then the API read cache is cleared so all panels see the data immediately.
7. The cursor advances **only on success**. A failed cycle leaves it untouched,
   so nothing is ever skipped.

### No duplicates, no missed records

| Risk | Protection |
|---|---|
| Record written just before the cursor | `overlap_seconds` rewind |
| Overlap re-delivers the same record | `UNIQUE(provider_id, provider_ref)` |
| Provider down / network error | Cursor not advanced; retried next tick |
| Repeated failures hammering the API | Exponential backoff, capped at 5 min |
| Slow provider blocking others | Each provider syncs independently |
| Overlapping cycles on one provider | `inFlight` guard |

---

## Database

| Table | Purpose |
|---|---|
| `sync_providers` | One row per provider: connector, config, interval, overlap, cursor, health |
| `sync_seen` | Dedup ledger. `UNIQUE(provider_id, provider_ref)` |
| `sync_logs` | Per-cycle audit (fetched / inserted / duplicates / failed / duration), auto-trimmed to 2000 rows |

Indexes: `idx_sync_seen_unique`, `idx_sync_seen_received`, `idx_sync_logs_provider`.

---

## Configuration

**Environment**

```bash
SYNC_ENABLED=true            # false disables the whole service
SYNC_INTERVAL_SECONDS=12     # scheduler tick (min 5)
```

**Per provider** — `interval_seconds`, `overlap_seconds`, `active`, plus a
`config_json` describing the endpoint:

```json
{
  "url": "https://provider.tld/api/messages",
  "method": "GET",
  "auth": "bearer",
  "token": "YOUR_API_TOKEN",
  "since_param": "start_date",
  "since_format": "sql",
  "limit_param": "limit",
  "limit": 500,
  "records_path": "data.messages",
  "map": {
    "ref": "message_id",
    "number": "to",
    "cli": "from",
    "message": "text",
    "date": "created_at"
  }
}
```

| Field | Notes |
|---|---|
| `auth` | `bearer` · `header` (+`auth_header`) · `query` (+`auth_query`) · `none` |
| `since_format` | `sql` · `iso` · `epoch` · `epoch_ms` |
| `records_path` | Dotted path to the array. Omit to auto-detect `data`/`results`/`messages` |
| `map` | Provider field → Power X field. `ref` **must** be the provider's unique id |
| `extra_params` | Any additional fixed query parameters |
| `timeout_ms` | Request timeout, default 20000 |

---

## Admin API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/sync/status` | Service + per-provider health |
| GET | `/api/sync/providers` | List (token masked) |
| POST | `/api/sync/providers` | Create |
| PUT | `/api/sync/providers/:id` | Update (send `********` to keep the token) |
| DELETE | `/api/sync/providers/:id` | Remove + clear its dedup ledger |
| POST | `/api/sync/providers/:id/run` | Run one cycle now |
| POST | `/api/sync/providers/:id/run?full=1` | Manual full resync (ignores cursor) |
| POST | `/api/sync/providers/:id/reset` | Clear cursor + dedup ledger |
| GET | `/api/sync/logs` | Recent cycles |

All require an **admin** token.

### Register a provider

```bash
curl -X POST http://localhost:4000/api/sync/providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name":"MyProvider","connector":"generic_json","active":1,
    "interval_seconds":12,"overlap_seconds":30,
    "config_json":"{\"url\":\"https://provider.tld/api/messages\",\"auth\":\"bearer\",\"token\":\"XXX\",\"since_param\":\"start_date\",\"records_path\":\"data.messages\",\"map\":{\"ref\":\"message_id\",\"number\":\"to\",\"cli\":\"from\",\"message\":\"text\",\"date\":\"created_at\"}}"
  }'
```

---

## Adding a new provider

**Most providers need no code** — just register a row with the right
`config_json`. The `generic_json` connector covers URL + token + JSON.

If a provider needs custom logic (XML, pagination, signed requests), add one
entry to `CONNECTORS` in `providerSync.js`:

```js
CONNECTORS.my_provider = async function (cfg, sinceSql, log) {
  // fetch however this provider requires
  return rows.map(r => ({
    ref: r.uniqueId,      // REQUIRED - drives deduplication
    number: r.msisdn,
    cli: r.sender,
    message: r.body,
    date: r.timestamp,
  }));
};
```

Then set `"connector": "my_provider"`. **No panel, API or database change is
required** — each provider keeps its own config and cursor.

---

## Verified behaviour

Tested against a mock provider:

```
run 1  (5 records)        fetched=5 inserted=5 duplicates=0
run 2  (immediate repeat) fetched=5 inserted=0 duplicates=5   no duplicates
+4 new on provider        fetched=9 inserted=4 duplicates=5   incremental
full resync (?full=1)     fetched=9 inserted=0 duplicates=9   dedup holds
automatic polling         3 new records appeared within 5s, unattended
incremental cursor        later cycle fetched only 4, not all 9
provider offline          ok:false, cursor preserved, 0 data loss, panel fine
```

**Performance impact: none.** With sync running: frame p95 16.7 ms, 0 dropped
frames, 0 DOM growth over 20s, heap flat at 9.5 MB.
