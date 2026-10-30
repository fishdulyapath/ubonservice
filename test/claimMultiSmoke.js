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
  if (process.argv[2] !== '--save' || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Use --save with DB_NAME=wawacrm for this multi-claim test');
  }
  const basketId = 32029;
  const cartKey = `BASKET-${basketId}`;
  const guid = '00000000-0000-4000-8000-000000032029';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM pos_basket WHERE basket_id=$1', [basketId]);
    if (existing.rows.length) throw new Error('test basket already exists');
    await client.query(`INSERT INTO pos_basket
      (basket_id,cust_code,cust_name,inquiry_type,vat_type,vat_rate,sale_code,sale_name,
       doc_format_code,form_code,status)
      VALUES ($1,'AR00001','เงินสดปลีก',1,1,7,'CODEX','CODEX','INV','','active')`, [basketId]);
    await client.query(`INSERT INTO sml_staff_claim_item (item_code,can_claim,is_claim_item,updated_by)
      VALUES ('01-0009',FALSE,TRUE,'CODEX')`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const add = await post('/additemtocart', [{
    cust_code: cartKey, emp_code: 'CODEX', user_code: 'CODEX', guid_code: guid,
    item_code: '01-0048', item_name: 'ดูโปร 250กรัม/สูตร2', unit_code: 'ชิ้น',
    qty: 3, price: 106, item_type: '0', wh_code: 'MMA01', shelf_code: 'SH101',
    stand_value: 1, divide_value: 1, ratio: 1, barcode: '',
  }]);
  assert.equal(add.data.success, true);
  const claim = await post('/claim/cart', {
    cart_key: cartKey, sale_guid: guid, user_code: 'CODEX',
    cust_code: 'AR00001', sale_type: 1, vat_type: 1, vat_rate: 7,
    items: [{ item_code: '01-0005', unit_code: 'ชิ้น', qty: 1 },
      { item_code: '01-0009', unit_code: 'ชิ้น', qty: 1 }],
  });
  assert.equal(claim.data.success, true);
  const cart = await (await fetch(`${base}/getcartitemlist?cust_code=${cartKey}&page_size=500&user_code=CODEX`)).json();
  assert.equal(cart.data.length, 1);
  assert.equal(cart.data[0].claim_items.length, 2);
  const claimTotal = cart.data[0].claim_items.reduce((sum, row) => sum + Number(row.quoted_amount), 0);
  assert.equal(claimTotal, 186);
  const saleAmount = 3 * 106 - claimTotal;
  assert.equal(saleAmount, 132);
  const body = {
    pos_id: 'INP01', basket_id: basketId, user_code: 'CODEX',
    doc_date: '2026-10-29', doc_time: '12:20', doc_format_code: 'INV', branch_code: '0000',
    cust_code: 'AR00001', emp_code: 'CODEX', shelf_code: 'SH101', creator_code: 'smlstaff',
    remark: '[TEST] multi-item claim sale', inquiry_type: 1, vat_type: 1, vat_rate: 7,
    discount_type: 1, discount_word: '', total_value: saleAmount, total_discount: 0,
    total_before_vat: 123.36, total_vat_value: 8.64, total_after_vat: saleAmount,
    total_except_vat: 0, total_amount: saleAmount, total_net_amount: saleAmount,
    cash_amount: saleAmount, payment_detail: [],
    items: [{
      guid_code: guid, claim_items: cart.data[0].claim_items,
      item_code: '01-0048', item_name: 'ดูโปร 250กรัม/สูตร2', unit_code: 'ชิ้น',
      qty: 3, price: 106, sum_amount: saleAmount, discount: '186', discount_amount: 186,
      tax_type: 0, wh_code: 'MMA01', shelf_code: 'SH101', stand_value: 1,
      divide_value: 1, ratio: 1, item_type: '0', barcode: '',
    }],
  };
  const save = await post('/saveTrans', body);
  if (save.status !== 200 || !save.data.success) throw new Error(`saveTrans ${save.status}: ${JSON.stringify(save.data)}`);
  const docs = await pool.query(`SELECT doc_no,trans_flag,total_amount FROM ic_trans
    WHERE doc_no=ANY($1::text[])`, [[save.data.doc_no, save.data.claim_pu_doc_no]]);
  const details = await pool.query(`SELECT doc_no,trans_flag,item_code,qty,price,sum_amount,wh_code,shelf_code
    FROM ic_trans_detail WHERE doc_no=ANY($1::text[]) ORDER BY trans_flag,line_number`,
  [[save.data.doc_no, save.data.claim_pu_doc_no]]);
  const links = await pool.query('SELECT * FROM sml_staff_sale_claim WHERE sale_doc_no=$1', [save.data.doc_no]);
  assert.equal(Number(docs.rows.find((row) => Number(row.trans_flag) === 44).total_amount), 132);
  assert.equal(Number(docs.rows.find((row) => Number(row.trans_flag) === 12).total_amount), 186);
  assert.equal(links.rows.length, 2);
  assert.equal(details.rows.filter((row) => Number(row.trans_flag) === 12).length, 2);
  console.log(JSON.stringify({ sale_doc_no: save.data.doc_no, pu_doc_no: save.data.claim_pu_doc_no,
    sale_amount: 132, claim_total: 186, links: links.rows.map((row) => ({ claim_item_code: row.claim_item_code, amount: row.amount })),
    details: details.rows }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
