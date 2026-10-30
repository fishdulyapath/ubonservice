// Read-only evidence for the real UI sale/claim test. Never creates or cancels documents.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { pool, query } = require('../src/db');
const outDir = path.resolve(__dirname, '../../test-evidence/claim-live-20261030');
async function main() {
  if (process.env.DB_NAME !== 'wawacrm') throw new Error('Expected wawacrm database');
  const mode = process.argv[2];
  const stock = async () => {
    const result = [];
    for (const item of ['01-0004', '01-0005', '01-0009']) {
      const rows = await query("SELECT * FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, '', '')", [item]);
      result.push({ item_code: item, rows: rows.rows });
    }
    return result;
  };
  let data;
  if (mode === 'before') {
    data = {
      database: process.env.DB_NAME,
      basket: (await query('SELECT * FROM pos_basket WHERE basket_id=32028')).rows,
      cart: (await query("SELECT item_code,unit_code,qty FROM staff_cart_order WHERE cust_code='BASKET-32028'")).rows,
      config: (await query("SELECT * FROM sml_staff_claim_branch WHERE branch_code='0000'")).rows,
      flags: (await query("SELECT * FROM sml_staff_claim_item WHERE item_code IN ('01-0004','01-0005','01-0009')")).rows,
      erp: (await query('SELECT vat_rate,discout_type,discount_vat_type,item_amount_decimal,item_price_decimal,round_type FROM erp_option LIMIT 1')).rows,
      stock: await stock(),
    };
  } else if (mode === 'after') {
    const sale = process.argv[3];
    if (!sale) throw new Error('Provide sale document number');
    const links = (await query('SELECT * FROM sml_staff_sale_claim WHERE sale_doc_no=$1 ORDER BY sale_line_no,pu_line_no', [sale])).rows;
    const docs = [...new Set([sale, ...links.map(row => row.pu_doc_no)])];
    data = {
      sale_doc_no: sale, links,
      headers: (await query('SELECT doc_no,doc_date,trans_flag,doc_ref,remark,cust_code,inquiry_type,vat_type,vat_rate,doc_format_code,total_value,total_discount,total_before_vat,total_vat_value,total_after_vat,total_except_vat,total_amount,last_status FROM ic_trans WHERE doc_no=ANY($1::text[]) ORDER BY trans_flag', [docs])).rows,
      details: (await query('SELECT doc_no,trans_flag,line_number,item_code,unit_code,qty,price,discount,discount_amount,sum_amount,tax_type,wh_code,shelf_code,stand_value,divide_value,calc_flag,last_status FROM ic_trans_detail WHERE doc_no=ANY($1::text[]) ORDER BY trans_flag,line_number', [docs])).rows,
      cash: (await query('SELECT doc_no,trans_flag,total_amount,total_net_amount,cash_amount,pay_cash_amount,money_change,tranfer_amount FROM cb_trans WHERE doc_no=ANY($1::text[])', [docs])).rows,
      saleVat: (await query('SELECT * FROM gl_journal_vat_sale WHERE doc_no=$1', [sale])).rows,
      purchaseVat: (await query('SELECT * FROM gl_journal_vat_buy WHERE doc_no=ANY($1::text[])', [docs])).rows,
      basket: (await query('SELECT basket_id,status,cust_code FROM pos_basket WHERE basket_id=32028')).rows,
      cart: (await query("SELECT item_code,qty FROM staff_cart_order WHERE cust_code='BASKET-32028'")).rows,
      cartClaims: (await query("SELECT * FROM sml_staff_cart_claim WHERE cart_key='BASKET-32028'")).rows,
      stock: await stock(),
    };
  } else if (mode === 'schema') {
    console.log(JSON.stringify((await query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('sml_staff_sale_claim','gl_journal_vat_sale','cb_trans') ORDER BY table_name,ordinal_position")).rows));
    return;
  } else { throw new Error('Use before, after DOC_NO, or schema'); }
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, `${mode}.json`);
  fs.writeFileSync(output, JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
