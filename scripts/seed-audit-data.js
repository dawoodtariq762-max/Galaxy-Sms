const fs = require('fs');
const path = require('path');
const db = require('../backend/db');
db.init();

console.log('--- Seeding Comprehensive Audit Dataset ---');

// 1. Create 4 Realistic Ranges if not present
const rangesData = [
  { name: 'UK Mobile O2', prefix: '4471', currency: 'USD', rate_1_1: '0.0050', rate_7_1: '0.0075', rate_7_7: '0.0085', rate_30_45: '0.0110', provider: 'Vodafone Carrier' },
  { name: 'US T-Mobile Fast', prefix: '1202', currency: 'USD', rate_1_1: '0.0040', rate_7_1: '0.0060', rate_7_7: '0.0070', rate_30_45: '0.0090', provider: 'T-Mobile US' },
  { name: 'Germany Vodafone', prefix: '4915', currency: 'EUR', rate_1_1: '0.0060', rate_7_1: '0.0080', rate_7_7: '0.0090', rate_30_45: '0.0120', provider: 'Deutsche Tel' },
  { name: 'PK Jazz Telecom', prefix: '9230', currency: 'USD', rate_1_1: '0.0030', rate_7_1: '0.0045', rate_7_7: '0.0055', rate_30_45: '0.0070', provider: 'Jazz Direct' }
];

const rangeIds = [];
for (const rd of rangesData) {
  let existing = db.get("SELECT id FROM ranges WHERE name=?", [rd.name]);
  if (!existing) {
    db.run(
      "INSERT INTO ranges (name, prefix, pattern, currency, rate_1_1, rate_7_1, rate_7_7, rate_30_45, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')",
      [rd.name, rd.prefix, rd.prefix, rd.currency, rd.rate_1_1, rd.rate_7_1, rd.rate_7_7, rd.rate_30_45, rd.provider]
    );
    existing = db.get("SELECT id FROM ranges WHERE name=?", [rd.name]);
  }
  rangeIds.push(existing.id);
}
console.log('Ranges ready:', rangeIds);

// 2. Resolve users for allocation distribution
const mgr = db.get("SELECT id FROM users WHERE role='manager' LIMIT 1") || { id: 1 };
const agt = db.get("SELECT id FROM users WHERE role='agent' LIMIT 1") || { id: 2 };
const cli = db.get("SELECT id FROM users WHERE role='client' LIMIT 1") || { id: 44 };

// 3. Seed Numbers (60,000 numbers total across ranges)
const currentNumbersCount = db.get("SELECT COUNT(*) c FROM numbers").c;
console.log('Current numbers count:', currentNumbersCount);

const TARGET_NUMBERS = 60000;
if (currentNumbersCount < TARGET_NUMBERS) {
  const needed = TARGET_NUMBERS - currentNumbersCount;
  console.log(`Inserting ${needed} numbers in batches of 10,000...`);
  const BATCH_SIZE = 10000;
  let inserted = 0;
  
  while (inserted < needed) {
    const curBatch = Math.min(BATCH_SIZE, needed - inserted);
    const rows = [];
    for (let i = 0; i < curBatch; i++) {
      const idx = currentNumbersCount + inserted + i;
      const rid = rangeIds[idx % rangeIds.length];
      const pfx = rangesData[idx % rangesData.length].prefix;
      const num = `${pfx}${String(10000000 + idx).slice(1)}`;
      
      // Distribute ownership:
      // 30% unallocated (for allocation testing)
      // 25% Admin -> Manager
      // 25% Admin -> Manager -> Agent
      // 20% Admin -> Manager -> Agent -> Client
      let mId = 'NULL', aId = 'NULL', cId = 'NULL', rate = '0.0075', payout = '0.0065', payterm = 'weekly_7_1';
      const mod = idx % 10;
      if (mod < 3) {
        // unallocated
      } else if (mod < 5) {
        mId = mgr.id;
      } else if (mod < 8) {
        mId = mgr.id; aId = agt.id;
      } else {
        mId = mgr.id; aId = agt.id; cId = cli.id; payout = '0.0065';
      }
      rows.push(`(${rid}, '${num}', '${pfx}', '${rate}', '${payterm}', '${payout}', ${mId}, ${aId}, ${cId}, 'manual')`);
    }

    db.exec('BEGIN IMMEDIATE');
    db.execNoSave(
      `INSERT INTO numbers (range_id, number, prefix, rate, payterm, payout, manager_id, agent_id, client_id, alloc_source) VALUES ${rows.join(',')}`
    );
    db.exec('COMMIT');
    inserted += curBatch;
    console.log(`  Inserted ${inserted} / ${needed} numbers...`);
  }
}

