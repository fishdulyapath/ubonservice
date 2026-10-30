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
  const checks = [
    ['sale_formats', "SELECT code,name_1 FROM erp_doc_format WHERE screen_code='SI' ORDER BY code LIMIT 20"],
    ['customers', "SELECT code,name_1 FROM ar_customer WHERE COALESCE(status,0)=0 ORDER BY code LIMIT 12"],
    ['products', `SELECT i.code,i.name_1,i.unit_standard,i.balance_qty,u.code AS unit_code,
      COALESCE(u.stand_value,1) AS stand_value,COALESCE(u.divide_value,1) AS divide_value
      FROM ic_inventory i JOIN ic_unit_use u ON u.ic_code=i.code
      WHERE COALESCE(i.balance_qty,0)>10 AND COALESCE(i.item_type,0)=0
      ORDER BY i.code LIMIT 25`],
    ['empty_baskets', `SELECT basket_id,cust_code,status FROM pos_basket
      WHERE NOT EXISTS (SELECT 1 FROM staff_cart_order c WHERE c.cust_code='BASKET-'||pos_basket.basket_id::text)
      ORDER BY basket_id DESC LIMIT 10`],
    ['supplier_ap0186', "SELECT code,name_1 FROM ap_supplier WHERE code='AP0186'"],
  ];
  for (const [name, sql] of checks) {
    try {
      console.log(name, JSON.stringify((await pool.query(sql)).rows));
    } catch (error) {
      console.log(name, 'ERROR', error.message);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
