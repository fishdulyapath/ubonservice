CREATE TABLE IF NOT EXISTS sml_staff_permission (
  user_code varchar(50) NOT NULL,
  permission_key varchar(100) NOT NULL,
  is_allowed boolean NOT NULL DEFAULT true,
  updated_at timestamp without time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_code, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_sml_staff_permission_user
  ON sml_staff_permission (UPPER(user_code));
