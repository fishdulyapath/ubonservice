-- Sale premium/free-gift promotion + customer backlog migration.
-- Safe to run more than once on production before deploying smlstaff/backend.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Sale premium master
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sml_sale_premium (
  roworder SERIAL PRIMARY KEY,
  premium_code VARCHAR(25) NOT NULL,
  name_1 VARCHAR(255) DEFAULT '',
  date_begin DATE,
  date_end DATE,
  important SMALLINT DEFAULT 0,
  remark TEXT DEFAULT '',
  guid_code VARCHAR(50) DEFAULT '',
  creator_code VARCHAR(25) DEFAULT '',
  create_date_time_now TIMESTAMP DEFAULT NOW()
);

ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS roworder SERIAL;
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS premium_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS name_1 VARCHAR(255) DEFAULT '';
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS date_begin DATE;
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS date_end DATE;
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS important SMALLINT DEFAULT 0;
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS remark TEXT DEFAULT '';
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS guid_code VARCHAR(50) DEFAULT '';
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS creator_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium ADD COLUMN IF NOT EXISTS create_date_time_now TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS sml_sale_premium_code_uq
  ON sml_sale_premium (premium_code);

CREATE TABLE IF NOT EXISTS sml_sale_premium_condition (
  roworder SERIAL PRIMARY KEY,
  premium_code VARCHAR(25) NOT NULL,
  ic_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) DEFAULT '',
  qty NUMERIC(18,4) DEFAULT 0,
  stand_value NUMERIC(18,4) DEFAULT 1,
  divide_value NUMERIC(18,4) DEFAULT 1
);

ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS roworder SERIAL;
ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS premium_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS ic_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS unit_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS stand_value NUMERIC(18,4) DEFAULT 1;
ALTER TABLE sml_sale_premium_condition ADD COLUMN IF NOT EXISTS divide_value NUMERIC(18,4) DEFAULT 1;

CREATE INDEX IF NOT EXISTS sml_sale_premium_condition_code_idx
  ON sml_sale_premium_condition (premium_code);

CREATE TABLE IF NOT EXISTS sml_sale_premium_free_list (
  roworder SERIAL PRIMARY KEY,
  premium_code VARCHAR(25) NOT NULL,
  ic_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) DEFAULT '',
  qty NUMERIC(18,4) DEFAULT 0,
  stand_value NUMERIC(18,4) DEFAULT 1,
  divide_value NUMERIC(18,4) DEFAULT 1
);

ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS roworder SERIAL;
ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS premium_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS ic_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS unit_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS stand_value NUMERIC(18,4) DEFAULT 1;
ALTER TABLE sml_sale_premium_free_list ADD COLUMN IF NOT EXISTS divide_value NUMERIC(18,4) DEFAULT 1;

CREATE INDEX IF NOT EXISTS sml_sale_premium_free_list_code_idx
  ON sml_sale_premium_free_list (premium_code);

-- ---------------------------------------------------------------------------
-- 2) Sale premium backlog
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sml_sale_premium_backlog (
  roworder SERIAL PRIMARY KEY,
  guid_code VARCHAR(50) DEFAULT '',
  cust_code VARCHAR(25) NOT NULL,
  cust_name VARCHAR(255) DEFAULT '',
  premium_code VARCHAR(25) NOT NULL,
  premium_name VARCHAR(255) DEFAULT '',
  source_doc_no VARCHAR(25) DEFAULT '',
  source_basket_id VARCHAR(25) DEFAULT '',
  source_cart_guid VARCHAR(50) DEFAULT '',
  pack_qty NUMERIC(18,4) DEFAULT 0,
  sale_code VARCHAR(25) DEFAULT '',
  creator_code VARCHAR(25) DEFAULT '',
  status VARCHAR(20) DEFAULT 'open',
  remark TEXT DEFAULT '',
  create_date_time_now TIMESTAMP DEFAULT NOW(),
  update_date_time_now TIMESTAMP DEFAULT NOW(),
  close_date_time_now TIMESTAMP NULL
);

ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS roworder SERIAL;
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS guid_code VARCHAR(50) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS cust_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS cust_name VARCHAR(255) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS premium_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS premium_name VARCHAR(255) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS source_doc_no VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS source_basket_id VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS source_cart_guid VARCHAR(50) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS pack_qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS sale_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS creator_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS remark TEXT DEFAULT '';
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS create_date_time_now TIMESTAMP DEFAULT NOW();
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS update_date_time_now TIMESTAMP DEFAULT NOW();
ALTER TABLE sml_sale_premium_backlog ADD COLUMN IF NOT EXISTS close_date_time_now TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_cust_idx
  ON sml_sale_premium_backlog (cust_code, status);

CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_premium_idx
  ON sml_sale_premium_backlog (premium_code, status);

