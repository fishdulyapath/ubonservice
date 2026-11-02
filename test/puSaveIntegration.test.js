const test = require('node:test');
const assert = require('node:assert/strict');
const { savePUDocTransaction } = require('../src/routes/purchase');

function mockClient({ update = false, poUnit = false } = {}) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('FROM erp_option')) return { rows: [{
        item_amount_decimal: 2, item_price_decimal: 2, discout_type: 1,
        discount_vat_type: 0, discount_step_round_off: 0,
        calc_item_price_discount: 0, round_type: 0,
      }] };
      if (sql.includes('FROM ic_inventory i LEFT JOIN ic_unit_use u')) return { rows: [{
        item_code: 'ITEM-1', unit_code: 'EA', stand_value: 12, divide_value: 1,
      }] };
      if (poUnit && sql.includes('FROM ic_trans_detail WHERE trans_flag=$1 AND doc_no=ANY')) return { rows: [{
        doc_no: 'PO-1', item_code: 'ITEM-1', unit_code: 'BOX', stand_value: 24, divide_value: 1,
      }] };
      if (sql.includes('FROM ap_supplier s')) return { rows: [{ code: 'AP-TEST', name_1: 'Test supplier', branch_code: '', tax_id: '' }] };
      if (sql.includes('FROM erp_doc_format')) return { rows: [{ code: 'PU', name_1: 'Purchase', format: 'PU####', form_code: '' }] };
      if (update && sql.includes('COALESCE(doc_format_code') && sql.includes('FOR UPDATE')) {
        return { rows: [{ doc_no: 'PU0001', doc_format_code: 'PU' }] };
      }
      if (update && sql.includes('SELECT DISTINCT item_code') && sql.includes('FROM ic_trans_detail')) {
        return { rows: [{ item_code: 'OLD-ITEM' }] };
      }
      if (sql.includes('sml_ic_function_stock_balance_warehouse_location')) return { rows: [{ new_balance: 5 }] };
      if (sql.startsWith('UPDATE gl_journal_vat_buy')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    find(pattern) {
      return statements.find(({ sql }) => pattern.test(sql));
    },
  };
}

function payload(overrides = {}) {
  return {
    doc_date: '2026-10-30', credit_day: 30, credit_date: '2026-11-29',
    doc_time: '10:00', doc_format_code: 'PU',
    cust_code: 'AP-TEST', emp_code: 'TEST', creator_code: 'TEST',
    tax_doc_no: 'TAX-TEST', tax_doc_date: '2026-10-30',
    wh_from: 'WH', location_from: 'SH',
    sale_type: 1, tax_type: 0, vat_rate: 7,
    discount_word: '10,2%',
    cash_amount: 1024.49, transfer_amount: 0,
    total_amount: 1, total_discount: 0, total_vat_value: 0,
    items: [{ item_code: 'ITEM-1', item_name: 'Test item', unit_code: 'EA',
      qty: 2, price: 500, discount: '1,1%,2', discount_amount: 0,
      sum_amount: 1, tax_type: 0, wh_code: 'WH', shelf_code: 'SH' }],
    doc_list: [], payment_detail: [],
    ...overrides,
  };
}

test('create PU persists recalculated header, line, VAT and cash payment values', async () => {
  const client = mockClient();
  const saved = await savePUDocTransaction(client, payload(), 'create');
  assert.equal(saved.doc_no, 'PU0001');

  const header = client.find(/^\s*INSERT INTO ic_trans\s/i).params;
  assert.deepEqual(header.slice(13, 19), [987.01, 957.47, 67.02, 1024.49, 0, 1024.49]);
  assert.deepEqual(header.slice(21, 23), [29.54, '10,2%']);
  assert.deepEqual(header.slice(-2), [30, '2026-11-29']);

  const line = client.find(/^\s*INSERT INTO ic_trans_detail\s/i).params;
  assert.equal(line[11], 987.01);
  assert.deepEqual(line.slice(13, 15), [12, 1]);
  assert.equal(line[17], 1000);
  assert.equal(line[24], '1,1%,2');
  assert.equal(line[25], 12.99);

  const vat = client.find(/^\s*INSERT INTO gl_journal_vat_buy\s/i).params;
  assert.equal(vat[3], 957.47);
  assert.equal(vat[7], 67.02);

  const cash = client.find(/^\s*INSERT INTO cb_trans\s/i).params;
  assert.deepEqual(cash.slice(6, 10), [1024.49, 1024.49, 1024.49, 0]);
});

test('update PU refreshes old and new item stock and replaces stored totals', async () => {
  const client = mockClient({ update: true });
  await savePUDocTransaction(client, payload({
    doc_no: 'PU0001', sale_type: 0, cash_amount: 0,
  }), 'update');
  const header = client.find(/^\s*UPDATE ic_trans\s+SET doc_date/i).params;
  assert.deepEqual(header.slice(6, 14), [987.01, 957.47, 67.02, 1024.49, 0, 1024.49, 29.54, '10,2%']);
  assert.deepEqual(header.slice(-2), [30, '2026-11-29']);
  const stock = client.statements.filter(({ sql }) => sql.includes('sml_ic_function_stock_balance_warehouse_location'));
  assert.deepEqual(stock.map(({ params }) => params[0]).sort(), ['ITEM-1', 'OLD-ITEM']);
  assert.ok(client.find(/^\s*DELETE FROM ic_trans_detail/i));
  assert.equal(client.find(/^\s*INSERT INTO cb_trans\s/i), undefined);
});

test('cash PU rejects insufficient payment after server recalculation', async () => {
  const client = mockClient();
  await assert.rejects(
    savePUDocTransaction(client, payload({ cash_amount: 1 }), 'create'),
    /payment is not enough/,
  );
  assert.equal(client.find(/^\s*INSERT INTO ic_trans\s/i), undefined);
});

test('no-PO unit must exist in master, while a PO line keeps its recorded unit ratio', async () => {
  const invalidClient = mockClient();
  const changedUnit = { ...payload().items[0], unit_code: 'BOX' };
  await assert.rejects(savePUDocTransaction(invalidClient, payload({ items: [changedUnit] }), 'create'), /unit_code is not in item master/);

  const poClient = mockClient({ poUnit: true });
  await savePUDocTransaction(poClient, payload({ items: [{ ...changedUnit, ref_doc_no: 'PO-1' }] }), 'create');
  const line = poClient.find(/^\s*INSERT INTO ic_trans_detail\s/i).params;
  assert.equal(line[8], 'BOX');
  assert.deepEqual(line.slice(13, 15), [24, 1]);
});

test('purchase route and claim consumer load together', () => {
  assert.equal(typeof require('../src/routes/purchase').calcAfterDiscount, 'function');
  assert.equal(typeof require('../src/utils/saleClaim').capClaimQuotes, 'function');
});
