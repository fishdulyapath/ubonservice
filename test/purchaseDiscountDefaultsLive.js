// Run against wawacrm with session-local temporary master rows only.
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const { lookupPurchaseItemDefaults, checkAutoPurchaseDefaults } = require('../src/routes/purchase');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE ap_supplier_detail (ap_code text, discount_item text, discount_bill text) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE ic_inventory_detail (ic_code text, discount text) ON COMMIT DROP');
    await client.query(`CREATE TEMP TABLE ic_inventory_purchase_price (
      roworder integer, ic_code text, unit_code text, supplier_code text,
      price_type integer, sale_type integer, transport_type integer,
      from_date date, to_date date, from_qty numeric, to_qty numeric,
      sale_price1 numeric, sale_price2 numeric, discount text
    ) ON COMMIT DROP`);
    await client.query("INSERT INTO ap_supplier_detail VALUES ('AP-DEMO','2%','5%'),('AP-EMPTY','','')");
    await client.query("INSERT INTO ic_inventory_detail VALUES ('ITEM-A','3%'),('ITEM-B',''),('ITEM-C','')");
    await client.query(`INSERT INTO ic_inventory_purchase_price VALUES
      (1,'ITEM-A','EA','AP-DEMO',3,2,0,'2026-01-01','2027-12-31',1,10,100,107,'7%'),
      (2,'ITEM-A','EA','',1,2,0,'2026-01-01','2027-12-31',1,10,110,117,'4%'),
      (3,'ITEM-C','EA','AP-DEMO',3,2,0,'2026-01-01','2027-12-31',1,10,50,53.5,'')`);
    const context = { supplierCode: 'AP-DEMO', docDate: '2026-11-02', taxType: 0, saleType: 0 };
    const request = (item_code, qty, request_id) => ({ item_code, unit_code: 'EA', qty, request_id });
    const rows = await lookupPurchaseItemDefaults(client.query.bind(client), {
      ...context,
      items: [request('ITEM-A', 2, 0), request('ITEM-B', 2, 1), request('ITEM-C', 2, 2), request('ITEM-A', 11, 3)],
    });
    assert.deepEqual(rows.map(({ discount, discount_source }) => [discount, discount_source]), [
      ['7%', 'purchase_price'], ['2%', 'supplier'], ['', 'purchase_price'], ['3%', 'item'],
    ]);
    assert.deepEqual(rows.map(({ price }) => price == null ? null : Number(price)), [100, null, 50, null]);
    const inclusive = await lookupPurchaseItemDefaults(client.query.bind(client), {
      ...context, taxType: 1, items: [request('ITEM-A', 2, 0)],
    });
    assert.equal(Number(inclusive[0].price), 107);
    const empty = await lookupPurchaseItemDefaults(client.query.bind(client), {
      ...context, supplierCode: 'AP-EMPTY', items: [request('ITEM-B', 2, 0)],
    });
    assert.equal(empty[0].discount_source, 'none');
    assert.equal(empty[0].discount, '');
    const payload = {
      cust_code: 'AP-DEMO', doc_date: '2026-11-02', tax_type: 0, sale_type: 0,
      discount_word: '5%', auto_bill_discount: true,
      items: [{ item_code: 'ITEM-A', unit_code: 'EA', qty: 2, price: 100,
        discount: '7%', auto_purchase_price: true, auto_purchase_discount: true }],
    };
    assert.deepEqual(await checkAutoPurchaseDefaults(client, payload), []);
    await client.query("UPDATE ic_inventory_purchase_price SET discount='8%' WHERE roworder=1");
    assert.deepEqual(await checkAutoPurchaseDefaults(client, payload), ['purchase discount changed: line 1']);
    console.log('purchase discount defaults: 6 lookup cases and save recheck passed (temporary rows, rollback)');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
