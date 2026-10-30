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

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function main() {
  if (process.argv[2] !== '--test' || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Use --test with DB_NAME=wawacrm for this overvalue test');
  }
  const basketId = 32030;
  const cartKey = `BASKET-${basketId}`;
  const guid = '00000000-0000-4000-8000-000000032030';
  const existing = await pool.query('SELECT 1 FROM pos_basket WHERE basket_id=$1', [basketId]);
  if (existing.rows.length) throw new Error('test basket already exists');
  await pool.query(`INSERT INTO pos_basket
    (basket_id,cust_code,cust_name,inquiry_type,vat_type,vat_rate,sale_code,sale_name,
     doc_format_code,form_code,status)
    VALUES ($1,'AR00001','เงินสดปลีก',1,1,7,'CODEX','CODEX','INV','','active')`, [basketId]);
  try {
    const add = await post('/additemtocart', [{
      cust_code: cartKey, emp_code: 'CODEX', user_code: 'CODEX', guid_code: guid,
      item_code: '01-0048', item_name: 'ดูโปร 250กรัม/สูตร2', unit_code: 'ชิ้น',
      qty: 1, price: 106, item_type: '0', wh_code: 'MMA01', shelf_code: 'SH101',
      stand_value: 1, divide_value: 1, ratio: 1, barcode: '',
    }]);
    assert.equal(add.data.success, true);
    const claim = await post('/claim/cart', {
      cart_key: cartKey, sale_guid: guid, user_code: 'CODEX',
      cust_code: 'AR00001', sale_type: 1, vat_type: 1, vat_rate: 7,
      items: [{ item_code: '01-0005', unit_code: 'ชิ้น', qty: 2 }],
    });
    assert.equal(claim.data.success, true);
    const cart = await (await fetch(`${base}/getcartitemlist?cust_code=${cartKey}&page_size=500&user_code=CODEX`)).json();
    assert.equal(Number(cart.data[0].claim_items[0].quoted_amount), 186);
    const body = {
      pos_id: 'INP01', basket_id: basketId, user_code: 'CODEX',
      doc_date: '2026-10-29', doc_time: '12:30', doc_format_code: 'INV',
      branch_code: '0000', cust_code: 'AR00001', emp_code: 'CODEX',
      remark: '[TEST] overvalued claim rejected', inquiry_type: 1,
      vat_type: 1, vat_rate: 7, discount_type: 1, discount_word: '',
      total_value: 0, total_discount: 0, total_before_vat: 0,
      total_vat_value: 0, total_after_vat: 0, total_except_vat: 0,
      total_amount: 0, total_net_amount: 0, cash_amount: 0,
      payment_detail: [], creator_code: 'smlstaff',
      items: [{ guid_code: guid, claim_items: cart.data[0].claim_items,
        item_code: '01-0048', item_name: 'ดูโปร 250กรัม/สูตร2', unit_code: 'ชิ้น',
        qty: 1, price: 106, sum_amount: 0, discount: '186', discount_amount: 186,
        tax_type: 0, wh_code: 'MMA01', shelf_code: 'SH101',
        stand_value: 1, divide_value: 1, ratio: 1, item_type: '0' }],
    };
    const save = await post('/saveTrans', body);
    assert.equal(save.status, 409);
    assert.match(save.data.msg, /claim discount exceeds sale item gross amount/);
    const stray = await pool.query("SELECT doc_no FROM ic_trans WHERE remark='[TEST] overvalued claim rejected'");
    assert.equal(stray.rows.length, 0);
    console.log(JSON.stringify({ status: save.status, message: save.data.msg, stray_documents: stray.rows.length }));
  } finally {
    await pool.query('DELETE FROM sml_staff_cart_claim WHERE cart_key=$1', [cartKey]);
    await pool.query('DELETE FROM staff_cart_order WHERE cust_code=$1', [cartKey]);
    await pool.query('DELETE FROM pos_basket WHERE basket_id=$1', [basketId]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
