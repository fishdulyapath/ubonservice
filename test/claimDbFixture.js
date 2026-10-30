require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: String(process.env.DB_HOST || '').replace(/^https?:\/\//, ''),
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});

async function main() {
  if (process.argv[2] !== '--apply' || process.env.DB_NAME !== 'wawacrm') {
    throw new Error('Use --apply with DB_NAME=wawacrm for this test fixture');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const basket = await client.query('SELECT basket_id FROM pos_basket WHERE basket_id=32028 FOR UPDATE');
    if (basket.rows.length) throw new Error('test basket 32028 already exists; do not overwrite it');
    await client.query(`INSERT INTO ap_supplier (code,name_1,remark,create_code)
      SELECT 'AP0186','[TEST] รับสินค้าเคลม','Fixture for claim-sale test on wawacrm','CODEX'
      WHERE NOT EXISTS (SELECT 1 FROM ap_supplier WHERE code='AP0186')`);
    await client.query(`INSERT INTO sml_staff_claim_branch
      (branch_code,wh_code,shelf_code,pu_doc_format_code,updated_by)
      VALUES ('0000','WHC03','WHC03','PU','CODEX')`);
    await client.query(`INSERT INTO sml_staff_claim_item (item_code,can_claim,is_claim_item,updated_by)
      VALUES ('01-0048',TRUE,FALSE,'CODEX'),('01-0005',FALSE,TRUE,'CODEX')`);
    await client.query(`INSERT INTO pos_basket
      (basket_id,cust_code,cust_name,inquiry_type,vat_type,vat_rate,sale_code,sale_name,
       doc_format_code,form_code,status)
      VALUES (32028,'AR00001','เงินสดปลีก',1,1,7,'CODEX','CODEX','INV','','active')`);
    await client.query('COMMIT');
    console.log('fixture ready: basket 32028, sale 01-0048, claim 01-0005, AP0186');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
