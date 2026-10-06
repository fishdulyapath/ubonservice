-- SML quantity-price promotion backlog.
-- Additive migration: existing web free-gift promotion backlog remains unchanged.

BEGIN;

CREATE TABLE IF NOT EXISTS sml_sml_promotion_backlog (
  roworder SERIAL PRIMARY KEY,
  guid_code VARCHAR(50) DEFAULT '',
  cust_code VARCHAR(25) NOT NULL,
  cust_name VARCHAR(255) DEFAULT '',
  source_doc_no VARCHAR(25) DEFAULT '',
  source_doc_date DATE,
  origin_request_ref VARCHAR(60) DEFAULT '',
  source_basket_id VARCHAR(25) DEFAULT '',
  source_cart_guid VARCHAR(50) DEFAULT '',
  sale_code VARCHAR(25) DEFAULT '',
  creator_code VARCHAR(25) DEFAULT '',
  pricing_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) DEFAULT 'open',
  remark TEXT DEFAULT '',
  create_date_time_now TIMESTAMP DEFAULT NOW(),
  update_date_time_now TIMESTAMP DEFAULT NOW(),
  close_date_time_now TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS sml_sml_promotion_backlog_detail (
  roworder SERIAL PRIMARY KEY,
  backlog_id INTEGER NOT NULL,
  source_line_guid VARCHAR(50) DEFAULT '',
  line_number INTEGER DEFAULT 0,
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
  original_qty NUMERIC(18,4) DEFAULT 0,
  full_price_qty NUMERIC(18,4) DEFAULT 0,
  delivered_qty NUMERIC(18,4) DEFAULT 0,
  pending_qty NUMERIC(18,4) DEFAULT 0,
  pricing_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) DEFAULT 'open',
  create_date_time_now TIMESTAMP DEFAULT NOW(),
  update_date_time_now TIMESTAMP DEFAULT NOW(),
  close_date_time_now TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS sml_sml_promotion_backlog_delivery (
  roworder SERIAL PRIMARY KEY,
  backlog_id INTEGER NOT NULL,
  backlog_detail_id INTEGER NOT NULL,
  doc_no VARCHAR(25) DEFAULT '',
  doc_date DATE,
  item_code VARCHAR(25) DEFAULT '',
  unit_code VARCHAR(25) DEFAULT '',
  qty NUMERIC(18,4) DEFAULT 0,
  unit_price NUMERIC(18,4) DEFAULT 0,
  discount_word VARCHAR(255) DEFAULT '',
  sum_amount NUMERIC(18,2) DEFAULT 0,
  wh_code VARCHAR(25) DEFAULT '',
  shelf_code VARCHAR(25) DEFAULT '',
  creator_code VARCHAR(25) DEFAULT '',
  is_initial_delivery SMALLINT DEFAULT 0,
  create_date_time_now TIMESTAMP DEFAULT NOW()
);

ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sml_promotion_backlog_id INTEGER DEFAULT 0;
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sml_promotion_backlog_detail_id INTEGER DEFAULT 0;
ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sml_promotion_full_qty NUMERIC(18,4) DEFAULT 0;

CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_customer_idx
  ON sml_sml_promotion_backlog (cust_code, status, create_date_time_now);
CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_source_doc_idx
  ON sml_sml_promotion_backlog (source_doc_no);
CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_detail_open_idx
  ON sml_sml_promotion_backlog_detail (item_code, unit_code, status, backlog_id);
CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_delivery_detail_idx
  ON sml_sml_promotion_backlog_delivery (backlog_detail_id);
CREATE INDEX IF NOT EXISTS staff_cart_order_sml_promotion_backlog_detail_idx
  ON staff_cart_order (sml_promotion_backlog_detail_id);

COMMIT;
