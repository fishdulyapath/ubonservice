-- Audit columns for manually cancelled promotion backlog lines.
-- Cancellation is soft: delivery history and the original entitlement remain available for review.

BEGIN;

ALTER TABLE sml_sale_premium_backlog_detail
  ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(25) DEFAULT '';

ALTER TABLE sml_sale_premium_backlog_detail
  ADD COLUMN IF NOT EXISTS cancelled_date_time_now TIMESTAMP NULL;

ALTER TABLE sml_sml_promotion_backlog_detail
  ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(25) DEFAULT '';

ALTER TABLE sml_sml_promotion_backlog_detail
  ADD COLUMN IF NOT EXISTS cancelled_date_time_now TIMESTAMP NULL;

COMMIT;
