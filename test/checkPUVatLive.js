require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
  host: String(process.env.DB_HOST || '').replace(/^https?:\/\//, ''),
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});
async function main() {
  const docNo = process.argv[2] || 'PU-26110001';
  await client.connect();
  const header = await client.query(`SELECT doc_no,trans_flag,vat_type,vat_rate,total_value,total_before_vat,
    total_vat_value,total_after_vat,total_except_vat,total_amount,discount_word
    FROM ic_trans WHERE doc_no=$1 AND trans_flag=12`, [docNo]);
  const details = await client.query(`SELECT d.item_code,d.unit_code,d.qty,d.price,d.sum_amount,d.tax_type AS line_tax_type,
    i.tax_type AS master_tax_type,d.vat_type AS line_vat_type
    FROM ic_trans_detail d LEFT JOIN ic_inventory i ON i.code=d.item_code
    WHERE d.doc_no=$1 AND d.trans_flag=12 ORDER BY d.line_number`, [docNo]);
  console.log(JSON.stringify({ db: process.env.DB_NAME, header: header.rows, details: details.rows }));
}
main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; })
  .finally(() => client.end());
