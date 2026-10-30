// Exercises real PU inserts/updates inside one transaction and always rolls them back.
// Run manually: node test/puSaveRollbackSmoke.js --rollback-test
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pool } = require('../src/db');
const { savePUDocTransaction } = require('../src/routes/purchase');
const { loadPurchaseDocument, loadPrintFormOptions, loadFormDesignRows } = require('../src/routes/purchasePrint');
const { calculatePUDocument } = require('../src/utils/puPricing');
const { renderSalePrintHtml, formatThaiBaht } = require('../src/utils/salePrintRenderer');

const value = (row, key) => Number(row[key] || 0);
const near = (actual, expected, field) =>
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 0.011, `${field}: ${actual} != ${expected}`);
const printMoney = (amount) => Number(amount).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

async function inspectPrintForm(docNo, expected, formRows, dbQuery, previewPath = '') {
  const data = await loadPurchaseDocument(docNo, dbQuery);
  assert.ok(data, 'print route could not load the uncommitted PU document');
  near(data.header.total_amount, expected.totals.total_amount, 'print.header.total_amount');
  near(data.details[0].sum_amount, expected.items[0].sum_amount, 'print.detail.sum_amount');
  const html = renderSalePrintHtml({ formRows, data, autoPrint: false });
  for (const [field, amount] of [
    ['line_amount', expected.items[0].sum_amount],
    ['total_value', expected.totals.total_value],
    ['total_discount', expected.totals.total_discount],
    ['total_before_vat', expected.totals.total_before_vat],
    ['total_vat_value', expected.totals.total_vat_value],
    ['total_amount', expected.totals.total_amount],
  ]) {
    assert.ok(html.includes(`>${printMoney(amount)}<`),
      `print HTML omits ${field}=${printMoney(amount)}`);
  }
  assert.ok(html.includes(formatThaiBaht(expected.totals.total_amount)), 'print HTML omits amount in Thai words');
  assert.ok(html.includes(`>${expected.items[0].discount}<`), 'print HTML omits item discount word');
  if (previewPath) fs.writeFileSync(previewPath, html, 'utf8');
  return { formcodes: formRows.map((row) => row.formcode),
    line_amount: expected.items[0].sum_amount,
    bill_discount: expected.totals.total_discount,
    vat_base: expected.totals.total_before_vat,
    vat: expected.totals.total_vat_value,
    total: expected.totals.total_amount };
}

async function inspect(client, docNo, expected, { cash }) {
  const headerRes = await client.query(`SELECT inquiry_type, vat_type, total_value, total_discount, discount_word,
      total_before_vat, total_vat_value, total_after_vat, total_except_vat, total_amount
      FROM ic_trans WHERE doc_no=$1 AND trans_flag=12`, [docNo]);
  const detailRes = await client.query(`SELECT qty, price, discount, discount_amount, sum_amount, tax_type
    FROM ic_trans_detail WHERE doc_no=$1 AND trans_flag=12 ORDER BY line_number`, [docNo]);
  const vatRes = await client.query(`SELECT vat_base_amount, vat_amount, vat_total_amount
    FROM gl_journal_vat_buy WHERE doc_no=$1 AND trans_flag=12`, [docNo]);
  const cashRes = await client.query(`SELECT total_amount, total_net_amount, cash_amount, tranfer_amount
    FROM cb_trans WHERE doc_no=$1 AND trans_flag=12`, [docNo]);
  assert.equal(headerRes.rows.length, 1);
  assert.equal(detailRes.rows.length, 1);
  assert.equal(vatRes.rows.length, 1);
  assert.equal(cashRes.rows.length, cash ? 1 : 0);
  const header = headerRes.rows[0];
  const detail = detailRes.rows[0];
  const vat = vatRes.rows[0];
  for (const field of [
    'total_value', 'total_discount', 'total_before_vat', 'total_vat_value',
    'total_after_vat', 'total_except_vat', 'total_amount',
  ]) near(header[field], expected.totals[field], `header.${field}`);
  near(detail.discount_amount, expected.items[0].discount_amount, 'detail.discount_amount');
  near(detail.sum_amount, expected.items[0].sum_amount, 'detail.sum_amount');
  near(vat.vat_base_amount, header.total_before_vat, 'GL.vat_base_amount');
  near(vat.vat_amount, header.total_vat_value, 'GL.vat_amount');
  if (cash) {
    near(cashRes.rows[0].total_amount, header.total_amount, 'CB.total_amount');
    near(cashRes.rows[0].total_net_amount, header.total_amount, 'CB.total_net_amount');
  }
  return {
    doc_no: docNo, vat_type: header.vat_type, inquiry_type: header.inquiry_type,
    discount_word: header.discount_word, line_discount: detail.discount,
    total_value: value(header, 'total_value'), total_discount: value(header, 'total_discount'),
    total_before_vat: value(header, 'total_before_vat'),
    total_vat_value: value(header, 'total_vat_value'),
    total_amount: value(header, 'total_amount'),
    detail_sum: value(detail, 'sum_amount'), gl_rows: vatRes.rows.length,
    cash_rows: cashRes.rows.length,
  };
}

