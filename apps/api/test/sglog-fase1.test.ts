import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { testDatabaseProblem, testEnvProblem, TEST_DB_MARK } from './env-guard.js';
import { allocateOrder, appRole, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 1 (docs/15-sglog-fase1.md): depositos, saldo por deposito, abertura, conferencia, papeis e travas.

let app: FastifyInstance;
let fake: FakeProvider;
let boss: Awaited<ReturnType<typeof loggedAs>>;
let pickupId: string;

beforeAll(async () => {
  fake = new FakeProvider();
  app = await makeApp(undefined, fake);
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  const p = await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', description: 'Centro', baseCents: 0, minDays: 0, maxDays: 1 });
  expect(p.statusCode, p.body).toBe(201);
  pickupId = p.json().option.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const S = '/api/v1/admin/stock';
const key = () => `k-${uid()}-${uid()}`;

type Pack = { id: string; kind: string; label: string; base_qty: string };
async function newProduct(stock = '0') {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  if (stock !== '0') await move(v.id, 'adjustment', stock);
  const packs = v.packagings as Pack[];
  return { variantId: v.id as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!, purchase: packs.find((k) => k.kind === 'purchase')! };
}
async function move(variantId: string, kind: 'adjustment' | 'loss' | 'damage' | 'return', qty: string) {
  const r = await boss.post(`${S}/movements`, { variantId, kind, qty, reason: 'Teste da Fase 1', requestKey: key() });
  expect(r.statusCode, r.body).toBe(201);
  return r;
}
async function reserveManual(variantId: string, qty: string) {
  const r = await boss.post(`${S}/reservations`, { variantId, qty, sourceId: `teste-${uid()}` });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().reservation.id as string;
}

const totals = async (variantId: string) => {
  const b = (await owner.query('SELECT on_hand, reserved FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0];
  const l = (await owner.query('SELECT coalesce(sum(on_hand), 0)::numeric(14,3)::text AS on_hand, coalesce(sum(reserved), 0)::numeric(14,3)::text AS reserved FROM stock_location_balances WHERE variant_id = $1', [variantId])).rows[0];
  return { total: [b?.on_hand ?? '0.000', b?.reserved ?? '0.000'], location: [l.on_hand, l.reserved] };
};

type Rec = { run_id: string; check_code: string; field: string | null; variant_id: string | null; expected: string; found: string };
/** Conferencia pelo papel da aplicacao (prova que ele pode executar). Devolve so as divergencias. */
async function reconcile() {
  const rows = (await appRole.query<Rec>('SELECT run_id, check_code, field, variant_id, expected, found FROM stock_reconcile()')).rows;
  const run = rows.find((r) => r.check_code === 'run')!;
  expect(run).toBeDefined();
  return rows.filter((r) => r.check_code !== 'run');
}

const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '47999990000', document: '529.982.247-25' };
/** Pedido real pela loja, pago com cartao (provedor de teste), pronto e com NF-e simulada: pronto para despachar. */
async function readyOrder(packs = 2) {
  const { pack50, variantId } = await newProduct('500');
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload ? { payload } : {}) });
    for (const c of res.cookies) if (c.value) jar[c.name] = c.value;
    return res;
  };
  await send('POST', '/api/v1/public/cart/items', { packagingId: pack50.id, packs });
  const cart = (await send('GET', '/api/v1/public/cart')).json().cart;
  const placed = await send('POST', '/api/v1/public/checkout', { requestKey: `pedido-${uid()}`, buyer, shippingOptionId: pickupId, paymentMethod: 'card', expectedTotalCents: cart.subtotalCents });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  const paid = await send('POST', `/api/v1/public/orders/${o.token}/pay/card`, { attemptKey: randomUUID(), token: 'approve-1', paymentMethodId: 'visa', installments: 1, payer: { email: 'm@teste.local' } });
  expect(paid.statusCode, paid.body).toBe(200);
  const A = `/api/v1/admin/orders/${o.id}`;
  let order = (await boss.get(A)).json().order;
  expect(order.status).toBe('paid');
  order = (await boss.post(`${A}/status`, { to: 'preparing', version: order.version })).json().order;
  order = (await boss.post(`${A}/status`, { to: 'ready', version: order.version })).json().order;
  // A emissao da NF-e nao e assunto desta fase: o teste simula a autorizacao, como em store.test.ts.
  await owner.query(`UPDATE orders SET invoice_status = 'authorized' WHERE id = $1`, [o.id]);
  return { id: o.id, version: order.version as number, variantId };
}

