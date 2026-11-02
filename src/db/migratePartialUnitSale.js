const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../db');

async function migratePartialUnitSale() {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '20261102_partial_unit_sale.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sml_staff_partial_unit_sale'))");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { migratePartialUnitSale };
