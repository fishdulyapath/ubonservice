-- Migration: เพิ่ม UNIQUE constraint บน ic_inventory_price_formula
-- จำเป็นสำหรับ saveProductPriceFormula ที่ใช้ ON CONFLICT
-- Safe to re-run (IF NOT EXISTS pattern)

-- Step 1: ลบแถวซ้ำเก่า (เก็บแถวล่าสุด ตาม ctid)
DELETE FROM ic_inventory_price_formula a
USING ic_inventory_price_formula b
WHERE a.ctid < b.ctid
  AND a.ic_code = b.ic_code
  AND a.sale_type = b.sale_type
  AND a.tax_type = b.tax_type
  AND a.unit_code = b.unit_code
  AND a.currency_code = b.currency_code;

-- Step 2: เพิ่ม UNIQUE constraint (ถ้ายังไม่มี)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ic_inventory_price_formula_unique'
  ) THEN
    ALTER TABLE ic_inventory_price_formula
    ADD CONSTRAINT ic_inventory_price_formula_unique
    UNIQUE (ic_code, sale_type, tax_type, unit_code, currency_code);
  END IF;
END $$;
