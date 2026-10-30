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
  const docNo = process.argv[2];
  if (!docNo || process.env.DB_NAME !== 'wawacrm') throw new Error('Pass a sale doc number with DB_NAME=wawacrm');
  const historyResponse = await fetch(`${base}/getDocSaleHistoryDetail?doc_no=${encodeURIComponent(docNo)}`);
  const history = await historyResponse.json();
  assert.equal(history.success, true);
  assert.ok(history.data.claim_pu_doc_no);
  assert.equal(history.data.items[0].claim_items.length, 1);
  assert.equal(Number(history.data.items[0].claim_items[0].amount), 93);

  const duplicate = {
    pos_id: 'INP01', basket_id: 32028, user_code: 'CODEX',
    doc_date: '2026-10-29', doc_time: '12:05', doc_format_code: 'INV',
    branch_code: '0000', cust_code: 'AR00001', emp_code: 'CODEX',
    remark: '[TEST] duplicate claim save rejected', inquiry_type: 1,
    vat_type: 1, vat_rate: 7, discount_type: 1, discount_word: '',
    total_value: 13, total_discount: 0, total_before_vat: 12.15,
    total_vat_value: 0.85, total_after_vat: 13, total_except_vat: 0,
    total_amount: 13, total_net_amount: 13, cash_amount: 13,
    payment_detail: [], creator_code: 'smlstaff',
    items: [{
      guid_code: '00000000-0000-4000-8000-000000032028',
      claim_items: [{ claim_item_code: '01-0005', unit_code: 'ชิ้น', qty: 1, quoted_amount: 93 }],
      item_code: '01-0048', item_name: 'ดูโปร 250กรัม/สูตร2', unit_code: 'ชิ้น',
      qty: 1, price: 106, sum_amount: 13, discount: '93', discount_amount: 93,
      tax_type: 0, wh_code: 'MMA01', shelf_code: 'SH101',
      stand_value: 1, divide_value: 1, ratio: 1, item_type: '0',
    }],
  };
  const duplicateResponse = await fetch(`${base}/saveTrans`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(duplicate),
  });
  const duplicateResult = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicateResult.claim_price_changed, true);
  const stray = await pool.query("SELECT doc_no FROM ic_trans WHERE remark='[TEST] duplicate claim save rejected'");
  assert.equal(stray.rows.length, 0);
  console.log(JSON.stringify({ sale_doc_no: docNo, claim_pu_doc_no: history.data.claim_pu_doc_no,
    history_claim: history.data.items[0].claim_items[0], duplicate_status: duplicateResponse.status,
    duplicate_message: duplicateResult.msg }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
