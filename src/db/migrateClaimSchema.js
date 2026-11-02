const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../db');

async function migrateClaimSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sml_staff_claim_schema'))");
    for (const file of ['20261028_sale_claim.sql', '20261102_claim_unit_price.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8').replace(/^\uFEFF/, '');
      await client.query(sql);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { migrateClaimSchema };
