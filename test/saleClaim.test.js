const test = require('node:test');
const assert = require('node:assert/strict');
const { claimNetPrice, applyClaimDiscount, buildClaimPUPayload, quoteClaim } = require('../src/utils/saleClaim');
const { normalizePriceQuantity } = require('../src/utils/priceHelper');

test('claim price uses promotion price and automatic percentage discount', () => {
  assert.deepEqual(claimNetPrice(120, 2, '10%'), { unit_price: 108, amount: 216 });
});

test('claim price uses fixed and per-unit discounts', () => {
  assert.deepEqual(claimNetPrice(100, 2, '10,@5'), { unit_price: 90, amount: 180 });
});

test('claim PU unit price reproduces two-decimal claim amount', () => {
  const quote = claimNetPrice(10, 3, '');
  assert.equal(Math.round(quote.unit_price * 3 * 100) / 100, quote.amount);
});

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

test('SML price tiers receive fractional claim quantity without truncation', () => {
  assert.equal(normalizePriceQuantity('1.5'), 1.5);
  assert.equal(normalizePriceQuantity('2'), 2);
  assert.equal(normalizePriceQuantity('0'), 1);
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

test('claim quote passes full customer and fractional quantity context to SML pricing', async () => {
  let priceArgs;
  const queryFn = async (_sql, params) => {
    assert.deepEqual(params, ['C1', 'EA']);
    return { rows: [{ name_1: 'Claim item', stand_value: 1, divide_value: 1, barcode: '123' }] };
  };
  const priceFn = async (...args) => {
    priceArgs = args;
    return { success: true, data: [{ price: 100, defaultDiscount: '10%' }] };
  };
  const quote = await quoteClaim(queryFn, {
    item_code: 'C1', unit_code: 'EA', qty: 1.5,
    cust_code: 'AR01', vat_type: 2, vat_rate: 7, sale_type: 1,
  }, priceFn);
  assert.deepEqual(priceArgs, ['C1', 'EA', '1.5', 'AR01', 2, 7, 1, '123']);
  assert.equal(quote.amount, 135);
  assert.equal(quote.unit_price, 90);
  assert.equal(quote.discount_word, '10%');
});
