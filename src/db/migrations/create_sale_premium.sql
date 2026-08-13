CREATE TABLE IF NOT EXISTS sml_sale_premium (
  roworder SERIAL PRIMARY KEY,
  premium_code VARCHAR(25) NOT NULL,
  name_1 VARCHAR(255) NOT NULL,
  date_begin DATE,
  date_end DATE,
  important SMALLINT DEFAULT 0,
  remark VARCHAR(255) DEFAULT '',
  guid_code VARCHAR(50) DEFAULT '',
  creator_code VARCHAR(25) DEFAULT '',
  create_date_time_now TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sml_sale_premium_code_uq
  ON sml_sale_premium (premium_code);

CREATE TABLE IF NOT EXISTS sml_sale_premium_condition (
  roworder SERIAL PRIMARY KEY,
  premium_code VARCHAR(25) NOT NULL,
  ic_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) NOT NULL,
  qty NUMERIC(18,4) DEFAULT 0,
  stand_value NUMERIC(18,4) DEFAULT 1,
  divide_value NUMERIC(18,4) DEFAULT 1
);

CREATE INDEX IF NOT EXISTS sml_sale_premium_condition_code_idx
  ON sml_sale_premium_condition (premium_code);

CREATE TABLE IF NOT EXISTS sml_sale_premium_free_list (
  roworder SERIAL PRIMARY KEY,
  premium_code VARCHAR(25) NOT NULL,
  ic_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) NOT NULL,
  qty NUMERIC(18,4) DEFAULT 0,
  stand_value NUMERIC(18,4) DEFAULT 1,
  divide_value NUMERIC(18,4) DEFAULT 1
);

CREATE INDEX IF NOT EXISTS sml_sale_premium_free_list_code_idx
  ON sml_sale_premium_free_list (premium_code);
