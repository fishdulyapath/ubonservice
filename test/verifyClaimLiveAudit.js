// Validate saved evidence only; no database connection or mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../../test-evidence/claim-live-20261030');
const before = JSON.parse(fs.readFileSync(path.join(dir, 'before.json')));
const after = JSON.parse(fs.readFileSync(path.join(dir, 'after.json')));
const sale = after.headers.find(row => row.trans_flag === 44);
const pu = after.headers.find(row => row.trans_flag === 12);
const saleRows = after.details.filter(row => row.trans_flag === 44);
const puRows = after.details.filter(row => row.trans_flag === 12);
const checks = [];
function check(label, fn) { fn(); checks.push(label); }
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key]), 0);
const cents = value => Math.round(Number(value) * 100) / 100;
function stock(data, item, warehouse, location) {
  return Number(data.stock.find(row => row.item_code === item).rows.find(row => row.warehouse === warehouse && row.location === location)?.balance_qty || 0);
}
check('Sale gross 276 - claim 230 = net 46, deducted once', () => {
  assert.equal(saleRows.length, 1);
  assert.equal(Number(saleRows[0].qty) * Number(saleRows[0].price), 276);
  assert.equal(Number(saleRows[0].discount_amount), 230);
  assert.equal(sum(saleRows, 'sum_amount'), 46);
  assert.equal(Number(sale.total_amount), 46);
});
check('Included VAT: displayed base 42.99 + VAT 3.01 = 46', () => {
  assert.equal(sale.vat_type, 1);
  assert.equal(cents(sale.total_before_vat), 42.99);
  assert.equal(cents(sale.total_vat_value), 3.01);
  assert.equal(Number(sale.total_before_vat) + Number(sale.total_vat_value), 46);
  assert.equal(after.saleVat.length, 1);
  assert.equal(Number(after.saleVat[0].base_caltax_amount), Number(sale.total_before_vat));
  assert.equal(Number(after.saleVat[0].amount), Number(sale.total_vat_value));
});
check('PU links and two claim quantities/amounts match exactly', () => {
  assert.equal(pu.doc_ref, sale.doc_no);
  assert.equal(after.links.length, 2);
  assert.equal(puRows.length, 2);
  for (const [code, qty, amount] of [['01-0005', 1.5, 138], ['01-0009', 1, 92]]) {
    const detail = puRows.find(row => row.item_code === code);
    const link = after.links.find(row => row.claim_item_code === code);
    assert.equal(Number(detail.qty), qty);
    assert.equal(Number(link.qty), qty);
    assert.equal(Number(detail.sum_amount), amount);
    assert.equal(Number(link.amount), amount);
    assert.equal(link.pu_doc_no, pu.doc_no);
    assert.equal(detail.wh_code, 'WHC03');
    assert.equal(detail.shelf_code, 'WHC03');
  }
});
check('PU is credit/non-VAT, total 230, no VAT added', () => {
  assert.equal(pu.inquiry_type, 0);
  assert.equal(pu.vat_type, 3);
  assert.equal(pu.cust_code, 'AP0186');
  assert.equal(Number(pu.total_vat_value), 0);
  assert.equal(Number(pu.total_except_vat), 230);
  assert.equal(Number(pu.total_amount), sum(puRows, 'sum_amount'));
  assert.equal(Number(pu.total_amount), sum(after.links, 'amount'));
  assert.equal(sum(after.purchaseVat, 'vat_amount'), 0);
});
check('Cash receipt 46, no change, no cash record for credit PU', () => {
  assert.equal(after.cash.length, 1);
  assert.equal(after.cash[0].doc_no, sale.doc_no);
  assert.equal(Number(after.cash[0].cash_amount), 46);
  assert.equal(Number(after.cash[0].total_net_amount), 46);
  assert.equal(Number(after.cash[0].money_change), 0);
});
check('Stock: sale -3; claim warehouse +1.50 and +1', () => {
  assert.equal(stock(after, '01-0004', 'MMA01', 'SH101') - stock(before, '01-0004', 'MMA01', 'SH101'), -3);
  assert.equal(stock(after, '01-0005', 'WHC03', 'WHC03') - stock(before, '01-0005', 'WHC03', 'WHC03'), 1.5);
  assert.equal(stock(after, '01-0009', 'WHC03', 'WHC03') - stock(before, '01-0009', 'WHC03', 'WHC03'), 1);
});
check('Saved basket and claim draft cleared', () => {
  assert.equal(after.basket[0].status, 'empty');
  assert.equal(after.cart.length, 0);
  assert.equal(after.cartClaims.length, 0);
});
const report = { sale: sale.doc_no, pu: pu.doc_no, passed: checks.length, checks };
fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
