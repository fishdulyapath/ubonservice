const assert = require('node:assert/strict');
const test = require('node:test');
const { calcDiscount, calcVat } = require('../src/utils/vatHelper');

test('a discount without a percent sign is an amount in baht', () => {
  const discount = calcDiscount('1', 14571);
  const [, , , total] = calcVat(2, 7, 1, 14571, discount);

  assert.equal(discount, 1);
  assert.equal(total, 14570);
  assert.equal(calcDiscount('1B', 14571), 1);
});

test('a percent sign is required for a percentage discount', () => {
  assert.equal(calcDiscount('1%', 14571), 145.71);
  assert.equal(calcDiscount('10+1%', 100), 10.9);
});
