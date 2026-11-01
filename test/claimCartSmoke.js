const assert = require('node:assert/strict');

const base = process.env.CLAIM_API_BASE || 'http://127.0.0.1:47310/service/v1';
const cartKey = 'BASKET-32028';
const saleGuid = '00000000-0000-4000-8000-000000032028';

async function call(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`${path}: ${result.msg || result.ERROR || JSON.stringify(result)}`);
  return result;
}

async function main() {
  const saleProduct = await call('/claim/product?item_code=01-0048');
  const claimProduct = await call('/claim/product?item_code=01-0005');
  const branch = await call('/claim/branch');
  assert.equal(saleProduct.data.can_claim, true);
  assert.equal(claimProduct.data.is_claim_item, true);
  assert.equal(branch.data.wh_code, 'WHC03');
  const found = await call('/claim/items?search=01-0005');
  assert.ok(found.data.some((row) => row.item_code === '01-0005' && row.unit_code === 'ชิ้น'));
  const quote = await call('/claim/quote', {
    cust_code: 'AR00001', sale_type: 1, vat_type: 1, vat_rate: 7,
    items: [{ item_code: '01-0005', unit_code: 'ชิ้น', qty: 1 }],
  });
  assert.equal(quote.data.items[0].amount, 93);
  await call('/additemtocart', [{
    cust_code: cartKey, emp_code: 'CODEX', user_code: 'CODEX', guid_code: saleGuid,
    item_code: '01-0048', item_name: 'ดูโปร 250กรัม/สูตร2', unit_code: 'ชิ้น',
    qty: 1, price: 106, item_type: '0', wh_code: 'MMA01', shelf_code: 'SH101',
    stand_value: 1, divide_value: 1, ratio: 1, barcode: '',
  }]);
  await call('/claim/cart', {
    cart_key: cartKey, sale_guid: saleGuid, user_code: 'CODEX',
    cust_code: 'AR00001', sale_type: 1, vat_type: 1, vat_rate: 7,
    items: [{ item_code: '01-0005', unit_code: 'ชิ้น', qty: 1 }],
  });
  const cart = await call(`/getcartitemlist?cust_code=${cartKey}&page_size=500&user_code=CODEX`);
  assert.equal(cart.data.length, 1);
  assert.equal(cart.data[0].guid_code, saleGuid);
  assert.equal(cart.data[0].claim_items.length, 1);
  assert.equal(Number(cart.data[0].claim_items[0].quoted_amount), 93);
  console.log(JSON.stringify({ sale_guid: saleGuid, quote: quote.data.items[0], cart_claim: cart.data[0].claim_items[0] }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
