require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const files = [
  'create_staff_permission.sql',
  'create_staff_basket_access.sql',
  'alter_pos_basket_doc_format.sql',
  '20260909_sale_premium_and_backlog.sql',
  '20261005_sml_promotion_backlog.sql',
  '20261005_staff_cart_order_item_basket_idx.sql',
  '20261007_sale_premium_backlog_cancel.sql',
  '20261028_sale_claim.sql',
];

const pool = new Pool({
  host: String(process.env.DB_HOST || '').replace(/^https?:\/\//, ''),
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});

async function main() {
  if (process.argv[2] !== '--apply' || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Use --apply with DB_NAME=wawacrm for this test migration run');
  }
  const client = await pool.connect();
  try {
    const health = await client.query('SELECT current_database() AS db, pg_is_in_recovery() AS replica');
    if (health.rows[0].db !== 'wawacrm' || health.rows[0].replica) throw new Error('target database is not writable wawacrm');
    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations', file), 'utf8').replace(/^\uFEFF/, '');
      await client.query(sql);
      console.log('applied', file);
    }
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error('migration failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
