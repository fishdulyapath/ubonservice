// Runs a real claim/PU save against wawacrm inside one transaction, then rolls it back.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { quoteClaim, capClaimQuotes, applyClaimDiscount, buildClaimPUPayload } = require('../src/utils/saleClaim');
const { savePUDocTransaction } = require('../src/routes/purchase');
const { loadPurchaseDocument } = require('../src/routes/purchasePrint');
const { calcVat } = require('../src/utils/vatHelper');

const client = new Client({
  host: String(process.env.DB_HOST || '').replace(/^https?:\/\//, ''),
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});

async function main() {
  if (process.env.DB_NAME !== 'wawacrm') throw new Error('Only wawacrm is allowed for this live test');
  await client.connect();
  await client.query('BEGIN');
  let report;
  try {
    const schema = await client.query(`SELECT to_regclass('public.sml_staff_claim_unit_price') AS price_table`);
    if (!schema.rows[0].price_table) throw new Error('Apply the claim price migration first');
    for (const [item, unit, price] of [
      ['01-0005', 'ชิ้น', 70], ['01-0005', 'ลัง24', 2186], ['01-0009', 'ชิ้น', 50],
    ]) {
      await client.query(`INSERT INTO sml_staff_claim_unit_price (item_code,unit_code,claim_price,updated_by)
        VALUES ($1,$2,$3,'CODEX-ROLLBACK-TEST')
        ON CONFLICT (item_code,unit_code) DO UPDATE SET claim_price=$3,updated_by='CODEX-ROLLBACK-TEST'`,
      [item, unit, price]);
    }
    const query = client.query.bind(client);
    const raw = await Promise.all([
      quoteClaim(query, { item_code: '01-0005', unit_code: 'ชิ้น', qty: 1 }),
      quoteClaim(query, { item_code: '01-0009', unit_code: 'ชิ้น', qty: 1 }),
    ]);
    const box = await quoteClaim(query, { item_code: '01-0005', unit_code: 'ลัง24', qty: 1 });
    const quotes = capClaimQuotes(raw, 92);
    const sale = { qty: 1, price: 92, sum_amount: 92, discount_amount: 0, discount: '' };
    applyClaimDiscount(sale, {}, quotes.reduce((sum, row) => sum + row.amount, 0));
    const [saleBeforeVat, saleVat, , saleTotal] = calcVat(1, 7, 0, sale.sum_amount, 0);
    const branchResult = await query(`SELECT wh_code,shelf_code,pu_doc_format_code FROM sml_staff_claim_branch
      WHERE branch_code IN ('','0000') ORDER BY CASE WHEN branch_code='' THEN 0 ELSE 1 END LIMIT 1`);
    if (!branchResult.rows[0]) throw new Error('No claim warehouse configuration');
    const docDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const payload = buildClaimPUPayload({ claimQuotes: quotes, branch: branchResult.rows[0],
      docNo: 'CODEX-ROLLBACK-SALE', docDate, docTime: '10:00', branchCode: '',
      empCode: 'CODEX', creatorCode: 'CODEX' });
    const saved = await savePUDocTransaction(client, payload, 'create');
    const pu = await query(`SELECT doc_no,total_value,total_vat_value,total_amount FROM ic_trans
      WHERE trans_flag=12 AND doc_no=$1`, [saved.doc_no]);
    const detail = await query(`SELECT line_number,item_code,unit_code,qty,price,sum_amount
      FROM ic_trans_detail WHERE trans_flag=12 AND doc_no=$1 ORDER BY line_number`, [saved.doc_no]);
    const printed = await loadPurchaseDocument(saved.doc_no, query);
    report = {
      db: process.env.DB_NAME,
      sale_item: '01-0004', sale_price: 92,
      claim_prices: raw.map((row) => ({ item_code: row.item_code, unit_code: row.unit_code,
        configured_unit_price: row.configured_unit_price, original_amount: row.configured_amount })),
      other_unit: { item_code: box.item_code, unit_code: box.unit_code,
        configured_unit_price: box.configured_unit_price },
      applied_claims: quotes.map((row) => ({ item_code: row.item_code, qty: row.qty,
        configured_unit_price: row.configured_unit_price, applied_unit_price: row.unit_price, amount: row.amount })),
      sale: { discount: sale.discount_amount, net_before_vat: saleBeforeVat, vat: saleVat, total: saleTotal },
      pu: pu.rows[0], pu_details: detail.rows,
      print: { total_amount: printed.header.total_amount,
        detail_amounts: printed.details.map((row) => Number(row.amount)) },
      doc_no: saved.doc_no,
    };
    if (Number(report.pu.total_amount) !== 92 || Number(report.pu.total_vat_value) !== 0
      || Number(report.print.total_amount) !== 92
      || report.pu_details.reduce((sum, row) => sum + Number(row.sum_amount), 0) !== 92) {
      throw new Error('PU, detail, or print totals differ from the claim discount');
    }
  } finally {
    await client.query('ROLLBACK');
  }
  const remains = await client.query(`SELECT COUNT(*)::int AS count FROM ic_trans
    WHERE doc_no=$1 AND trans_flag=12`, [report.doc_no]);
  report.rolled_back = Number(remains.rows[0].count) === 0;
  const target = path.join(__dirname, 'claim-live-result.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => client.end());
