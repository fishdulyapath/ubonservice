const test = require('node:test');
const assert = require('node:assert/strict');
const { calcPULineAmounts, calculatePUDocument } = require('../src/utils/puPricing');

const item = (discount) => ({ qty: 2, price: 500, discount, tax_type: 0 });

test('line discounts accept baht, percent and consecutive steps', () => {
  assert.equal(calcPULineAmounts(item('1')).sum_amount, 999);
  assert.equal(calcPULineAmounts(item('1%')).sum_amount, 990);
  assert.deepEqual(
    (({ discount_amount, sum_amount }) => ({ discount_amount, sum_amount }))(
      calcPULineAmounts(item('1,1%,2')),
    ),
    { discount_amount: 12.99, sum_amount: 987.01 },
  );
  assert.equal(calcPULineAmounts(item('@1')).sum_amount, 998);
});

test('bill discount is calculated from the discounted lines, then VAT', () => {
  const result = calculatePUDocument([item('1,1%,2')], '10,2%', 7, 0, { discout_type: 1 });
  assert.equal(result.totals.total_discount, 29.54);
  assert.equal(result.totals.total_before_vat, 957.47);
  assert.equal(result.totals.total_vat_value, 67.02);
  assert.equal(result.totals.total_amount, 1024.49);
});

test('bill discount accepts fixed baht and percent independently', () => {
  const rows = [item('')];
  const option = { discout_type: 1 };
  assert.equal(calculatePUDocument(rows, '10', 7, 0, option).totals.total_amount, 1059.3);
  assert.equal(calculatePUDocument(rows, '10%', 7, 0, option).totals.total_amount, 963);
  assert.equal(calculatePUDocument(rows, '10,2%', 7, 0, option).totals.total_discount, 29.8);
});

test('all four tax types use their respective VAT rules', () => {
  const options = { discout_type: 1 };
  const amounts = [0, 1, 2, 3].map((taxType) =>
    calculatePUDocument([item('1,1%,2')], '10,2%', 7, taxType, options).totals,
  );
  assert.deepEqual(amounts.map((row) => row.total_amount), [1024.49, 957.47, 957.47, 957.47]);
  assert.equal(amounts[1].total_vat_value, 62.64);
  assert.deepEqual(amounts.slice(2).map((row) => row.total_vat_value), [0, 0]);
});

test('erp_option changes per-unit and step-rounding calculation', () => {
  const fractional = { qty: 3, price: 0.02, discount: '10%' };
  assert.equal(calcPULineAmounts(fractional).sum_amount, 0.05);
  assert.equal(calcPULineAmounts(fractional, { calc_item_price_discount: 1 }).sum_amount, 0.06);
  const steps = { qty: 1, price: 0.06, discount: '5%,5%' };
  assert.equal(calcPULineAmounts(steps).sum_amount, 0.06);
  assert.equal(calcPULineAmounts(steps, { discount_step_round_off: 1 }).sum_amount, 0.05);
});

test('VAT can be calculated before discount or allocated across exempt items', () => {
  const rows = [
    { qty: 1, price: 100, tax_type: 0 },
    { qty: 1, price: 100, tax_type: 1 },
  ];
  const beforeDiscount = calculatePUDocument(rows, '20', 7, 0, { discout_type: 0 }).totals;
  const allocated = calculatePUDocument(rows, '20', 7, 0, { discout_type: 1, discount_vat_type: 1 }).totals;
  assert.equal(beforeDiscount.total_vat_value, 7);
  assert.equal(allocated.total_before_vat, 90);
  assert.equal(allocated.total_except_vat, 90);
  assert.equal(allocated.total_vat_value, 6.3);
});
