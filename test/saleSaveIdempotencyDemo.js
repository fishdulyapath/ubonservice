// Explicit integration test: writes one marked sale to the wawacrm demo database.
// Run only with --run and RUN_DEMO_SALE_SAVE_TEST=1.
require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { pool, getLogsPool } = require('../src/db');
const posRoutes = require('../src/routes/pos');
const basketRoutes = require('../src/routes/basket');

const BASKET_ID = 32700;
const ITEM_CODE = '01-0048';
const CUSTOMER_CODE = 'AR00001';
const PRICE = 106;

async function main() {
  if (process.argv[2] !== '--run' || process.env.RUN_DEMO_SALE_SAVE_TEST !== '1'
    || process.env.DB_NAME !== 'wawacrm' || process.env.PROVIDER !== 'DEMO') {
    throw new Error('This test writes a sale. Use --run, RUN_DEMO_SALE_SAVE_TEST=1, DB_NAME=wawacrm and PROVIDER=DEMO.');
  }

  const app = express();
  app.use(express.json());
  app.use('/service/v1', posRoutes, basketRoutes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/service/v1`;
  const post = async (route, body) => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user-code': 'CODEX' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const requestIds = [crypto.randomUUID(), crypto.randomUUID()];
  const itemGuid = crypto.randomUUID();
  let attemptedSave = false;
  let verified = false;
  try {
    const inserted = await pool.query(
      'INSERT INTO pos_basket (basket_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING basket_id',
      [BASKET_ID],
    );
    assert.equal(inserted.rowCount, 1, `test basket ${BASKET_ID} is already in use`);

    const setupBody = {
      basket_id: BASKET_ID, user_code: 'CODEX', cust_code: CUSTOMER_CODE,
      cust_name: 'เงินสดปลีก', inquiry_type: 1, vat_type: 1, vat_rate: 7,
      sale_code: 'CODEX', sale_name: 'CODEX TEST', doc_format_code: 'INV',
    };
    const setup = await post('/setBasketInfo', setupBody);
    assert.equal(setup.status, 200, JSON.stringify(setup));
    const basketEpoch = setup.data.data?.basket_epoch;
    assert.ok(basketEpoch, 'setBasketInfo must return basket_epoch');

    await pool.query(
      `INSERT INTO staff_cart_order
       (cust_code,guid_code,item_code,item_name,unit_code,item_type,qty,price,
        wh_code,shelf_code,creator_code,barcode,stand_value,divide_value,ratio)
       VALUES ($1,$2,$3,$4,$5,0,1,$6,$7,$8,$9,$10,1,1,1)`,
      [`BASKET-${BASKET_ID}`, itemGuid, ITEM_CODE, 'ดูโปร 250กรัม/สูตร2', 'ชิ้น',
        PRICE, 'MMA01', 'SH101', 'CODEX', '8851359950117'],
    );

    const bangkok = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    const body = {
      pos_id: 'INP01', basket_id: BASKET_ID, basket_epoch: basketEpoch,
      user_code: 'CODEX', creator_code: 'smlstaff',
      doc_date: bangkok.slice(0, 10), doc_time: bangkok.slice(11, 16),
      doc_format_code: 'INV', branch_code: '0000', cust_code: CUSTOMER_CODE,
      emp_code: 'CODEX', shelf_code: 'SH101', remark: '[TEST] sale save idempotency',
      inquiry_type: 1, vat_type: 1, vat_rate: 7, discount_type: 1,
      discount_word: '', total_value: PRICE, total_discount: 0,
      total_before_vat: 99.07, total_vat_value: 6.93, total_after_vat: PRICE,
      total_except_vat: 0, total_amount: PRICE, total_net_amount: PRICE,
      cash_amount: PRICE, rounded_amount: 0, total_income_amount: 0,
      tranfer_amount: 0, card_amount: 0, deposit_amount: 0,
      total_credit_charge: 0, wallet_amount: 0, payment_detail: [],
      items: [{
        guid_code: itemGuid, item_code: ITEM_CODE, item_name: 'ดูโปร 250กรัม/สูตร2',
        unit_code: 'ชิ้น', qty: 1, price: PRICE, sum_amount: PRICE,
        discount: '', discount_amount: 0, tax_type: 0, wh_code: 'MMA01',
        shelf_code: 'SH101', stand_value: 1, divide_value: 1, ratio: 1,
        barcode: '8851359950117', item_type: '0', sub_item: [],
      }],
    };

    attemptedSave = true;
    const concurrent = await Promise.all(requestIds.map((save_request_id) =>
      post('/saveTrans', { ...body, save_request_id })));
    const successes = concurrent.filter((entry) => entry.status === 200 && entry.data.success);
    const conflicts = concurrent.filter((entry) => entry.status === 409);
    assert.equal(successes.length, 1, `expected one sale: ${JSON.stringify(concurrent)}`);
    assert.equal(conflicts.length, 1, `expected one conflict: ${JSON.stringify(concurrent)}`);
    const invoice = successes[0].data.doc_no;
    const winningId = requestIds[concurrent.indexOf(successes[0])];
    assert.ok(invoice);

    const changedTime = body.doc_time === '23:59' ? '00:01' : '23:59';
    const retry = await post('/saveTrans', { ...body, doc_time: changedTime, save_request_id: winningId });
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(retry.data.doc_no, invoice);
    assert.equal(retry.data.duplicate, true);

    const statusResponse = await fetch(`${base}/sales/save-status?save_request_id=${winningId}`);
    const status = await statusResponse.json();
    assert.equal(status.found, true);
    assert.equal(status.doc_no, invoice);

    const reopened = await post('/setBasketInfo', setupBody);
    assert.equal(reopened.status, 200, JSON.stringify(reopened));
    assert.notEqual(reopened.data.data?.basket_epoch, basketEpoch);
    const stale = await post('/saveTrans', {
      ...body, save_request_id: crypto.randomUUID(), basket_epoch: basketEpoch,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale));

    const rows = await pool.query(
      `SELECT doc_no,doc_time,guid_code,total_amount FROM ic_trans
       WHERE trans_flag=44 AND guid_code = ANY($1::text[])`,
      [requestIds.map((id) => id.replace(/-/g, ''))],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].doc_no, invoice);
    assert.equal(Number(rows.rows[0].total_amount), PRICE);
    const detail = await pool.query(
      'SELECT COUNT(*)::int AS count FROM ic_trans_detail WHERE trans_flag=44 AND doc_no=$1',
      [invoice],
    );
    assert.ok(detail.rows[0].count >= 1);
    verified = true;
    console.log(JSON.stringify({ invoice, concurrent: concurrent.map((entry) => entry.status),
      retryDocNo: retry.data.doc_no, retryDuplicate: retry.data.duplicate,
      statusFound: status.found, staleStatus: stale.status, headerRows: rows.rowCount,
      detailRows: detail.rows[0].count, savedDocTime: rows.rows[0].doc_time }));

    const cleared = await post('/clearBasket', { basket_id: BASKET_ID, user_code: 'CODEX' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    await pool.query('DELETE FROM pos_basket WHERE basket_id=$1 AND status=$2', [BASKET_ID, 'empty']);
  } finally {
    if (!attemptedSave && !verified) {
      await pool.query('DELETE FROM staff_cart_order WHERE cust_code=$1 AND guid_code=$2',
        [`BASKET-${BASKET_ID}`, itemGuid]).catch(() => {});
      await pool.query('DELETE FROM pos_basket WHERE basket_id=$1', [BASKET_ID]).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await getLogsPool().end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
