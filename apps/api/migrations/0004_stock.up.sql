-- Estoque, fornecedores, compras e inventario.
-- Tudo na UNIDADE BASE da variacao. Saldo so muda por movimento (livro imutavel).
-- Custos em centavos por unidade base, com 4 casas (um copo pode custar 4,37 centavos).

-- Saldo por variacao. Disponivel = fisico - reservado; negativo indica falta (venda sob encomenda).
CREATE TABLE stock_balances (
  variant_id      uuid PRIMARY KEY REFERENCES product_variants (id),
  on_hand         numeric(14,3) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved        numeric(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  avg_cost_cents  numeric(16,4) NOT NULL DEFAULT 0 CHECK (avg_cost_cents >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_movements (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id       uuid NOT NULL REFERENCES product_variants (id),
  kind             text NOT NULL CHECK (kind IN ('receipt', 'sale', 'return', 'loss', 'damage', 'adjustment', 'inventory', 'reserve', 'release')),
  on_hand_delta    numeric(14,3) NOT NULL DEFAULT 0,
  reserved_delta   numeric(14,3) NOT NULL DEFAULT 0,
  on_hand_after    numeric(14,3) NOT NULL,
  reserved_after   numeric(14,3) NOT NULL,
  unit_cost_cents  numeric(16,4),
  avg_cost_after   numeric(16,4) NOT NULL,
  source_type      text CHECK (source_type IN ('purchase_receipt', 'order', 'cart', 'quote', 'inventory', 'manual', 'reservation')),
  source_id        text,
  reason           text CHECK (length(reason) <= 300),
  request_key      text UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_nonzero CHECK (on_hand_delta <> 0 OR reserved_delta <> 0),
  CONSTRAINT stock_movements_reason CHECK (kind NOT IN ('loss', 'damage', 'adjustment') OR reason IS NOT NULL)
);
CREATE INDEX stock_movements_variant_idx ON stock_movements (variant_id, id DESC);
CREATE INDEX stock_movements_sales_idx ON stock_movements (variant_id, created_at) WHERE kind = 'sale';
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reservas: carrinho em checkout, pedido aguardando pagamento ou separacao.
CREATE TABLE stock_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id   uuid NOT NULL REFERENCES product_variants (id),
  qty          numeric(14,3) NOT NULL CHECK (qty > 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released', 'expired')),
  -- Sob encomenda: a reserva pode ser maior que o fisico; a diferenca vira necessidade de compra.
  backorder    boolean NOT NULL DEFAULT false,
  source_type  text NOT NULL CHECK (source_type IN ('order', 'cart', 'quote', 'manual')),
  source_id    text NOT NULL,
  expires_at   timestamptz,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  CONSTRAINT stock_reservations_closed CHECK ((status = 'active') = (closed_at IS NULL))
);
CREATE INDEX stock_reservations_active_idx ON stock_reservations (variant_id) WHERE status = 'active';
CREATE INDEX stock_reservations_expiry_idx ON stock_reservations (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE UNIQUE INDEX stock_reservations_source_unique ON stock_reservations (source_type, source_id, variant_id) WHERE status = 'active';

CREATE TABLE suppliers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  legal_name       text CHECK (length(legal_name) <= 150),
  document         text CHECK (document ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  state_registration text CHECK (state_registration ~ '^[0-9]{2,14}$'),
  email            citext CHECK (length(email) <= 254),
  phone            text CHECK (phone ~ '^[0-9]{10,13}$'),
  whatsapp         text CHECK (whatsapp ~ '^[0-9]{12,13}$'),
  website          text CHECK (length(website) <= 200),
  city             text CHECK (length(city) <= 60),
  uf               text CHECK (uf ~ '^[A-Z]{2}$'),
  payment_terms    text CHECK (length(payment_terms) <= 200),
  lead_time_days   integer CHECK (lead_time_days BETWEEN 0 AND 180),
  min_order_cents  bigint CHECK (min_order_cents >= 0),
  freight_terms    text CHECK (length(freight_terms) <= 200),
  notes            text CHECK (length(notes) <= 2000),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_document_unique ON suppliers (document) WHERE document IS NOT NULL;

CREATE TABLE supplier_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  role         text CHECK (length(role) <= 60),
  email        citext CHECK (length(email) <= 254),
  phone        text CHECK (phone ~ '^[0-9]{10,13}$')
);

-- Oferta do fornecedor: quanto custa a embalagem de compra e em quanto tempo entrega.
CREATE TABLE supplier_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  packaging_id    uuid NOT NULL REFERENCES packagings (id),
  supplier_sku    text CHECK (length(supplier_sku) <= 60),
  cost_cents      bigint NOT NULL CHECK (cost_cents > 0),
  lead_time_days  integer CHECK (lead_time_days BETWEEN 0 AND 180),
  quoted_at       date NOT NULL DEFAULT current_date,
  active          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, packaging_id)
);

CREATE SEQUENCE purchase_order_number START 1;
CREATE TABLE purchase_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             integer NOT NULL UNIQUE DEFAULT nextval('purchase_order_number'),
  supplier_id        uuid NOT NULL REFERENCES suppliers (id),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'partial', 'received', 'canceled')),
  expected_at        date,
  -- Frete de aquisicao e outras despesas: rateados no custo dos itens, proporcional ao valor.
  freight_cents      bigint NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  other_costs_cents  bigint NOT NULL DEFAULT 0 CHECK (other_costs_cents >= 0),
  notes              text CHECK (length(notes) <= 2000),
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  closed_at          timestamptz,
  cancel_reason      text CHECK (length(cancel_reason) <= 300),
  version            integer NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE purchase_order_number OWNED BY purchase_orders.number;

