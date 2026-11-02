const test = require('node:test');
const assert = require('node:assert/strict');
const { capClaimQuotes, claimQuoteChanged, applyClaimDiscount, buildClaimPUPayload, quoteClaim } = require('../src/utils/saleClaim');
const { calculatePUDocument } = require('../src/utils/puPricing');
const { loadPurchaseDocument } = require('../src/routes/purchasePrint');
const { calcVat } = require('../src/utils/vatHelper');

test('sale row already reduced by claim is not discounted twice', () => {
  const line = { qty: 1, price: 100, sum_amount: 90, discount_amount: 10, discount: '10' };
  assert.equal(applyClaimDiscount(line, line, 10).sum_amount, 90);
  assert.equal(line.discount_amount, 10);
});

test('SML promotion row recalculated on server receives claim discount once', () => {
  const original = { sum_amount: 90 };
  const line = { sum_amount: 100, discount_amount: 0, discount: '' };
  applyClaimDiscount(line, original, 10);
  assert.equal(line.sum_amount, 90);
  assert.equal(line.discount_amount, 10);
  assert.equal(line.discount, '10');
});

test('claim value cannot exceed a recalculated sale line', () => {
  assert.throws(() => applyClaimDiscount({ sum_amount: 5 }, {}, 6), /exceeds/);
});

test('client cannot hide an overvalued claim in a zero-net sale row', () => {
  const line = { qty: 1, price: 106, sum_amount: 0, discount_amount: 186, discount: '186' };
  assert.throws(() => applyClaimDiscount(line, line, 186), /gross/);
});

test('claim PU uses credit, non-VAT, net claim values and sale reference', () => {
  const payload = buildClaimPUPayload({
    claimQuotes: [
      { item_code: 'C1', item_name: 'Claim one', unit_code: 'EA', qty: 2, unit_price: 45, amount: 90, stand_value: 1, divide_value: 1 },
      { item_code: 'C2', item_name: 'Claim two', unit_code: 'EA', qty: 1, unit_price: 30, amount: 30, stand_value: 1, divide_value: 1 },
    ],
    branch: { wh_code: 'CL', shelf_code: '01', pu_doc_format_code: 'PU' },
    docNo: 'CS-TEST-001', docDate: '2026-10-28', docTime: '10:00',
    branchCode: '001', empCode: 'TEST', creatorCode: 'TEST',
  });
  assert.equal(payload.cust_code, 'AP0186');
  assert.equal(payload.inquiry_type, 0);
  assert.equal(payload.tax_type, 3);
  assert.equal(payload.total_vat_value, 0);
  assert.equal(payload.total_amount, 120);
  assert.equal(payload.doc_ref, 'CS-TEST-001');
  assert.equal(payload.remark, 'รับสินค้าเคลมจากใบขาย CS-TEST-001');
  assert.deepEqual(payload.items.map((item) => [item.item_code, item.price, item.sum_amount, item.wh_code, item.shelf_code]), [
    ['C1', 45, 90, 'CL', '01'], ['C2', 30, 30, 'CL', '01'],
  ]);
});

test('claim quote uses configured unit price independently of sale pricing and customer', async () => {
  const queryFn = async (_sql, params) => {
    assert.deepEqual(params, ['C1', 'EA']);
    return { rows: [{ name_1: 'Claim item', stand_value: 1, divide_value: 1, barcode: '123', claim_price: '80.0000' }] };
  };
  const quote = await quoteClaim(queryFn, {
    item_code: 'C1', unit_code: 'EA', qty: 1.5,
    cust_code: 'AR01', vat_type: 2, vat_rate: 7, sale_type: 1,
  });
  assert.equal(quote.amount, 120);
  assert.equal(quote.unit_price, 80);
  assert.equal(quote.configured_unit_price, 80);
});

test('claim price must be configured for the exact unit; zero is valid', async () => {
  const input = { item_code: 'C1', unit_code: 'BOX', qty: 2 };
  const queryFn = async () => ({ rows: [{ name_1: 'Claim item', claim_price: null }] });
  await assert.rejects(quoteClaim(queryFn, input), /ยังไม่ได้ตั้งราคารับเคลม/);
  const free = await quoteClaim(async () => ({ rows: [{ name_1: 'Claim item', claim_price: '0' }] }), input);
  assert.equal(free.amount, 0);
});

test('the same item has independent claim prices for each unit', async () => {
  const queryFn = async (_sql, params) => ({ rows: [{ name_1: 'Claim item', claim_price: params[1] === 'EA' ? '50' : '580' }] });
  const each = await quoteClaim(queryFn, { item_code: 'C1', unit_code: 'EA', qty: 1.5 });
  const box = await quoteClaim(queryFn, { item_code: 'C1', unit_code: 'BOX', qty: 1 });
  assert.equal(each.amount, 75);
  assert.equal(box.amount, 580);
});

