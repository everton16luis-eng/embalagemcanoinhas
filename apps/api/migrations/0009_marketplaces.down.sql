DROP TABLE IF EXISTS marketplace_notifications;
DROP TABLE IF EXISTS marketplace_orders;
DROP TABLE IF EXISTS marketplace_listings;
DROP TABLE IF EXISTS marketplace_oauth_states;
DROP TABLE IF EXISTS marketplace_accounts;
ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('pix', 'card'));
ALTER TABLE orders DROP CONSTRAINT orders_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_channel_check CHECK (channel IN ('store', 'sales_desk'));