CREATE TABLE purchase_order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  packaging_id       uuid NOT NULL REFERENCES packagings (id),
  -- Copia da embalagem no momento do pedido: mudar o cadastro depois nao altera a compra.
  packaging_label    text NOT NULL,
  base_qty_per_pack  numeric(14,3) NOT NULL CHECK (base_qty_per_pack > 0),
  packs              numeric(12,3) NOT NULL CHECK (packs > 0),
  pack_cost_cents    bigint NOT NULL CHECK (pack_cost_cents >= 0),
  received_packs     numeric(12,3) NOT NULL DEFAULT 0 CHECK (received_packs >= 0),
  CONSTRAINT purchase_order_items_not_over CHECK (received_packs <= packs),
  UNIQUE (order_id, packaging_id)
);

CREATE TABLE purchase_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES purchase_orders (id),
  request_key  text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 100),
  invoice_ref  text CHECK (length(invoice_ref) <= 60),
  notes        text CHECK (length(notes) <= 1000),
  received_by  uuid NOT NULL REFERENCES users (id),
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_receipt_items (
  receipt_id            uuid NOT NULL REFERENCES purchase_receipts (id),
  item_id               uuid NOT NULL REFERENCES purchase_order_items (id),
  packs                 numeric(12,3) NOT NULL CHECK (packs > 0),
  base_qty              numeric(14,3) NOT NULL CHECK (base_qty > 0),
  -- Custo final por unidade base: embalagem + parte do frete e das despesas.
  unit_cost_cents       numeric(16,4) NOT NULL CHECK (unit_cost_cents >= 0),
  allocated_extra_cents numeric(16,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (receipt_id, item_id)
);
CREATE TRIGGER purchase_receipts_immutable BEFORE UPDATE OR DELETE ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER purchase_receipt_items_immutable BEFORE UPDATE OR DELETE ON purchase_receipt_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE inventory_counts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'canceled')),
  notes       text CHECK (length(notes) <= 1000),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid REFERENCES users (id),
  closed_at   timestamptz
);
-- So uma contagem aberta por vez: duas contagens simultaneas ajustariam o mesmo saldo duas vezes.
CREATE UNIQUE INDEX inventory_counts_one_open ON inventory_counts ((true)) WHERE status = 'open';

CREATE TABLE inventory_count_items (
  count_id      uuid NOT NULL REFERENCES inventory_counts (id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  counted_qty   numeric(14,3) CHECK (counted_qty >= 0),
  -- Preenchidos no fechamento: o que o sistema tinha e a diferenca lancada.
  system_qty    numeric(14,3),
  diff_qty      numeric(14,3),
  counted_by    uuid REFERENCES users (id),
  counted_at    timestamptz,
  PRIMARY KEY (count_id, variant_id)
);

GRANT SELECT, INSERT, UPDATE ON stock_balances, stock_reservations TO loja_app;
GRANT SELECT, INSERT ON stock_movements, purchase_receipts, purchase_receipt_items TO loja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers, supplier_contacts, supplier_products, purchase_order_items, inventory_count_items TO loja_app;
GRANT SELECT, INSERT, UPDATE ON purchase_orders, inventory_counts TO loja_app;
GRANT USAGE ON SEQUENCE purchase_order_number TO loja_app;
