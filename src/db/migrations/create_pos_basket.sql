-- Migration: สร้าง pos_basket table สำหรับระบบตะกร้า POS
-- Run once on target DB. Safe to re-run (IF NOT EXISTS + ON CONFLICT).


CREATE TABLE public.staff_cart_order ( 
    roworder serial, 
    cust_code character varying(255), 
    guid_code character varying(255), 
    item_code character varying(255), 
    unit_code character varying(255), 
    item_type numeric DEFAULT 0, 
    qty numeric DEFAULT 0, 
    create_datetime timestamp without time zone DEFAULT now(), 
    price numeric DEFAULT 0, 
    wh_code character varying(255), 
    shelf_code character varying(255), 
    creator_code character varying(255), 
    barcode character varying(255), 
    item_name character varying(255), 
    stand_value numeric DEFAULT 1, 
    divide_value numeric DEFAULT 1, 
    ratio numeric DEFAULT 1, 
    remark character varying(255), 
    CONSTRAINT staff_cart_order_pk PRIMARY KEY (roworder) 
    );
    
CREATE TABLE IF NOT EXISTS pos_basket (
  basket_id     SMALLINT      PRIMARY KEY,
  cust_code     VARCHAR(50)   NOT NULL DEFAULT '',
  cust_name     VARCHAR(255)  NOT NULL DEFAULT '',
  inquiry_type  SMALLINT      NOT NULL DEFAULT 1,
  vat_type      SMALLINT      NOT NULL DEFAULT 1,
  vat_rate      NUMERIC(5,2)  NOT NULL DEFAULT 7.00,
  sale_code     VARCHAR(50)   NOT NULL DEFAULT '',
  sale_name     VARCHAR(255)  NOT NULL DEFAULT '',
  doc_format_code VARCHAR(50) NOT NULL DEFAULT '',
  form_code     VARCHAR(255)  NOT NULL DEFAULT '',
  status        VARCHAR(10)   NOT NULL DEFAULT 'empty',
  updated_at    TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- Seed 100 baskets (safe to re-run)
INSERT INTO pos_basket (basket_id)
SELECT generate_series(1, 100)
ON CONFLICT (basket_id) DO NOTHING;
