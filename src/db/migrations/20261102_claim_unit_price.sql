CREATE TABLE IF NOT EXISTS sml_staff_claim_unit_price (
  item_code VARCHAR(25) NOT NULL,
  unit_code VARCHAR(25) NOT NULL,
  claim_price NUMERIC(18,4) NOT NULL CHECK (claim_price >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(25) NOT NULL DEFAULT '',
  PRIMARY KEY (item_code, unit_code)
);

ALTER TABLE sml_staff_cart_claim
  ADD COLUMN IF NOT EXISTS configured_unit_price NUMERIC(18,4);

ALTER TABLE sml_staff_sale_claim
  ADD COLUMN IF NOT EXISTS configured_unit_price NUMERIC(18,4);