const pgError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string; message: string };
  }
  throw new Error('a operacao deveria ter sido recusada');
};

describe('depósito padrão', () => {
  it('existe exatamente um, ativo, sem endereço inventado; um segundo padrão é recusado', async () => {
    const { rows } = await owner.query(`SELECT code, name, is_default, active, cep, city FROM warehouses WHERE is_default`);
    expect(rows).toEqual([{ code: 'PRINCIPAL', name: 'Depósito principal', is_default: true, active: true, cep: null, city: null }]);
    const dup = await pgError(owner.query(`INSERT INTO warehouses (code, name, is_default) VALUES ('OUTRO', 'Outro', true)`));
    expect(dup.code).toBe('23505');
  });
});

describe('saldo por depósito acompanha o saldo total', () => {
  it('entrada, perda, avaria, devolução, reserva, liberação e baixa pelo código atual', async () => {
    const { variantId } = await newProduct('100');
    await move(variantId, 'loss', '3');
    await move(variantId, 'damage', '2');
    await move(variantId, 'return', '1');
    await move(variantId, 'adjustment', '-6');
    const r1 = await reserveManual(variantId, '10');
    expect((await boss.post(`${S}/reservations/${r1}/release`)).statusCode).toBe(200);
    const r2 = await reserveManual(variantId, '5');
    expect((await boss.post(`${S}/reservations/${r2}/consume`)).statusCode).toBe(200);
    await reserveManual(variantId, '4');
    const t = await totals(variantId);
    expect(t.total).toEqual(['85.000', '4.000']);
    expect(t.location).toEqual(t.total);
    // Todos os movimentos ficam no deposito padrao: nulo (codigo de pedido, reserva e compra) ou o padrao explicito
    // (lancamentos manuais da Fase 3).
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1 AND warehouse_id IS NOT NULL AND warehouse_id <> (SELECT id FROM warehouses WHERE is_default)', [variantId])).rows[0].n,
    ).toBe(0);
    expect(await reconcile()).toEqual([]);
  });

  it('pedido real: checkout, pagamento, despacho e entrega sem nenhuma divergência', async () => {
    const o = await readyOrder(3);
    expect((await totals(o.variantId)).location).toEqual(['500.000', '150.000']);
    await allocateOrder(boss, o.id);
    const sent = await boss.post(`/api/v1/admin/orders/${o.id}/dispatch`, { version: o.version, carrier: 'Próprio', volumes: 1 });
    expect(sent.statusCode, sent.body).toBe(200);
    const t = await totals(o.variantId);
    expect(t.total).toEqual(['350.000', '0.000']);
    expect(t.location).toEqual(t.total);
    expect(await reconcile()).toEqual([]);
  });

  it('reservas simultâneas: só cabe o que existe, e o depósito acompanha o total', async () => {
    const { variantId } = await newProduct('50');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => boss.post(`${S}/reservations`, { variantId, qty: '10', sourceId: `corrida-${i}-${uid()}` })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    const t = await totals(variantId);
    expect(t.total).toEqual(['50.000', '50.000']);
    expect(t.location).toEqual(t.total);
    expect(await reconcile()).toEqual([]);
  });

  it('saída maior que o saldo continua devolvendo INSUFFICIENT_STOCK, sem erro novo', async () => {
    const { variantId } = await newProduct('5');
    const res = await boss.post(`${S}/movements`, { variantId, kind: 'loss', qty: '6', reason: 'Teste', requestKey: key() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK');
    expect((await totals(variantId)).location).toEqual(['5.000', '0.000']);
  });
});

describe('saldo alterado sem movimento', () => {
  it('a aplicação não consegue mudar o saldo total sem gravar o movimento', async () => {
    const { variantId } = await newProduct('10');
    const upd = await pgError(appRole.query('UPDATE stock_balances SET on_hand = on_hand + 1 WHERE variant_id = $1', [variantId]));
    expect(upd.code).toBe('23001');
    expect(upd.constraint).toBe('stock_balances_requires_movement');
    const res = await pgError(appRole.query('UPDATE stock_balances SET reserved = reserved + 1 WHERE variant_id = $1', [variantId]));
    expect(res.constraint).toBe('stock_balances_requires_movement');
    // Linha nova com saldo: tambem recusada. Linha zerada (o que o codigo faz) continua permitida.
    const { variantId: fresh } = await newProduct();
    expect((await pgError(appRole.query('INSERT INTO stock_balances (variant_id, on_hand) VALUES ($1, 7)', [fresh]))).constraint).toBe('stock_balances_requires_movement');
    await appRole.query('INSERT INTO stock_balances (variant_id) VALUES ($1) ON CONFLICT DO NOTHING', [fresh]);
    // Custo medio nao e saldo: continua alteravel como hoje.
    await appRole.query('UPDATE stock_balances SET updated_at = now() WHERE variant_id = $1', [variantId]);
    expect((await totals(variantId)).total).toEqual(['10.000', '0.000']);
  });

  it('manutenção como dono do banco não é bloqueada, mas a conferência aponta e grava', async () => {
    const { variantId } = await newProduct('20');
    await owner.query('UPDATE stock_balances SET on_hand = on_hand + 2 WHERE variant_id = $1', [variantId]);
    try {
      const divs = await reconcile();
      // Sem abertura (variante criada depois): C5 (livro), C2 (depositos) e C3 (ultimo movimento).
      expect(divs.map((d) => `${d.check_code}:${d.field}:${d.expected}:${d.found}`).sort()).toEqual(['C2:on_hand:22.000:20.000', 'C3:on_hand:20.000:22.000', 'C5:on_hand:20.000:22.000']);
      expect(divs.every((d) => d.variant_id === variantId)).toBe(true);
      // Gravado: as 3 divergencias e a linha da execucao (mesmo comando, sem ordem garantida entre elas).
      const saved = (await owner.query('SELECT check_code, expected::int AS checked, found::int AS divergences FROM stock_reconciliations WHERE run_id = $1', [divs[0]!.run_id])).rows;
      expect(saved.map((r) => r.check_code).sort()).toEqual(['C2', 'C3', 'C5', 'run']);
      expect(saved.find((r) => r.check_code === 'run')!.divergences).toBe(3);
    } finally {
      await owner.query('UPDATE stock_balances SET on_hand = on_hand - 2 WHERE variant_id = $1', [variantId]);
    }
    expect(await reconcile()).toEqual([]);
  });
});

describe('o papel da aplicação não altera depósitos, abertura nem conferências', () => {
  it('recusa gravação direta e o histórico é imutável até para o dono', async () => {
    const { variantId } = await newProduct('1');
    const wh = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
    const denied = [
      appRole.query('INSERT INTO stock_location_balances (warehouse_id, variant_id) VALUES ($1, $2)', [wh, randomUUID()]),
      appRole.query('UPDATE stock_location_balances SET on_hand = 0 WHERE variant_id = $1', [variantId]),
      appRole.query('DELETE FROM stock_location_balances WHERE variant_id = $1', [variantId]),
      appRole.query('INSERT INTO stock_opening_balances (variant_id, warehouse_id, on_hand, reserved, ledger_on_hand, ledger_reserved, reservations_active) VALUES ($1, $2, 0, 0, 0, 0, 0)', [variantId, wh]),
      appRole.query('UPDATE stock_opening_balances SET on_hand = 0'),
      appRole.query('DELETE FROM stock_opening_balances'),
      appRole.query(`INSERT INTO stock_reconciliations (run_id, check_code, expected, found) VALUES (gen_random_uuid(), 'run', 0, 0)`),
      appRole.query('UPDATE stock_reconciliations SET found = 0'),
      appRole.query('DELETE FROM stock_reconciliations'),
      // Cadastro de depositos pela aplicacao: liberado na Fase 3 (0022), com trava propria (sglog-fase3.test.ts).
      appRole.query('DELETE FROM warehouses WHERE NOT is_default'),
      appRole.query('SELECT stock_opening_capture()'),
    ];
    for (const p of denied) expect((await pgError(p)).code).toBe('42501');

    await reconcile();
    expect((await pgError(owner.query('UPDATE stock_reconciliations SET found = 0'))).code).toBe('23001');
    expect((await pgError(owner.query('DELETE FROM stock_reconciliations'))).code).toBe('23001');
  });
});

describe('referência de abertura', () => {
  it('captura consistente com movimentos simultâneos, sem criar movimento', async () => {
    await owner.query('TRUNCATE stock_opening_balances');
    const { variantId } = await newProduct('1000');
    const movesBefore = Number((await owner.query('SELECT count(*) FROM stock_movements')).rows[0].count);
    // Vendas e ajustes acontecendo enquanto a abertura e registrada.
    const work = Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        i % 3 === 0
          ? boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '-1', reason: 'Concorrente', requestKey: key() })
          : boss.post(`${S}/reservations`, { variantId, qty: '2', sourceId: `conc-${i}-${uid()}` }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const captured = (await owner.query('SELECT stock_opening_capture() AS n')).rows[0].n;
    const lockMs = performance.now() - t0;
    const results = await work;
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(captured).toBeGreaterThanOrEqual(1);
    // A abertura nao cria movimento: so os 24 da carga entraram no livro.
    expect(Number((await owner.query('SELECT count(*) FROM stock_movements')).rows[0].count)).toBe(movesBefore + 24);
    // Sem diferenca herdada: tudo foi gravado pela aplicacao.
    expect((await owner.query('SELECT count(*)::int AS n FROM stock_opening_balances WHERE ledger_on_hand <> on_hand OR ledger_reserved <> reserved OR reservations_active <> reserved')).rows[0].n).toBe(0);
    expect(await reconcile()).toEqual([]);
    expect(lockMs).toBeLessThan(5000);
    console.log(`abertura com movimentos simultaneos: ${captured} variante(s) em ${lockMs.toFixed(0)} ms`);
    expect((await pgError(owner.query('SELECT stock_opening_capture()'))).message).toContain('ja foi registrada');
  });

  it('diferença herdada aparece uma vez na abertura e não vira divergência depois', async () => {
    await owner.query('TRUNCATE stock_opening_balances');
    const consistent = await newProduct('40');
    const inherited = await newProduct('30');
    // Resíduo antigo (como o do seed de demonstracao ou SQL manual): saldo e deposito sem movimento no livro.
    await owner.query('UPDATE stock_balances SET on_hand = on_hand + 7 WHERE variant_id = $1', [inherited.variantId]);
    await owner.query('UPDATE stock_location_balances SET on_hand = on_hand + 7 WHERE variant_id = $1', [inherited.variantId]);
    // Variante existente sem linha de saldo no momento da abertura.
    const noBalance = await newProduct();
    expect((await owner.query('SELECT 1 FROM stock_balances WHERE variant_id = $1', [noBalance.variantId])).rowCount).toBe(0);

    const movesBefore = (await owner.query('SELECT count(*)::int AS n, coalesce(max(id), 0)::text AS last FROM stock_movements')).rows[0];
    await owner.query('SELECT stock_opening_capture()');
    const open = (await owner.query('SELECT variant_id, on_hand, ledger_on_hand, last_movement_id::text AS last FROM stock_opening_balances')).rows;
    const byVariant = Object.fromEntries(open.map((r) => [r.variant_id, r]));
    expect(byVariant[consistent.variantId]).toMatchObject({ on_hand: '40.000', ledger_on_hand: '40.000', last: movesBefore.last });
    expect(byVariant[inherited.variantId]).toMatchObject({ on_hand: '37.000', ledger_on_hand: '30.000' });
    expect(byVariant[noBalance.variantId]).toBeUndefined();
    expect((await owner.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n).toBe(movesBefore.n);

    // Logo depois e depois de novos movimentos: a diferenca herdada nao e divergencia.
    expect(await reconcile()).toEqual([]);
    await move(inherited.variantId, 'adjustment', '5');
    await reserveManual(inherited.variantId, '3');
    await move(consistent.variantId, 'loss', '1');
    expect(await reconcile()).toEqual([]);
    expect((await totals(inherited.variantId)).total).toEqual(['42.000', '3.000']);

    // Variante sem linha na abertura e variante criada depois: conferem pela soma dos proprios movimentos (C5).
    await move(noBalance.variantId, 'adjustment', '12');
    const later = await newProduct('9');
    await reserveManual(later.variantId, '2');
    expect(await reconcile()).toEqual([]);

    // Divergencia nova depois da abertura (saldo e deposito mexidos por fora): C1 e C3, sem C2.
    await owner.query('UPDATE stock_balances SET on_hand = on_hand + 1 WHERE variant_id = $1', [inherited.variantId]);
    await owner.query('UPDATE stock_location_balances SET on_hand = on_hand + 1 WHERE variant_id = $1', [inherited.variantId]);
    const divs = await reconcile();
    expect(divs.map((d) => `${d.check_code}:${d.field}:${d.expected}:${d.found}`).sort()).toEqual(['C1:on_hand:42.000:43.000', 'C3:on_hand:42.000:43.000']);
    await owner.query('UPDATE stock_balances SET on_hand = on_hand - 1 WHERE variant_id = $1', [inherited.variantId]);
    await owner.query('UPDATE stock_location_balances SET on_hand = on_hand - 1 WHERE variant_id = $1', [inherited.variantId]);

    // Reserva mexida por fora: C4 no total e, desde a Fase 4, C8 no deposito.
    await owner.query(`UPDATE stock_reservations SET status = 'released', closed_at = now() WHERE variant_id = $1 AND status = 'active'`, [later.variantId]);
    expect((await reconcile()).map((d) => `${d.check_code}:${d.expected}:${d.found}`)).toEqual(['C4:0.000:2.000', 'C8:0.000:2.000']);
    await owner.query(`UPDATE stock_reservations SET status = 'active', closed_at = NULL WHERE variant_id = $1`, [later.variantId]);
    expect(await reconcile()).toEqual([]);
  });
});

describe('papéis novos (menor privilégio)', () => {
  // suppliers.* entrou na Fase 2 (docs/18-sglog-fase2.md, matriz aprovada em D2-4).
  const expected = {
    // Fase 3 (D3-2): transferencia e ajuste com MFA (stock.adjust) para o gerente de logistica.
    // Fase 4 (D4-11): logistics.view para logistica e comprador; logistics.allocate so para a logistica. Financeiro sem.
    logistics: ['catalog.view', 'logistics.allocate', 'logistics.view', 'orders.view', 'purchases.view', 'shipping.manage', 'stock.adjust', 'stock.manage', 'stock.transfer', 'stock.view', 'suppliers.view'],
    buyer: ['catalog.view', 'logistics.view', 'purchases.manage', 'purchases.view', 'stock.view', 'suppliers.manage', 'suppliers.view'],
    finance: ['orders.view', 'purchases.view', 'reports.view', 'suppliers.view'],
  };

  it('o proprietário cria os três papéis; o gerente continua sem criar proprietário', async () => {
    const own = await loggedAs(app, 'owner', { mfa: true });
    for (const role of Object.keys(expected)) {
      const res = await own.post('/api/v1/admin/users', { email: `${role}-${uid()}@teste.local`, name: `Pessoa ${role}`, role });
      expect(res.statusCode, res.body).toBe(201);
    }
    expect((await boss.post('/api/v1/admin/users', { email: `x-${uid()}@teste.local`, name: 'X Y', role: 'owner' })).statusCode).toBe(403);
    expect((await own.post('/api/v1/admin/users', { email: `y-${uid()}@teste.local`, name: 'Y Z', role: 'auditor' })).statusCode).toBe(400);
  });

  it('cada papel recebe exatamente o seu padrão (MFA só no ajuste de estoque do gerente de logística, Fase 3)', async () => {
    for (const [role, perms] of Object.entries(expected)) {
      const c = await loggedAs(app, role);
      const me = (await c.get('/api/v1/auth/me')).json();
      expect([...me.permissions].sort(), role).toEqual(perms);
    }
  });

  it('logística despacha, mas não muda a situação comercial, não cancela, não vê faturamento nem compra', async () => {
    const lg = await loggedAs(app, 'logistics');
    const o = await readyOrder();
    const A = `/api/v1/admin/orders/${o.id}`;
    expect((await lg.post(`${A}/status`, { to: 'preparing', version: o.version })).statusCode).toBe(403);
    expect((await lg.post(`${A}/cancel`, { reason: 'Teste de permissão', version: o.version })).statusCode).toBe(403);
    expect((await lg.get('/api/v1/admin/sales-reports/summary')).statusCode).toBe(403);
    expect((await lg.post('/api/v1/admin/suppliers', { name: `Fornecedor ${uid()}` })).statusCode).toBe(403);
    expect((await lg.get('/api/v1/admin/users')).statusCode).toBe(403);
    await allocateOrder(lg, o.id);
    const sent = await lg.post(`${A}/dispatch`, { version: o.version, carrier: 'Próprio', volumes: 1 });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(await reconcile()).toEqual([]);
  });

  it('comprador recebe mercadoria, mas não vê pedidos de clientes nem lança ajuste', async () => {
    const bu = await loggedAs(app, 'buyer');
    const { variantId, purchase } = await newProduct();
    expect((await bu.get('/api/v1/admin/orders')).statusCode).toBe(403);
    expect((await bu.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '5', reason: 'Teste', requestKey: key() })).statusCode).toBe(403);
    const sup = await bu.post('/api/v1/admin/suppliers', { name: `Distribuidora ${uid()}`, leadTimeDays: 3 });
    expect(sup.statusCode, sup.body).toBe(201);
    const po = await bu.post('/api/v1/admin/purchase-orders', { supplierId: sup.json().supplier.id, items: [{ packagingId: purchase.id, packs: '2', packCostCents: 1500 }] });
    expect(po.statusCode, po.body).toBe(201);
    const order = po.json().order;
    expect((await bu.post(`/api/v1/admin/purchase-orders/${order.id}/send`)).statusCode).toBe(200);
    const rec = await bu.post(`/api/v1/admin/purchase-orders/${order.id}/receipts`, { requestKey: key(), items: [{ itemId: order.items[0].id, packs: '2' }] });
    expect(rec.statusCode, rec.body).toBe(201);
    expect((await totals(variantId)).location).toEqual(['200.000', '0.000']);
    expect(await reconcile()).toEqual([]);
  });

  it('financeiro só consulta: vê vendas e pedidos, não mexe em estoque nem em compras', async () => {
    const fi = await loggedAs(app, 'finance');
    const { variantId } = await newProduct();
    expect((await fi.get('/api/v1/admin/sales-reports/summary')).statusCode).toBe(200);
    expect((await fi.get('/api/v1/admin/orders')).statusCode).toBe(200);
    expect((await fi.get(S)).statusCode).toBe(403);
    expect((await fi.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '5', reason: 'Teste', requestKey: key() })).statusCode).toBe(403);
    expect((await fi.post('/api/v1/admin/suppliers', { name: `Fornecedor ${uid()}` })).statusCode).toBe(403);
    expect((await fi.post('/api/v1/admin/orders/00000000-0000-0000-0000-000000000000/cancel', { reason: 'Teste', version: 1 })).statusCode).toBe(403);
  });
});

