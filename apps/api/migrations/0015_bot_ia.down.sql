DROP TABLE ai_calls;
ALTER TABLE bot_test_sessions DROP COLUMN history;
ALTER TABLE bot_settings DROP COLUMN ai_daily_per_phone, DROP COLUMN ai_monthly_limit_usd, DROP COLUMN ai_plan;
UPDATE bot_settings SET mode = 'menu';
ALTER TABLE bot_settings DROP CONSTRAINT bot_settings_mode_check;
ALTER TABLE bot_settings ADD CONSTRAINT bot_settings_mode_check CHECK (mode IN ('menu'));
