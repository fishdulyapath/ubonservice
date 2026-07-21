CREATE TABLE IF NOT EXISTS sml_staff_basket_access (
  user_code varchar(25) PRIMARY KEY,
  allow_all_baskets boolean NOT NULL DEFAULT true,
  basket_range_text text NOT NULL DEFAULT '',
  basket_ids integer[] NOT NULL DEFAULT '{}',
  other_staff_basket_level smallint NOT NULL DEFAULT 3,
  can_edit_other_basket boolean,
  can_edit_other_items boolean,
  can_save_other_sale boolean,
  updated_by varchar(25) NOT NULL DEFAULT '',
  updated_at timestamp NOT NULL DEFAULT NOW()
);

ALTER TABLE sml_staff_basket_access
  ADD COLUMN IF NOT EXISTS can_edit_other_basket boolean;

ALTER TABLE sml_staff_basket_access
  ADD COLUMN IF NOT EXISTS can_edit_other_items boolean;

ALTER TABLE sml_staff_basket_access
  ADD COLUMN IF NOT EXISTS can_save_other_sale boolean;

CREATE INDEX IF NOT EXISTS idx_sml_staff_basket_access_user
  ON sml_staff_basket_access (UPPER(user_code));