CREATE TABLE IF NOT EXISTS sml_staff_claim_item (
  item_code VARCHAR(25) PRIMARY KEY,
  can_claim BOOLEAN NOT NULL DEFAULT FALSE,
  is_claim_item BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(25) NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sml_staff_claim_branch (
  branch_code VARCHAR(25) PRIMARY KEY,
  wh_code VARCHAR(25) NOT NULL,
  shelf_code VARCHAR(25) NOT NULL,
  pu_doc_format_code VARCHAR(25) NOT NULL DEFAULT 'PU',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(25) NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sml_staff_cart_claim (
  cart_key VARCHAR(50) NOT NULL,
  sale_guid VARCHAR(100) NOT NULL,
  line_no INTEGER NOT NULL,
  claim_item_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) NOT NULL,
  qty NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  quoted_unit_price NUMERIC(18,4) NOT NULL CHECK (quoted_unit_price >= 0),
  quoted_amount NUMERIC(18,2) NOT NULL CHECK (quoted_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cart_key, sale_guid, line_no)
);

CREATE INDEX IF NOT EXISTS sml_staff_cart_claim_sale_idx ON sml_staff_cart_claim (cart_key, sale_guid);

CREATE TABLE IF NOT EXISTS sml_staff_sale_claim (
  sale_doc_no VARCHAR(50) NOT NULL,
  sale_line_no INTEGER NOT NULL,
  pu_doc_no VARCHAR(50) NOT NULL,
  pu_line_no INTEGER NOT NULL,
  claim_item_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) NOT NULL,
  qty NUMERIC(18,4) NOT NULL,
  unit_price NUMERIC(18,4) NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sale_doc_no, pu_line_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS sml_staff_sale_claim_pu_line_idx ON sml_staff_sale_claim (pu_doc_no, pu_line_no);
