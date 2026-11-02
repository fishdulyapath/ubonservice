const test = require('node:test');
const assert = require('node:assert/strict');
const { quotePartialUnitSale } = require('../src/utils/partialUnitSale');
const { calcVat } = require('../src/utils/vatHelper');

const unit = {
  item_name: 'สินค้า', item_type: 0, target_unit_code: 'ชิ้น', source_unit_code: 'กล่อง',
  source_stand_value: 12, source_divide_value: 1,
  target_stand_value: 1, target_divide_value: 1,
  source_barcode: 'BOX', target_barcode: 'PIECE',
};
const query = async (sql) => ({ rows: sql.includes('FROM ic_inventory i')
  ? [unit]
  : [{ item_amount_decimal: 2, item_price_decimal: 3, round_type: 1 }],
});
const context = {
  item_code: 'ITEM', source_unit_code: 'กล่อง', target_unit_code: 'ชิ้น',
  cust_code: 'AR001', sale_type: 1, vat_type: 1, vat_rate: 7,
};

test('partial unit quote prorates the selected large-unit customer price', async () => {
  const quote = await quotePartialUnitSale(query, context, async (...args) => {
    assert.deepEqual(args.slice(0, 4), ['ITEM', 'กล่อง', '1', 'AR001']);
    return { data: [{ price: 120, defaultDiscount: '' }] };
  });
  assert.equal(quote.conversion, 12);
  assert.equal(quote.price, 10);
  assert.equal(quote.price * 10, 100);
  assert.equal(quote.target_unit_code, 'ชิ้น');
});

test('source-unit discount is applied once before conversion', async () => {
  const quote = await quotePartialUnitSale(query, context,
    async () => ({ data: [{ price: 120, defaultDiscount: '10%' }] }));
  assert.equal(quote.source_net_price, 108);
  assert.equal(quote.price, 9);
  assert.equal(quote.price * 10, 90);
  assert.equal(calcVat(0, 7, 0, quote.price * 10, 0)[1], 6.3);
  assert.equal(calcVat(1, 7, 0, quote.price * 10, 0)[3], 90);
});

test('quote rejects a target unit that no longer matches the master', async () => {
  await assert.rejects(
    quotePartialUnitSale(query, { ...context, target_unit_code: 'แพ็ก' },
      async () => ({ data: [{ price: 120 }] })),
    /base unit changed/,
  );
});
