ALTER TABLE bot_settings DROP COLUMN typebot_public_id;
UPDATE bot_settings SET mode = 'menu' WHERE mode = 'typebot';
ALTER TABLE bot_settings DROP CONSTRAINT bot_settings_mode_check;
ALTER TABLE bot_settings ADD CONSTRAINT bot_settings_mode_check CHECK (mode IN ('menu', 'ai', 'menu_ai'));
