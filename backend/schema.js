/**
 * Database schema — Multi-Level SMS Panel
 * Tables: users, ranges, numbers, sms_records, payments, cli_limits, integrations
 * Hierarchy: admin > manager > agent > client (via users.parent_id)
 */
const db = require('./db');

function ensureColumn(table, column, definition) {
  const cols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
  if (!cols.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,            -- bcrypt hash
    role       TEXT NOT NULL,            -- admin | manager | agent | client
    name       TEXT DEFAULT '',
    email      TEXT DEFAULT '',
    whatsapp   TEXT DEFAULT '',
    contact    TEXT DEFAULT '',
    skype      TEXT DEFAULT '',
    parent_id  INTEGER,                  -- kis manager/agent ke neeche
    active     INTEGER DEFAULT 1,        -- 1 = active, 0 = disabled
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    prefix      TEXT DEFAULT '',
    test_number TEXT DEFAULT '',
    currency    TEXT DEFAULT 'USD',
    rate_1_1    TEXT DEFAULT 'NA',
    rate_7_1    TEXT DEFAULT 'NA',
    rate_7_7    TEXT DEFAULT 'NA',
    rate_30_45  TEXT DEFAULT 'NA',
    memo        TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  )`);



  db.run(`CREATE TABLE IF NOT EXISTS range_test_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    range_id INTEGER NOT NULL,
    test_number TEXT NOT NULL,
    label TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (range_id) REFERENCES ranges(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    range_id   INTEGER NOT NULL,
    number     TEXT NOT NULL,
    prefix     TEXT DEFAULT '',
    rate       TEXT DEFAULT '',
    payterm    TEXT DEFAULT 'Weekly',
    payout     TEXT DEFAULT '0',
    -- ownership chain (kisi bhi level par assigned ho sakta hai)
    manager_id INTEGER,
    agent_id   INTEGER,
    client_id  INTEGER,
    sd_limit   INTEGER DEFAULT 0,
    sw_limit   INTEGER DEFAULT 0,
    import_batch_id TEXT DEFAULT '',
    import_source TEXT DEFAULT '',
    imported_by INTEGER,
    imported_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (range_id) REFERENCES ranges(id)
  )`);


  db.run(`CREATE TABLE IF NOT EXISTS number_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT UNIQUE NOT NULL,
    range_id INTEGER,
    range_name TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    total INTEGER DEFAULT 0,
    inserted INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    status TEXT DEFAULT 'processing', -- processing | done | failed | deleted
    error TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    deleted_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sms_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number_id  INTEGER,
    number     TEXT,
    range_id   INTEGER,
    cli        TEXT DEFAULT '',
    sender_type TEXT DEFAULT '',
    message    TEXT DEFAULT '',
    otp_code   TEXT DEFAULT '',
    is_otp     INTEGER DEFAULT 1,
    client_id  INTEGER,
    agent_id   INTEGER,
    manager_id INTEGER,
    is_test INTEGER DEFAULT 0,
    test_batch_id TEXT DEFAULT '',
    source TEXT DEFAULT 'carrier',
    payout_rate TEXT DEFAULT '',
    payout_amount TEXT DEFAULT '',
    received_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cli_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cli        TEXT NOT NULL,
    type       TEXT DEFAULT 'overall',   -- overall | specific
    manager_id INTEGER,                   -- specific ke liye
    limit_val  INTEGER DEFAULT 0,
    used       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);





  db.run(`CREATE TABLE IF NOT EXISTS payment_v2_settings (
    payment_type TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    min_withdrawal TEXT DEFAULT '0',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  const payTypes = [
    ['daily','Daily','0',1,1],
    ['weekly','Weekly','0',1,2],
    ['monthly_30x45','Monthly (30x45)','0',1,3]
  ];
  payTypes.forEach(r => {
    const ex = db.get('SELECT payment_type FROM payment_v2_settings WHERE payment_type=?', [r[0]]);
    if (!ex) db.run('INSERT INTO payment_v2_settings (payment_type,label,min_withdrawal,active,sort_order) VALUES (?,?,?,?,?)', r);
  });

  db.run(`CREATE TABLE IF NOT EXISTS agent_wallets (
    agent_id INTEGER PRIMARY KEY,
    wallet_address TEXT DEFAULT '',
    network TEXT DEFAULT 'USDT_TRC20',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sms_record_id INTEGER UNIQUE,
    agent_id INTEGER NOT NULL,
    manager_id INTEGER,
    range_id INTEGER,
    payment_type TEXT NOT NULL,
    amount TEXT DEFAULT '0',
    earned_at TEXT DEFAULT '',
    cycle_key TEXT DEFAULT '',
    eligible_at TEXT DEFAULT '',
    status TEXT DEFAULT 'open', -- open | requested | paid | rejected
    request_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_requests_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    manager_id INTEGER,
    payment_type TEXT NOT NULL,
    amount TEXT DEFAULT '0',
    wallet_address TEXT NOT NULL,
    status TEXT DEFAULT 'Pending', -- Pending | Paid | Rejected
    requested_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    rejected_at TEXT,
    processed_by INTEGER,
    txid TEXT DEFAULT '',
    screenshot_url TEXT DEFAULT '',
    admin_notes TEXT DEFAULT '',
    reject_reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_name TEXT DEFAULT '',
    actor_role TEXT DEFAULT '',
    action TEXT NOT NULL,
    request_id INTEGER,
    agent_id INTEGER,
    manager_id INTEGER,
    payment_type TEXT DEFAULT '',
    amount TEXT DEFAULT '',
    wallet_address TEXT DEFAULT '',
    status TEXT DEFAULT '',
    details TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sharing_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_user_id INTEGER UNIQUE NOT NULL,
    panel_name TEXT NOT NULL,
    user_name TEXT DEFAULT '',
    username TEXT NOT NULL,
    attribute_url TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sharing_forward_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sharing_user_id INTEGER,
    sms_record_id INTEGER,
    url TEXT DEFAULT '',
    status TEXT DEFAULT '',
    error TEXT DEFAULT '',
    response_preview TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_notifications_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    request_id INTEGER,
    event TEXT DEFAULT '',
    message TEXT DEFAULT '',
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT DEFAULT '',
    role TEXT DEFAULT '',
    action TEXT NOT NULL,
    module TEXT DEFAULT '',
    details TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS number_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number_id INTEGER,
    number TEXT DEFAULT '',
    action TEXT NOT NULL,
    from_owner TEXT DEFAULT '',
    to_owner TEXT DEFAULT '',
    details TEXT DEFAULT '',
    user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT DEFAULT 'success',
    number TEXT DEFAULT '',
    matched_number TEXT DEFAULT '',
    cli TEXT DEFAULT '',
    message TEXT DEFAULT '',
    raw_payload TEXT DEFAULT '{}',
    error TEXT DEFAULT '',
    source_ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS failed_sms_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT DEFAULT '',
    cli TEXT DEFAULT '',
    message TEXT DEFAULT '',
    raw_payload TEXT DEFAULT '{}',
    error TEXT DEFAULT '',
    source_ip TEXT DEFAULT '',
    status TEXT DEFAULT 'Pending',       -- Pending | Retried | Ignored
    retry_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);




  db.run(`CREATE TABLE IF NOT EXISTS carrier_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_status TEXT DEFAULT 'disabled', -- enabled | disabled
    carrier_ip TEXT DEFAULT '',
    http_callback_url TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    auth_token TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    retention_days INTEGER DEFAULT 30,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  ensureColumn('webhook_logs', 'source_ip', "TEXT DEFAULT ''");
  ensureColumn('carrier_settings', 'retention_days', 'INTEGER DEFAULT 30');
  // GALAXY: Range/Rate Management fields (additive, all optional)
  ensureColumn('ranges', 'country', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'provider', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'currency_rate', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'cli_limit', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'range_start', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'range_end', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'status', "TEXT DEFAULT 'Active'");
  // GALAXY: Activity Integration entries (Provider Name + IP allowlist)
  db.run(`CREATE TABLE IF NOT EXISTS activity_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_name TEXT DEFAULT '',
    ip TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_activity_ips_enabled ON activity_ips(enabled)`);
  // GALAXY: Provider-level registry (relationship/payment/reporting — credentials stay in connections)
  db.run(`CREATE TABLE IF NOT EXISTS galaxy_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    payment_term TEXT DEFAULT '',
    currency TEXT DEFAULT 'USD',
    rate TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  ensureColumn('sms_records', 'is_test', 'INTEGER DEFAULT 0');
  ensureColumn('sms_records', 'test_batch_id', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'source', "TEXT DEFAULT 'carrier'");
  ensureColumn('sms_records', 'sender_type', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'otp_code', "TEXT DEFAULT ''");
  ensureColumn('users', 'payment_type', "TEXT DEFAULT 'weekly'");
  ensureColumn('sms_records', 'payment_type', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'payment_type', "TEXT DEFAULT 'weekly'");
  ensureColumn('numbers', 'import_batch_id', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'import_source', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'imported_by', 'INTEGER');
  ensureColumn('numbers', 'imported_at', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'payout_rate', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'payout_amount', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'limit_reason', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'deleted_at', "TEXT DEFAULT ''");

  const cs = db.get('SELECT COUNT(*) AS c FROM carrier_settings');
  if (!cs || cs.c === 0) {
    db.run(`INSERT INTO carrier_settings (integration_status,carrier_ip,http_callback_url,notes)
            VALUES ('disabled','','/api/incoming-sms','HTTP integration ready')`);
  }



  db.run(`CREATE TABLE IF NOT EXISTS daily_limit_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    limit_type TEXT NOT NULL, -- range | number | cli
    range_id INTEGER,
    cli TEXT DEFAULT '',
    number TEXT DEFAULT '',
    daily_limit INTEGER NOT NULL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS api_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    method TEXT DEFAULT 'GET',
    auth_type TEXT DEFAULT 'query_token', -- query_token | bearer | header | none
    token TEXT DEFAULT '',
    token_param TEXT DEFAULT 'token',
    token_header TEXT DEFAULT 'Authorization',
    dt1_param TEXT DEFAULT 'dt1',
    dt2_param TEXT DEFAULT 'dt2',
    records_param TEXT DEFAULT 'records',
    records_limit INTEGER DEFAULT 100,
    poll_interval_sec INTEGER DEFAULT 5,
    response_format TEXT DEFAULT 'auto',
    last_poll_at TEXT,
    last_success_at TEXT,
    last_error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS api_integration_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_id INTEGER,
    duplicate_key TEXT UNIQUE NOT NULL,
    provider_message_id TEXT DEFAULT '',
    first_seen_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS api_integration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_id INTEGER,
    integration_name TEXT DEFAULT '',
    request_time TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT '', -- success | failed | duplicate | ignored
    reason TEXT DEFAULT '',
    number TEXT DEFAULT '',
    cli TEXT DEFAULT '',
    message TEXT DEFAULT '',
    provider_message_id TEXT DEFAULT '',
    duplicate_key TEXT DEFAULT '',
    raw_json TEXT DEFAULT '',
    sms_record_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);


  /* ===== SMPP connections (additional channel, independent of HTTP/API) =====
   *
   * This is a SEPARATE channel from the HTTP callback (/api/incoming-sms) and
   * from the HTTP provider pull (sync_providers). Nothing here is read by
   * those two paths, and they read nothing from here, so the existing
   * integrations keep working byte-for-byte as before.
   *
   * mode:
   *   'client' = Power X binds OUT to the provider's SMPP server (ESME).
   *   'server' = Power X LISTENS on a port and the carrier binds IN to us.
   */
  db.run(`CREATE TABLE IF NOT EXISTS smpp_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'client',      -- client | server
    active INTEGER NOT NULL DEFAULT 0,

    -- client mode (outbound bind to provider)
    host TEXT DEFAULT '',
    port INTEGER DEFAULT 2775,
    system_id TEXT DEFAULT '',
    password TEXT DEFAULT '',
    system_type TEXT DEFAULT '',
    bind_type TEXT DEFAULT 'transceiver',     -- transceiver | receiver | transmitter
    address_range TEXT DEFAULT '',
    use_tls INTEGER NOT NULL DEFAULT 0,

    -- server mode (inbound: carrier binds to us)
    listen_port INTEGER DEFAULT 0,
    allowed_ips TEXT DEFAULT '',              -- comma separated; empty = any

    -- tuning
    enquire_link_seconds INTEGER NOT NULL DEFAULT 30,
    reconnect_seconds INTEGER NOT NULL DEFAULT 10,
    max_reconnect_seconds INTEGER NOT NULL DEFAULT 300,
    connect_timeout_ms INTEGER NOT NULL DEFAULT 15000,
    default_source_addr TEXT DEFAULT '',
    notes TEXT DEFAULT '',

    -- runtime state (written by the SMPP service, read by the UI)
    status TEXT DEFAULT 'stopped',            -- stopped|connecting|bound|listening|error
    last_error TEXT DEFAULT '',
    last_connected_at TEXT DEFAULT '',
    last_activity_at TEXT DEFAULT '',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_received INTEGER NOT NULL DEFAULT 0,
    total_sent INTEGER NOT NULL DEFAULT 0,

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Deduplication ledger for inbound SMPP messages. Same idea as sync_seen:
  // the UNIQUE index is what makes a redelivered PDU safe to ignore.
  db.run(`CREATE TABLE IF NOT EXISTS smpp_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    dedup_key TEXT NOT NULL,
    sms_record_id INTEGER,
    received_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_smpp_seen_unique ON smpp_seen(connection_id, dedup_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_smpp_seen_created ON smpp_seen(created_at)`);

  // Event log: bind/unbind/error/reconnect/received/sent. Kept small by the service.
  db.run(`CREATE TABLE IF NOT EXISTS smpp_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER,
    connection_name TEXT DEFAULT '',
    event TEXT DEFAULT '',                    -- bind|unbind|error|reconnect|deliver|submit|listen
    level TEXT DEFAULT 'info',                -- info | warn | error
    detail TEXT DEFAULT '',
    peer TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_smpp_logs_conn ON smpp_logs(connection_id, id)`);

  // Outbound queue for submit_sm. A message is only marked sent once the
  // provider returns a submit_sm_resp, so a dropped link never loses it.
  db.run(`CREATE TABLE IF NOT EXISTS smpp_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    destination TEXT NOT NULL,
    source_addr TEXT DEFAULT '',
    message TEXT DEFAULT '',
    status TEXT DEFAULT 'queued',             -- queued|sent|failed
    provider_message_id TEXT DEFAULT '',
    error TEXT DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_smpp_outbox_status ON smpp_outbox(status, id)`);

  db.run(`CREATE TABLE IF NOT EXISTS system_security (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_security_code TEXT DEFAULT 'Dawood',
    carrier_lock_password TEXT DEFAULT 'Dawood',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  ensureColumn('system_security', 'carrier_lock_password', "TEXT DEFAULT 'Dawood'");
  // Callback providers (IKANGOO-style) send a unique {id} per SMS. Storing the
  // resulting sms_records.id lets a retried callback return the original row
  // instead of inserting - and paying for - the same message twice.
  ensureColumn('api_integration_seen', 'sms_record_id', 'INTEGER');
  const sc = db.get('SELECT COUNT(*) AS c FROM system_security');
  if (!sc || sc.c === 0) {
    db.run(`INSERT INTO system_security (admin_security_code) VALUES ('Dawood')`);
  }


  // Performance indexes for analytics/search/reporting.
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_cli ON sms_records(cli)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_received_at ON sms_records(received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_cli_received ON sms_records(cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_manager_cli_date ON sms_records(manager_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_agent_cli_date ON sms_records(agent_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_client_cli_date ON sms_records(client_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_range_cli_date ON sms_records(range_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_number_cli_date ON sms_records(number, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_test_date ON sms_records(is_test, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_manager_date ON sms_records(manager_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_agent_date ON sms_records(agent_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_client_date ON sms_records(client_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_range_date ON sms_records(range_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_number_date ON sms_records(number, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ranges_name_nocase ON ranges(name COLLATE NOCASE)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_import_batch ON numbers(import_batch_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_import_source ON numbers(import_source)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_number ON numbers(number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_clean_phone ON numbers(REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_',''))`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_range_test_numbers_range_clean_phone ON range_test_numbers(range_id, REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_',''))`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_range_test_numbers_number ON range_test_numbers(test_number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_range ON numbers(range_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_manager ON numbers(manager_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_agent ON numbers(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_client ON numbers(client_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_manager_range_number ON numbers(manager_id, range_id, number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_agent_range_number ON numbers(agent_id, range_id, number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_client_range_number ON numbers(client_id, range_id, number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_type_active ON daily_limit_rules(limit_type, active)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_range ON daily_limit_rules(range_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_cli ON daily_limit_rules(cli)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_number ON daily_limit_rules(number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_integrations_enabled ON api_integrations(enabled)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_seen_key ON api_integration_seen(duplicate_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_logs_integration ON api_integration_logs(integration_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_logs_status ON api_integration_logs(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_failed_sms_created ON failed_sms_queue(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_failed_sms_number_clean ON failed_sms_queue(REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_',''))`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_ledger_agent_type_status ON payment_ledger(agent_id, payment_type, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_ledger_eligible ON payment_ledger(payment_type, eligible_at, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_agent_type_status ON payment_requests_v2(agent_id, payment_type, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests_v2(status, requested_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_notifications_agent ON payment_notifications_v2(agent_id, read_at, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sharing_users_agent ON sharing_users(agent_user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sharing_users_active ON sharing_users(active)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sharing_forward_logs_sms ON sharing_forward_logs(sms_record_id)`);

  /* ===== Background Provider Sync (external API -> local DB) ===== */

  // One row per external provider. Each keeps its OWN cursor and config,
  // so new providers can be added without touching the panels.
  db.run(`CREATE TABLE IF NOT EXISTS sync_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    connector TEXT NOT NULL DEFAULT 'generic_json',
    config_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 0,
    interval_seconds INTEGER NOT NULL DEFAULT 12,
    overlap_seconds INTEGER NOT NULL DEFAULT 30,
    last_sync_at TEXT DEFAULT '',
    last_status TEXT DEFAULT '',
    last_error TEXT DEFAULT '',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Deduplication ledger. The UNIQUE index is what makes the overlap window
  // safe: a record seen in the overlap can never be inserted twice.
  db.run(`CREATE TABLE IF NOT EXISTS sync_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER NOT NULL,
    provider_ref TEXT NOT NULL,
    received_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_seen_unique ON sync_seen(provider_id, provider_ref)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_seen_received ON sync_seen(received_at)`);

  // Per-cycle audit trail (kept small by the service).
  db.run(`CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER,
    status TEXT DEFAULT '',
    fetched INTEGER DEFAULT 0,
    inserted INTEGER DEFAULT 0,
    duplicates INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_logs_provider ON sync_logs(provider_id, id)`);


  /* =========================================================================
   * PHASE-1 SCHEMA ADDITIONS (all additive / IF NOT EXISTS — safe on boot)
   * ========================================================================= */

  // 1) numbers.number UNIQUE — DB-level dedup (import can use INSERT OR IGNORE).
  //    Skipped with a warning if legacy duplicate rows exist; clean them first.
  try {
    const dup = db.get(`SELECT number, COUNT(*) c FROM numbers GROUP BY number HAVING c > 1 LIMIT 1`);
    if (dup) {
      console.warn('[MIGRATION] Duplicate numbers exist — UNIQUE index NOT created. Clean duplicates first.');
    } else {
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_numbers_number_unique ON numbers(number)`);
    }
  } catch (e) { console.warn('[MIGRATION] numbers unique check failed:', e.message); }

  // 2) number_history indexes (had ZERO indexes — full scans on listing + purge)
  db.run(`CREATE INDEX IF NOT EXISTS idx_nh_number_created ON number_history(number_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_nh_created ON number_history(created_at)`);

  // 3) SMS keyset/recent index (received_at DESC scans)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_received_id ON sms_records(received_at DESC, id)`);

  // 4) Unallocated fast-filter (partial indexes — tiny and hot)
  //    (range_id, number): filter+group   |   (number): ORDER BY number LIMIT → instant first pages
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_unallocated ON numbers(range_id, number)
    WHERE manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_unallocated_number ON numbers(number)
    WHERE manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL`);

  // 5) Version counters for cache invalidation (numbers_ver / sms_ver / users_ver)
  db.run(`CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // 6) Idempotency keys (double-submit/retry protection for allocation etc.)
  db.run(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    key           TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    endpoint      TEXT NOT NULL,
    response_json TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    expires_at    TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at)`);

  // 7) Pre-aggregated daily SMS stats (dashboard + user-dimension reports).
  //    One row per UK-date × owner-chain × CLI. -1 sentinel = NULL owner.
  //    Dashboard reads this instead of scanning sms_records.
  db.run(`CREATE TABLE IF NOT EXISTS sms_daily_stats (
    stat_date  TEXT NOT NULL,
    manager_id INTEGER NOT NULL DEFAULT -1,
    agent_id   INTEGER NOT NULL DEFAULT -1,
    client_id  INTEGER NOT NULL DEFAULT -1,
    cli        TEXT NOT NULL DEFAULT '',
    sms_count  INTEGER NOT NULL DEFAULT 0,
    payout_sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (stat_date, manager_id, agent_id, client_id, cli)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sds_manager_date ON sms_daily_stats(manager_id, stat_date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sds_agent_date   ON sms_daily_stats(agent_id, stat_date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sds_client_date  ON sms_daily_stats(client_id, stat_date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sds_date         ON sms_daily_stats(stat_date)`);

  // 8) PHASE-2: durable background jobs (exports, big imports, reports).
  //    Restart-safe: workers poll this table; progress survives process restarts.
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    progress     INTEGER DEFAULT 0,
    processed    INTEGER DEFAULT 0,
    total        INTEGER DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json  TEXT,
    error        TEXT DEFAULT '',
    created_by   INTEGER,
    created_at   TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(created_by, created_at)`);

}

module.exports = { createTables };
