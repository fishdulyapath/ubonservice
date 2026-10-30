require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const base = process.env.CLAIM_API_BASE || 'http://127.0.0.1:47310/service/v1';
const pool = new Pool({
  host: String(process.env.DB_HOST || '').replace(/^https?:\/\//, ''),
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});

async function stock(itemCode, whCode, shelfCode) {
  const result = await pool.query(`SELECT COALESCE(SUM(balance_qty),0) AS qty
    FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, $2, $3)`, [itemCode, whCode, shelfCode]);
  return Number(result.rows[0].qty);
}

async function main() {
  const docNo = process.argv[2];
  if (process.argv[3] !== '--cancel' || !docNo || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Pass sale doc number and --cancel with DB_NAME=wawacrm');
  }
  const username = 'CODEX-CLAIM-CANCEL';
  const password = crypto.randomBytes(24).toString('hex');
  const existing = await pool.query('SELECT 1 FROM erp_user WHERE code=$1', [username]);
  if (existing.rows.length) throw new Error('temporary cancel user already exists; inspect before continuing');
  await pool.query('INSERT INTO erp_user (code,name_1,password) VALUES ($1,$2,$3)',
    [username, 'Temporary claim test user', password]);
  try {
    await pool.query(`INSERT INTO sml_staff_permission (user_code,permission_key,is_allowed)
      VALUES ($1,'sales.cancel',TRUE)`, [username]);
    const saleQtyResult = await pool.query(`SELECT COALESCE(SUM(qty),0) AS qty
      FROM ic_trans_detail WHERE doc_no=$1 AND item_code='01-0048'`, [docNo]);
    const saleQty = Number(saleQtyResult.rows[0].qty);
    const claimQtyResult = await pool.query(`SELECT claim_item_code, SUM(qty) AS qty
      FROM sml_staff_sale_claim WHERE sale_doc_no=$1 GROUP BY claim_item_code`, [docNo]);
    assert.ok(saleQty > 0);
    assert.ok(claimQtyResult.rows.length > 0);
    const beforeSale = await stock('01-0048', 'MMA01', 'SH101');
    const beforeClaim = Object.fromEntries(await Promise.all(claimQtyResult.rows.map(async (row) =>
      [row.claim_item_code, await stock(row.claim_item_code, 'WHC03', 'WHC03')])));
    const response = await fetch(`${base}/sales/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_no: docNo, reason: '[TEST] cancel sale with linked claim PU', username, password }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(`cancel ${response.status}: ${JSON.stringify(result)}`);
    const docs = await pool.query(`SELECT doc_no,trans_flag,last_status FROM ic_trans
      WHERE doc_no=$1 OR doc_no=(SELECT pu_doc_no FROM sml_staff_sale_claim WHERE sale_doc_no=$1 LIMIT 1)`, [docNo]);
    const sale = docs.rows.find((row) => Number(row.trans_flag) === 44);
    const pu = docs.rows.find((row) => Number(row.trans_flag) === 12);
    assert.equal(Number(sale.last_status), 1);
    assert.equal(Number(pu.last_status), 1);
    const afterSale = await stock('01-0048', 'MMA01', 'SH101');
    const afterClaim = Object.fromEntries(await Promise.all(claimQtyResult.rows.map(async (row) =>
      [row.claim_item_code, await stock(row.claim_item_code, 'WHC03', 'WHC03')])));
    assert.equal(afterSale - beforeSale, saleQty);
    for (const row of claimQtyResult.rows) {
      assert.equal(afterClaim[row.claim_item_code] - beforeClaim[row.claim_item_code], -Number(row.qty));
    }
    console.log(JSON.stringify({ sale_doc_no: docNo, pu_doc_no: pu.doc_no,
      cancel_doc_no: result.data.cancel_doc_no, sale_status: sale.last_status,
      pu_status: pu.last_status, sale_stock_before: beforeSale, sale_stock_after: afterSale,
      claim_stock_before: beforeClaim, claim_stock_after: afterClaim }));
  } finally {
    await pool.query('DELETE FROM sml_staff_permission WHERE user_code=$1', [username]);
    await pool.query('DELETE FROM erp_user WHERE code=$1', [username]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