test('a changed configured price is detected even when both quotes are capped to the same amount', () => {
  const oldQuote = capClaimQuotes([{ qty: 1, configured_unit_price: 200, configured_amount: 200 }], 100)[0];
  const newQuote = capClaimQuotes([{ qty: 1, configured_unit_price: 220, configured_amount: 220 }], 100)[0];
  assert.equal(oldQuote.amount, newQuote.amount);
  assert.equal(claimQuoteChanged({ configured_unit_price: 200, quoted_amount: 100 }, newQuote), true);
});

test('claim cap takes prices in selection order and keeps zero-value PU lines', () => {
  const raw = [
    { item_code: 'C1', unit_code: 'EA', qty: 1, unit_price: 80, amount: 80, configured_unit_price: 80, configured_amount: 80 },
    { item_code: 'C2', unit_code: 'EA', qty: 2, unit_price: 60, amount: 120, configured_unit_price: 60, configured_amount: 120 },
    { item_code: 'C3', unit_code: 'EA', qty: 1, unit_price: 40, amount: 40, configured_unit_price: 40, configured_amount: 40 },
  ];
  const capped = capClaimQuotes(raw, 100);
  assert.deepEqual(capped.map(row => [row.configured_unit_price, row.unit_price, row.amount]), [
    [80, 80, 80], [60, 10, 20], [40, 0, 0],
  ]);
  assert.equal(capped.reduce((sum, row) => sum + row.amount, 0), 100);
});

test('fractional claim quantity keeps a cent-exact PU amount after capping', () => {
  const [quote] = capClaimQuotes([{
    item_code: 'C1', unit_code: 'EA', qty: 1.5,
    configured_unit_price: 80, configured_amount: 120,
  }], 100);
  assert.equal(quote.amount, 100);
  assert.equal(Math.round(quote.unit_price * quote.qty * 100) / 100, 100);
});

test('capped sale discount, non-VAT PU and printed PU read the same stored values', async () => {
  const quotes = capClaimQuotes([
    { item_code: 'C1', item_name: 'Claim one', unit_code: 'EA', qty: 1,
      configured_unit_price: 80, configured_amount: 80, stand_value: 1, divide_value: 1 },
    { item_code: 'C2', item_name: 'Claim two', unit_code: 'EA', qty: 2,
      configured_unit_price: 60, configured_amount: 120, stand_value: 1, divide_value: 1 },
  ], 100);
  const sale = { sum_amount: 100, price: 100, qty: 1, discount_amount: 0, discount: '' };
  applyClaimDiscount(sale, {}, 100);
  assert.equal(sale.sum_amount, 0);
  assert.equal(sale.discount_amount, 100);
  const pu = buildClaimPUPayload({
    claimQuotes: quotes, branch: { wh_code: 'CL', shelf_code: '01', pu_doc_format_code: 'PU' },
    docNo: 'CS-1', docDate: '2026-11-02', docTime: '10:00', empCode: 'EMP',
  });
  const pricing = calculatePUDocument(pu.items, '', 0, 3);
  assert.deepEqual(pricing.items.map(row => row.sum_amount), [80, 20]);
  assert.equal(pricing.totals.total_amount, 100);
  assert.equal(pricing.totals.total_vat_value, 0);
  const printed = await loadPurchaseDocument('PU-1', async (sql) => {
    if (sql.includes('FROM ic_trans pu')) return { rows: [{ doc_no: 'PU-1', total_amount: 100, cust_code: 'AP0186' }] };
    if (sql.includes('FROM ic_trans_detail d')) return { rows: pricing.items.map(row => ({ ...row, amount: row.sum_amount })) };
    return { rows: [{}] };
  });
  assert.equal(printed.header.total_amount, 100);
  assert.deepEqual(printed.details.map(row => row.amount), [80, 20]);
});

test('sale VAT is calculated after the claim discount while claim PU remains non-VAT', () => {
  const line = { sum_amount: 100, price: 100, qty: 1, discount_amount: 0, discount: '' };
  applyClaimDiscount(line, {}, 80);
  assert.equal(line.sum_amount, 20);
  const [beforeVat, vat, , saleTotal] = calcVat(0, 7, 0, line.sum_amount, 0);
  assert.deepEqual([beforeVat, vat, saleTotal], [20, 1.4, 21.4]);
  const pu = buildClaimPUPayload({
    claimQuotes: [{ item_code: 'C1', item_name: 'Claim', unit_code: 'EA', qty: 1,
      unit_price: 80, amount: 80, stand_value: 1, divide_value: 1 }],
    branch: { wh_code: 'CL', shelf_code: '01', pu_doc_format_code: 'PU' },
    docNo: 'CS-2', docDate: '2026-11-02', docTime: '10:00', empCode: 'EMP',
  });
  assert.equal(pu.total_amount, 80);
  assert.equal(pu.total_vat_value, 0);
});