describe('trava contra testes fora do banco de testes', () => {
  const base = { DB_NAME: 'loja_dev', DB_NAME_TEST: 'loja_test', NODE_ENV: 'development' };
  it('recusa .env de produção e banco de testes mal configurado', () => {
    expect(testEnvProblem(base)).toBeNull();
    expect(testEnvProblem({ ...base, NODE_ENV: 'production' })).toContain('producao');
    expect(testEnvProblem({ ...base, DB_NAME_TEST: '' })).toContain('vazio');
    expect(testEnvProblem({ ...base, DB_NAME_TEST: undefined })).toContain('vazio');
    expect(testEnvProblem({ ...base, DB_NAME_TEST: 'loja_prod' })).toContain('_test');
    expect(testEnvProblem({ ...base, DB_NAME_TEST: 'loja_vendas' })).toContain('_test');
    expect(testEnvProblem({ ...base, DB_NAME_TEST: 'loja_dev', DB_NAME: 'loja_dev' })).toContain('_test');
    expect(testEnvProblem({ DB_NAME: 'loja_test', DB_NAME_TEST: 'loja_test' })).toContain('igual a DB_NAME');
    // Dentro dos processos de teste DB_NAME e trocado: vale o valor do arquivo .env.
    expect(testEnvProblem({ ...base, DB_NAME: 'loja_test' }, base)).toBeNull();
  });

  it('recusa banco sem a marca de testes, mesmo com nome de teste', async () => {
    expect(await testDatabaseProblem(owner, process.env.DB_NAME_TEST!)).toBeNull();
    expect(await testDatabaseProblem(owner, 'loja_prod')).toContain('esperado loja_prod');
    const unmarked = { query: async () => ({ rows: [{ db: 'loja_copia_test', mark: null }] }) } as unknown as Parameters<typeof testDatabaseProblem>[0];
    expect(await testDatabaseProblem(unmarked, 'loja_copia_test')).toContain('marca');
    const other = { query: async () => ({ rows: [{ db: 'loja_x_test', mark: 'outra coisa' }] }) } as unknown as Parameters<typeof testDatabaseProblem>[0];
    expect(await testDatabaseProblem(other, 'loja_x_test')).toContain('marca');
    expect((await owner.query(`SELECT shobj_description(oid, 'pg_database') AS m FROM pg_database WHERE datname = current_database()`)).rows[0].m).toBe(TEST_DB_MARK);
  });
});