CREATE TABLE IF NOT EXISTS sml_sale_premium_backlog_detail (
  roworder SERIAL PRIMARY KEY,
  backlog_id INTEGER NOT NULL,
  guid_code VARCHAR(50) DEFAULT '',
  line_number INTEGER DEFAULT 0,
  line_type VARCHAR(10) DEFAULT 'sale',
  item_code VARCHAR(25) NOT NULL,
  item_name VARCHAR(255) DEFAULT '',
  unit_code VARCHAR(25) DEFAULT '',
  barcode VARCHAR(50) DEFAULT '',
  wh_code VARCHAR(25) DEFAULT '',
  shelf_code VARCHAR(25) DEFAULT '',
  stand_value NUMERIC(18,4) DEFAULT 1,
  divide_value NUMERIC(18,4) DEFAULT 1,
  ratio NUMERIC(18,4) DEFAULT 1,
  tax_type SMALLINT DEFAULT 0,
  target_qty NUMERIC(18,4) DEFAULT 0,
  delivered_qty NUMERIC(18,4) DEFAULT 0,
  pending_qty NUMERIC(18,4) DEFAULT 0,
  unit_price NUMERIC(18,4) DEFAULT 0,
  sum_amount NUMERIC(18,2) DEFAULT 0,
  is_permium SMALLINT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'open',
  create_date_time_now TIMESTAMP DEFAULT NOW(),
  update_date_time_now TIMESTAMP DEFAULT NOW(),
  close_date_time_now TIMESTAMP NULL
);

ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS roworder SERIAL;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS backlog_id INTEGER NOT NULL;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS guid_code VARCHAR(50) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS line_number INTEGER DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS line_type VARCHAR(10) DEFAULT 'sale';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS item_code VARCHAR(25) NOT NULL;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS item_name VARCHAR(255) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS unit_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS barcode VARCHAR(50) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS wh_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS shelf_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS stand_value NUMERIC(18,4) DEFAULT 1;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS divide_value NUMERIC(18,4) DEFAULT 1;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS ratio NUMERIC(18,4) DEFAULT 1;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS tax_type SMALLINT DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS target_qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS delivered_qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS pending_qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS sum_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS is_permium SMALLINT DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS create_date_time_now TIMESTAMP DEFAULT NOW();
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS update_date_time_now TIMESTAMP DEFAULT NOW();
ALTER TABLE sml_sale_premium_backlog_detail ADD COLUMN IF NOT EXISTS close_date_time_now TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_detail_backlog_idx
  ON sml_sale_premium_backlog_detail (backlog_id, status);

CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_detail_item_idx
  ON sml_sale_premium_backlog_detail (item_code, status);

CREATE TABLE IF NOT EXISTS sml_sale_premium_backlog_delivery (
  roworder SERIAL PRIMARY KEY,
  backlog_id INTEGER NOT NULL,
  backlog_detail_id INTEGER NOT NULL,
  doc_no VARCHAR(25) DEFAULT '',
  doc_date DATE,
  item_code VARCHAR(25) DEFAULT '',
  unit_code VARCHAR(25) DEFAULT '',
  qty NUMERIC(18,4) DEFAULT 0,
  unit_price NUMERIC(18,4) DEFAULT 0,
  sum_amount NUMERIC(18,2) DEFAULT 0,
  wh_code VARCHAR(25) DEFAULT '',
  shelf_code VARCHAR(25) DEFAULT '',
  creator_code VARCHAR(25) DEFAULT '',
  create_date_time_now TIMESTAMP DEFAULT NOW()
);

ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS roworder SERIAL;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS backlog_id INTEGER NOT NULL;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS backlog_detail_id INTEGER NOT NULL;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS doc_no VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS doc_date DATE;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS item_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS unit_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS qty NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,4) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS sum_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS wh_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS shelf_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS creator_code VARCHAR(25) DEFAULT '';
ALTER TABLE sml_sale_premium_backlog_delivery ADD COLUMN IF NOT EXISTS create_date_time_now TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_delivery_detail_idx
  ON sml_sale_premium_backlog_delivery (backlog_detail_id);

-- ---------------------------------------------------------------------------
-- 3) Columns used while items are still in the staff basket/cart
-- ---------------------------------------------------------------------------

ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_code VARCHAR(25) DEFAULT '';
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_name VARCHAR(255) DEFAULT '';
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_line_type VARCHAR(10) DEFAULT '';
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_backlog_id INTEGER DEFAULT 0;
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_backlog_detail_id INTEGER DEFAULT 0;
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS is_permium SMALLINT DEFAULT 0;

CREATE INDEX IF NOT EXISTS staff_cart_order_premium_backlog_detail_idx
  ON staff_cart_order (sale_premium_backlog_detail_id);

-- ---------------------------------------------------------------------------
-- 4) Mark persisted sale rows that are free-gift rows in ic_trans_detail
-- ---------------------------------------------------------------------------

ALTER TABLE ic_trans_detail ADD COLUMN IF NOT EXISTS is_permium SMALLINT DEFAULT 0;

CREATE INDEX IF NOT EXISTS ic_trans_detail_doc_premium_idx
  ON ic_trans_detail (doc_no, is_permium);

COMMIT;