async function main() {
  if (process.argv[2] !== '--rollback-test' || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Use --rollback-test with DB_NAME=wawacrm');
  }
  const client = await pool.connect();
  let transactionOpen = false;
  let docNo = '';
  try {
    const templateRes = await client.query(`SELECT t.cust_code, t.branch_code, t.doc_format_code,
      t.creator_code, d.item_code, d.item_name, d.unit_code, d.wh_code, d.shelf_code,
      d.stand_value, d.divide_value
      FROM ic_trans t JOIN ic_trans_detail d
        ON d.doc_no=t.doc_no AND d.trans_flag=t.trans_flag
      WHERE t.trans_flag=12 AND COALESCE(t.last_status,0)=0
        AND COALESCE(t.doc_format_code,'')<>'' AND COALESCE(d.item_code,'')<>''
        AND COALESCE(d.wh_code,'')<>'' AND COALESCE(d.shelf_code,'')<>''
        AND d.qty>0 AND d.price>0
      ORDER BY t.doc_date DESC,t.doc_no DESC,d.line_number LIMIT 1`);
    const template = templateRes.rows[0];
    assert.ok(template, 'no usable PU item exists for rollback smoke test');
    const optionRes = await client.query(`SELECT item_amount_decimal, item_price_decimal,
      discout_type, discount_vat_type, discount_step_round_off,
      calc_item_price_discount, round_type FROM erp_option LIMIT 1`);
    const options = optionRes.rows[0];
    const stockBefore = await client.query('SELECT balance_qty FROM ic_inventory WHERE code=$1', [template.item_code]);
    const item = {
      item_code: template.item_code, item_name: template.item_name,
      unit_code: template.unit_code, wh_code: template.wh_code, shelf_code: template.shelf_code,
      stand_value: template.stand_value, divide_value: template.divide_value,
      qty: 2, price: 500, discount: '1,1%,2', tax_type: 0,
    };
    const createExpected = calculatePUDocument([item], '10,2%', 7, 0, options);
    const body = {
      doc_date: '2026-10-30', doc_time: '10:00', doc_format_code: template.doc_format_code,
      cust_code: template.cust_code, branch_code: template.branch_code || '',
      emp_code: template.creator_code || 'CODEX', creator_code: 'PU_ROLLBACK_TEST',
      remark: '[TEST ROLLBACK] PU discount save',
      tax_doc_no: 'PU-ROLLBACK-TEST', tax_doc_date: '2026-10-30',
      wh_from: template.wh_code, location_from: template.shelf_code,
      sale_type: 1, tax_type: 0, vat_rate: 7,
      discount_word: '10,2%', cash_amount: createExpected.totals.total_amount,
      transfer_amount: 0, rounded_amount: 0,
      total_value: 1, total_amount: 1, total_discount: 0,
      items: [{ ...item, sum_amount: 1, discount_amount: 0 }],
      doc_list: [], payment_detail: [],
    };
    await client.query('BEGIN');
    transactionOpen = true;
    const created = await savePUDocTransaction(client, body, 'create');
    docNo = created.doc_no;
    const createdValues = await inspect(client, docNo, createExpected, { cash: true });
    let queryQueue = Promise.resolve();
    const transactionQuery = (sql, params) => {
      const current = queryQueue.then(() => client.query(sql, params));
      queryQueue = current.then(() => {}, () => {});
      return current;
    };
    const printOptions = await loadPrintFormOptions(docNo, transactionQuery);
    const formCodes = printOptions.forms.filter((form) => form.available).map((form) => form.formcode);
    assert.ok(formCodes.length, 'PU document format has no available print form');
    const formRows = await loadFormDesignRows(formCodes, transactionQuery);
    const printResults = [];
    printResults.push({ case: '1,1%,2 + 10,2%', tax_type: 0,
      ...(await inspectPrintForm(docNo, createExpected, formRows, transactionQuery)) });

    const updatedItem = { ...item, discount: '5%' };
    const updateExpected = calculatePUDocument([updatedItem], '10%', 7, 1, options);
    const updated = {
      ...body, doc_no: docNo, sale_type: 0, tax_type: 1,
      cash_amount: 0, discount_word: '10%',
      items: [{ ...updatedItem, sum_amount: 1, discount_amount: 0 }],
    };
    await savePUDocTransaction(client, updated, 'update');
    const updatedValues = await inspect(client, docNo, updateExpected, { cash: false });
    const noVatValues = [];
    for (const taxType of [2, 3]) {
      const noVatExpected = calculatePUDocument([updatedItem], '10%', 7, taxType, options);
      await savePUDocTransaction(client, { ...updated, tax_type: taxType }, 'update');
      noVatValues.push(await inspect(client, docNo, noVatExpected, { cash: false }));
    }
    const serviceValues = [];
    for (const saleType of [2, 3]) {
      const expected = calculatePUDocument([updatedItem], '10%', 7, 1, options);
      await savePUDocTransaction(client, {
        ...updated, sale_type: saleType,
        cash_amount: saleType === 3 ? expected.totals.total_amount : 0,
      }, 'update');
      serviceValues.push(await inspect(client, docNo, expected, { cash: saleType === 3 }));
    }
    // Independent decimal reference for qty 2 × price 500 under this tenant's 7% VAT settings.
    const discountCases = [
      // item, bill, line, bill reduction, outside base, outside VAT, outside net, inside base, inside VAT, inside net
      ['1', '1', 999, 1, 998, 69.86, 1067.86, 932.71, 65.29, 998],
      ['1', '1%', 999, 9.99, 989.01, 69.23, 1058.24, 924.31, 64.70, 989.01],
      ['1', '1,1%', 999, 10.98, 988.02, 69.16, 1057.18, 923.38, 64.64, 988.02],
      ['1%', '1', 990, 1, 989, 69.23, 1058.23, 924.30, 64.70, 989],
      ['1%', '1%', 990, 9.90, 980.10, 68.61, 1048.71, 915.98, 64.12, 980.10],
      ['1%', '1,1%', 990, 10.89, 979.11, 68.54, 1047.65, 915.06, 64.05, 979.11],
      ['1,1%', '1', 989.01, 1, 988.01, 69.16, 1057.17, 923.37, 64.64, 988.01],
      ['1,1%', '1%', 989.01, 9.89, 979.12, 68.54, 1047.66, 915.07, 64.05, 979.12],
      ['1,1%', '1,1%', 989.01, 10.88, 978.13, 68.47, 1046.60, 914.14, 63.99, 978.13],
    ];
    const discountMatrix = [];
    for (const [lineWord, billWord, lineAmount, billReduction,
      outsideBase, outsideVat, outsideNet, insideBase, insideVat, insideNet] of discountCases) {
      for (const taxType of [0, 1]) {
        const matrixItem = { ...item, discount: lineWord };
        const expected = calculatePUDocument([matrixItem], billWord, 7, taxType, options);
        near(expected.items[0].sum_amount, lineAmount, 'reference.line_amount');
        near(expected.totals.total_discount, billReduction, 'reference.bill_discount');
        near(expected.totals.total_before_vat, taxType === 0 ? outsideBase : insideBase, 'reference.vat_base');
        near(expected.totals.total_vat_value, taxType === 0 ? outsideVat : insideVat, 'reference.vat');
        near(expected.totals.total_amount, taxType === 0 ? outsideNet : insideNet, 'reference.net');
        await savePUDocTransaction(client, {
          ...updated, tax_type: taxType, discount_word: billWord,
          items: [{ ...matrixItem, sum_amount: 1, discount_amount: 0 }],
        }, 'update');
        const stored = await inspect(client, docNo, expected, { cash: false });
        discountMatrix.push({ item_discount: lineWord, bill_discount: billWord, tax_type: taxType,
          line_amount: stored.detail_sum, bill_reduction: stored.total_discount,
          vat_base: stored.total_before_vat, vat: stored.total_vat_value, net: stored.total_amount });
        printResults.push({ case: `${lineWord} + ${billWord}`, tax_type: taxType,
          ...(await inspectPrintForm(docNo, expected, formRows, transactionQuery,
            lineWord === '1,1%' && billWord === '1,1%' && taxType === 0
              ? (process.argv[3] || '') : '')) });
      }
    }
    await client.query('ROLLBACK');
    transactionOpen = false;
    const after = await client.query('SELECT 1 FROM ic_trans WHERE doc_no=$1 AND trans_flag=12', [docNo]);
    assert.equal(after.rows.length, 0, 'rollback left a PU document behind');
    const stockAfter = await client.query('SELECT balance_qty FROM ic_inventory WHERE code=$1', [template.item_code]);
    assert.deepEqual(stockAfter.rows, stockBefore.rows, 'rollback changed inventory.balance_qty');
    console.log(JSON.stringify({ created: createdValues, updated: updatedValues,
      no_vat: noVatValues, service_purchase: serviceValues, discount_matrix: discountMatrix,
      print_forms: { checked: printResults.length,
        formcodes: [...new Set(printResults.flatMap((row) => row.formcodes))] },
      rolled_back: true, stock_unchanged: true }));
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.code || error.name, error.message);
  process.exitCode = 1;
});
