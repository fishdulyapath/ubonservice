-- Migration: เพิ่มรหัสเอกสารให้ตะกร้า POS
-- ใช้สำหรับเลือก pattern running จาก erp_doc_format.screen_code = 'SI'

ALTER TABLE IF EXISTS pos_basket
  ADD COLUMN IF NOT EXISTS doc_format_code VARCHAR(50) NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS pos_basket
  ADD COLUMN IF NOT EXISTS form_code VARCHAR(255) NOT NULL DEFAULT '';
