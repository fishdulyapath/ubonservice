-- Speeds up per-item reservation lookups across active staff baskets.
CREATE INDEX IF NOT EXISTS staff_cart_order_item_cust_code_idx
  ON staff_cart_order (item_code, cust_code);
