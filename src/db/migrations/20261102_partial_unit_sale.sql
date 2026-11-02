ALTER TABLE staff_cart_order
  ADD COLUMN IF NOT EXISTS partial_source_unit_code VARCHAR(25) NOT NULL DEFAULT '';
