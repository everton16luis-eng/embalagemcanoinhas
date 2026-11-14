-- Auditoria 11/2026: a vitrine busca a foto principal de cada card com
-- WHERE product_id = ? ORDER BY is_primary DESC, position LIMIT 1, e so havia o indice parcial (WHERE is_primary).
-- Medido em transacao desfeita com 20 mil fotos: pagina de 24 cards de 57 ms para 8 ms.
-- Tabela pequena e gravada so pelo painel ao enviar foto; o bloqueio do CREATE INDEX e instantaneo.
CREATE INDEX product_images_product_order ON product_images (product_id, is_primary DESC, position);
