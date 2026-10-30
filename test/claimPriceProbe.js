require('dotenv').config();
const { Pool } = require('pg');
const { getProductPriceLocalx } = require('../src/utils/priceHelper');

const pool = new Pool({
  host: String(process.env.DB_HOST || '').replace(/^https?:\/\//, ''),
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});

async function main() {
  const customers = await pool.query("SELECT code,name_1 FROM ar_customer WHERE code LIKE 'AR%' ORDER BY code LIMIT 5");
  console.log('customers', JSON.stringify(customers.rows));
  const customer = customers.rows[0]?.code || 'AR0269';
  for (const code of ['01-0004', '01-0005', '01-0009', '01-0048']) {
    const [stock, price] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(balance_qty),0) AS qty
        FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, 'MMA01', 'SH101')`, [code]),
      getProductPriceLocalx(code, 'ชิ้น', '1', customer, 1, 7, 1),
    ]);
    console.log(code, 'stock', stock.rows[0]?.qty, 'price', JSON.stringify(price.data?.[0] || null));
  }
  const three = await getProductPriceLocalx('01-0048', 'ชิ้น', '3', customer, 1, 7, 1);
  console.log('01-0048 qty=3 price', JSON.stringify(three.data?.[0] || null));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
