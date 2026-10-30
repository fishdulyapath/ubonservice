require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 8000,
});

async function main() {
  const checks = [
    ['supplier', "SELECT code,name_1 FROM ap_supplier WHERE code='AP0186'"],
    ['branches', 'SELECT code,name_1 FROM erp_branch_list ORDER BY code LIMIT 10'],
    ['pu_formats', "SELECT code,name_1 FROM erp_doc_format WHERE screen_code='PU' ORDER BY code LIMIT 10"],
    ['claim_tables', `SELECT to_regclass('public.sml_staff_claim_item') AS item,
      to_regclass('public.sml_staff_claim_branch') AS branch,
      to_regclass('public.sml_staff_cart_claim') AS cart,
      to_regclass('public.sml_staff_sale_claim') AS sale`],
    ['staff_tables', `SELECT to_regclass('public.staff_cart_order') AS cart,
      to_regclass('public.pos_basket') AS basket,
      to_regclass('public.sml_staff_permission') AS permission,
      to_regclass('public.sml_sale_premium_backlog') AS web_backlog,
      to_regclass('public.sml_sml_promotion_backlog') AS sml_backlog`],
    ['premium_tables', `SELECT to_regclass('public.sml_sale_premium') AS master,
      to_regclass('public.sml_sale_premium_condition') AS conditions,
      to_regclass('public.sml_sale_premium_free_list') AS free_list,
      to_regclass('public.sml_staff_basket_access') AS basket_access`],
    ['basket_columns', `SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('pos_basket','staff_cart_order')
      AND column_name IN ('doc_format_code','form_code','sml_promotion_backlog_id','sale_premium_code','guid_code')
      ORDER BY table_name,column_name`],
    ['warehouses', 'SELECT code,name_1 FROM ic_warehouse ORDER BY code LIMIT 20'],
    ['shelves', 'SELECT whcode,code,name_1 FROM ic_shelf ORDER BY whcode,code LIMIT 30'],
    ['pos', 'SELECT pos_id,branch_code,pos_ic_wht,pos_ic_shelf FROM pos_id ORDER BY pos_id LIMIT 10'],
    ['supplier_columns', `SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' AND table_name='ap_supplier'
      ORDER BY ordinal_position`],
    ['supplier_sample', 'SELECT code FROM ap_supplier ORDER BY code LIMIT 10'],
    ['erp_user_required_columns', `SELECT column_name,data_type,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='erp_user' AND is_nullable='NO'
      ORDER BY ordinal_position`],
  ];
  for (const [name, sql] of checks) {
    const result = await pool.query(sql);
    console.log(name, JSON.stringify(result.rows));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
