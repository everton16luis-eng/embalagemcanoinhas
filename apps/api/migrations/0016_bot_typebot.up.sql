-- Bot, etapa 3: forma Typebot (docs/11-typebot.md).
ALTER TABLE bot_settings DROP CONSTRAINT bot_settings_mode_check;
ALTER TABLE bot_settings ADD CONSTRAINT bot_settings_mode_check CHECK (mode IN ('menu', 'ai', 'menu_ai', 'typebot'));
-- ID publico do fluxo publicado no Typebot (o final do endereco bot.<dominio>/<id>).
ALTER TABLE bot_settings ADD COLUMN typebot_public_id text CHECK (typebot_public_id ~ '^[A-Za-z0-9_-]{1,100}$');
