DROP TABLE bot_test_sessions;
DROP TABLE bot_settings;
DROP TABLE bot_runs;
DROP TABLE whatsapp_conversations;
ALTER TABLE whatsapp_inbound DROP COLUMN reply_id;
-- Mensagens interativas ja enviadas impedem voltar a restricao antiga: viram texto.
UPDATE whatsapp_messages SET kind = 'text' WHERE kind = 'interactive';
ALTER TABLE whatsapp_messages DROP COLUMN source, DROP COLUMN payload;
ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_kind_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_kind_check CHECK (kind IN ('template', 'text'));