const finalNumbersCount = db.get("SELECT COUNT(*) c FROM numbers").c;
console.log('Total numbers in database now:', finalNumbersCount);

// 4. Seed SMS Records (30,000 CDR records total)
const currentSmsCount = db.get("SELECT COUNT(*) c FROM sms_records").c;
console.log('Current SMS records count:', currentSmsCount);

const TARGET_SMS = 30000;
if (currentSmsCount < TARGET_SMS) {
  const needed = TARGET_SMS - currentSmsCount;
  console.log(`Inserting ${needed} CDR records in batches of 10,000...`);
  const BATCH_SIZE = 10000;
  let inserted = 0;

  const clis = ['GOOGLE', 'WHATSAPP', 'TELEGRAM', 'TIKTOK', 'MICROSOFT', 'BINANCE', 'UBER', 'FACEBOOK', 'AMAZON', 'NETFLIX'];
  const sampleNumbers = db.all("SELECT id, number, range_id, manager_id, agent_id, client_id, payout, payterm FROM numbers LIMIT 5000");

  while (inserted < needed) {
    const curBatch = Math.min(BATCH_SIZE, needed - inserted);
    const rows = [];
    const now = Date.now();

    for (let i = 0; i < curBatch; i++) {
      const idx = currentSmsCount + inserted + i;
      const numObj = sampleNumbers[idx % sampleNumbers.length];
      const cliName = clis[idx % clis.length];
      const otp = String(100000 + (idx % 900000));
      const msg = `Your ${cliName} authentication code is ${otp}. Valid for 5 minutes.`;
      
      // Generate dates spanning the last 14 days
      const daysAgo = (idx % 14);
      const minutesAgo = (idx * 3) % 1440;
      const smsDate = new Date(now - (daysAgo * 86400000) - (minutesAgo * 60000));
      const dateStr = smsDate.toISOString().replace('T', ' ').slice(0, 19);

      const mId = numObj.manager_id != null ? numObj.manager_id : 'NULL';
      const aId = numObj.agent_id != null ? numObj.agent_id : 'NULL';
      const cId = numObj.client_id != null ? numObj.client_id : 'NULL';
      const po = numObj.payout || '0.0065';
      const pt = numObj.payterm || 'weekly_7_1';

      rows.push(`(${numObj.id}, ${numObj.range_id}, ${mId}, ${aId}, ${cId}, '${numObj.number}', '${cliName}', '${msg}', '${otp}', 1, '${po}', '${po}', '${pt}', '${dateStr}')`);
    }

    db.exec('BEGIN IMMEDIATE');
    db.execNoSave(
      `INSERT INTO sms_records (number_id, range_id, manager_id, agent_id, client_id, number, cli, message, otp_code, is_otp, payout_rate, payout_amount, payment_type, received_at) VALUES ${rows.join(',')}`
    );
    db.exec('COMMIT');
    inserted += curBatch;
    console.log(`  Inserted ${inserted} / ${needed} SMS records...`);
  }
}

const finalSmsCount = db.get("SELECT COUNT(*) c FROM sms_records").c;
console.log('Total SMS records in database now:', finalSmsCount);

// Run ANALYZE to update SQLite query planner statistics
console.log('Running SQLite ANALYZE for query optimizer statistics...');
db.exec('ANALYZE');
console.log('✅ Audit dataset seeding complete and ready for testing!');
