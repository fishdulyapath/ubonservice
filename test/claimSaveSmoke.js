require('dotenv').config();
const assert = require('node:assert/strict');
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

async function main() {
  if (process.argv[2] !== '--save' || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Use --save with DB_NAME=wawacrm for this test sale');
  }
  const cartResponse = await fetch(`${base}/getcartitemlist?cust_code=BASKET-32028&page_size=500&user_code=CODEX`);
  const cart = await cartResponse.json();
  assert.equal(cart.success, true);
  assert.equal(cart.data.length, 1);
  const row = cart.data[0];
  const claimAmount = Number(row.claim_items[0].quoted_amount);
  assert.equal(claimAmount, 93);
  const beforeSale = await pool.query(`SELECT COALESCE(SUM(balance_qty),0) AS qty
    FROM sml_ic_function_stock_balance_warehouse_location('NOW()', '01-0048', 'MMA01', 'SH101')`);
  const beforeClaim = await pool.query(`SELECT COALESCE(SUM(balance_qty),0) AS qty
    FROM sml_ic_function_stock_balance_warehouse_location('NOW()', '01-0005', 'WHC03', 'WHC03')`);
  const body = {
    pos_id: 'INP01', basket_id: 32028, user_code: 'CODEX',
    doc_date: '2026-10-29', doc_time: '12:00', doc_format_code: 'INV', form_code: '',
    branch_code: '0000', cust_code: 'AR00001', emp_code: 'CODEX', shelf_code: 'SH101',
    remark: '[TEST] sale with claim', inquiry_type: 1,
    vat_type: 1, vat_rate: '7.00', discount_type: 1, discount_word: '',
    total_value: 13, total_discount: 0, total_before_vat: 12.15,
    total_vat_value: 0.85, total_after_vat: 13, total_except_vat: 0,
    total_amount: 13, total_net_amount: 13, cash_amount: 13,
    rounded_amount: 0, total_income_amount: 0, tranfer_amount: 0, card_amount: 0,
    deposit_amount: 0, total_credit_charge: 0, wallet_amount: 0,
    payment_detail: [], creator_code: 'smlstaff',
    items: [{
      guid_code: row.guid_code, claim_items: row.claim_items,
      item_code: row.item_code, item_name: row.item_name, unit_code: row.unit_code,
      qty: row.qty, price: 106, sum_amount: 13, discount: '93', discount_amount: 93,
      tax_type: Number(row.tax_type || 0), wh_code: 'MMA01', shelf_code: 'SH101',
      stand_value: row.stand_value, divide_value: row.divide_value, ratio: row.ratio,
      barcode: row.barcode || '', item_type: '0', sub_item: [],
    }],
  };
  const response = await fetch(`${base}/saveTrans`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`saveTrans ${response.status}: ${JSON.stringify(result)}`);
  assert.ok(result.doc_no);
  assert.ok(result.claim_pu_doc_no);
  const docs = await pool.query(`SELECT doc_no,trans_flag,cust_code,remark,doc_ref,total_amount,
    total_vat_value,vat_type,inquiry_type,last_status FROM ic_trans
    WHERE doc_no=ANY($1::text[]) ORDER BY trans_flag`, [[result.doc_no, result.claim_pu_doc_no]]);
  const sale = docs.rows.find((doc) => Number(doc.trans_flag) === 44);
  const pu = docs.rows.find((doc) => Number(doc.trans_flag) === 12);
  assert.equal(Number(sale.total_amount), 13);
  assert.equal(sale.remark, `[TEST] sale with claim\nรับสินค้าเคลม ใบซื้อ/ตั้งหนี้ ${pu.doc_no}`);
  assert.equal(pu.cust_code, 'AP0186');
  assert.equal(Number(pu.total_amount), 93);
  assert.equal(Number(pu.total_vat_value), 0);
  assert.equal(pu.doc_ref, sale.doc_no);
  assert.equal(pu.remark, `รับสินค้าเคลมจากใบขาย ${sale.doc_no}`);
  const details = await pool.query(`SELECT doc_no,trans_flag,item_code,qty,price,sum_amount,
    discount_amount,wh_code,shelf_code FROM ic_trans_detail
    WHERE doc_no=ANY($1::text[]) ORDER BY trans_flag,line_number`, [[result.doc_no, result.claim_pu_doc_no]]);
  const link = await pool.query('SELECT * FROM sml_staff_sale_claim WHERE sale_doc_no=$1', [sale.doc_no]);
  assert.equal(link.rows.length, 1);
  assert.equal(link.rows[0].pu_doc_no, pu.doc_no);
  const puLine = details.rows.find((item) => Number(item.trans_flag) === 12);
  assert.equal(puLine.item_code, '01-0005');
  assert.equal(Number(puLine.price), 93);
  assert.equal(Number(puLine.sum_amount), 93);
  assert.equal(puLine.wh_code, 'WHC03');
  assert.equal(puLine.shelf_code, 'WHC03');
  const afterSale = await pool.query(`SELECT COALESCE(SUM(balance_qty),0) AS qty
    FROM sml_ic_function_stock_balance_warehouse_location('NOW()', '01-0048', 'MMA01', 'SH101')`);
  const afterClaim = await pool.query(`SELECT COALESCE(SUM(balance_qty),0) AS qty
    FROM sml_ic_function_stock_balance_warehouse_location('NOW()', '01-0005', 'WHC03', 'WHC03')`);
  console.log(JSON.stringify({ doc_no: sale.doc_no, claim_pu_doc_no: pu.doc_no,
    sale_amount: sale.total_amount, pu_amount: pu.total_amount, pu_doc_ref: pu.doc_ref,
    pu_remark: pu.remark, sale_stock_before: beforeSale.rows[0].qty,
    sale_stock_after: afterSale.rows[0].qty, claim_stock_before: beforeClaim.rows[0].qty,
    claim_stock_after: afterClaim.rows[0].qty, details: details.rows }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
