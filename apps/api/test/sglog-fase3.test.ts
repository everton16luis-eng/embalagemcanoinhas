import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { appRole, loggedAs, makeApp, owner, productPayload, resetCatalog, uid } from './helpers.js';

// SGLog Fase 3 (docs/20-sglog-fase3.md): estoque por deposito, transferencias, bloqueio, avaria, estorno,
// solicitacao de ajuste, inventario por deposito, minimo/maximo, alertas, permissoes e conferencia.

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA: tem tudo
let stockist: Awaited<ReturnType<typeof loggedAs>>; // estoquista: transfere e bloqueia, nao ajusta
let principal: string;

beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  stockist = await loggedAs(app, 'stock');
  principal = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const S = '/api/v1/admin/stock';
const W = '/api/v1/admin/warehouses';
const T = '/api/v1/admin/stock-transfers';
const key = () => `k-${uid()}-${uid()}`;

async function newWarehouse(name = 'Galpão') {
  const r = await boss.post(W, { code: `G${uid()}`.slice(0, 12).toUpperCase(), name: `${name} ${uid()}` });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().warehouse.id as string;
}
async function newProduct(stock = '0') {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const p = res.json().product;
  const variantId = p.variants[0].id as string;
  if (stock !== '0') {
    const r = await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: key() });
    expect(r.statusCode, r.body).toBe(201);
  }
  return { variantId, slug: p.slug as string };
}

type Buckets = { on_hand: string; reserved: string; blocked: string; damaged: string; in_transit: string };
const ZERO: Buckets = { on_hand: '0.000', reserved: '0.000', blocked: '0.000', damaged: '0.000', in_transit: '0.000' };
const loc = async (warehouseId: string, variantId: string): Promise<Buckets> =>
  (await owner.query('SELECT on_hand, reserved, blocked, damaged, in_transit FROM stock_location_balances WHERE warehouse_id = $1 AND variant_id = $2', [warehouseId, variantId])).rows[0] ?? ZERO;
const total = async (variantId: string): Promise<Buckets> =>
  (await owner.query('SELECT on_hand, reserved, blocked, damaged, in_transit FROM stock_balances WHERE variant_id = $1', [variantId])).rows[0] ?? ZERO;
/** Vendavel como a loja ve: maximo de unidades na embalagem "Unidade". */
const sellable = async (slug: string) => {
  const d = (await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products/${slug}` })).json().product;
  return d.variants[0].packagings.find((k: { label: string }) => k.label === 'Unidade').max_packs as number;
};

type Rec = { check_code: string; field: string | null; variant_id: string | null; expected: string; found: string };
async function reconcile() {
  const rows = (await appRole.query<Rec>('SELECT check_code, field, variant_id, expected, found FROM stock_reconcile()')).rows;
  expect(rows.find((r) => r.check_code === 'run')).toBeDefined();
  return rows.filter((r) => r.check_code !== 'run');
}
const pgError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string; message: string };
  }
  throw new Error('a operacao deveria ter sido recusada');
};
const send = (from: string, to: string, items: { variantId: string; qty: string }[], extra: Record<string, unknown> = {}) =>
  boss.post(T, { fromWarehouseId: from, toWarehouseId: to, items, requestKey: key(), ...extra });

describe('depósitos (D3-1, D3-5)', () => {
  it('dono e gerente cadastram; estoquista e gerente sem MFA não; código único; sem exclusão física', async () => {
    const noMfa = await loggedAs(app, 'manager');
    expect((await noMfa.post(W, { code: 'SEMMFA', name: 'Sem MFA' })).json().error.code).toBe('MFA_REQUIRED');
    expect((await stockist.post(W, { code: 'EST', name: 'Do estoquista' })).statusCode).toBe(403);
    const code = `LJ${uid()}`.slice(0, 10).toUpperCase();
    const c = await boss.post(W, { code, name: 'Loja do centro', cep: '89460000', city: 'Canoinhas', uf: 'SC' });
    expect(c.statusCode, c.body).toBe(201);
    expect((await boss.post(W, { code, name: 'Repetido' })).json().error.code).toBe('CODE_TAKEN');
    // Quem ve estoque lista; a lista traz o padrao primeiro.
    const list = (await stockist.get(W)).json().items;
    expect(list[0]).toMatchObject({ code: 'PRINCIPAL', is_default: true });
    // Sem DELETE para a aplicacao, e o padrao nao muda nesta fase (gatilho, alem da API).
    expect((await pgError(appRole.query('DELETE FROM warehouses WHERE id = $1', [c.json().warehouse.id]))).code).toBe('42501');
    expect((await pgError(appRole.query('UPDATE warehouses SET is_default = false WHERE is_default'))).constraint).toBe('warehouses_default_fixed');
    expect((await pgError(appRole.query(`INSERT INTO warehouses (code, name, is_default) VALUES ('NOVOPAD', 'Novo padrão', true)`))).constraint).toBe('warehouses_default_fixed');
    expect((await boss.put(`${W}/${principal}`, { name: 'Depósito principal', active: false })).json().error.code).toBe('DEFAULT_WAREHOUSE');
    // Endereco do padrao informado pelo painel.
    const up = await boss.put(`${W}/${principal}`, { name: 'Depósito principal', cep: '89460000', street: 'Rua Teste', number: '10', district: 'Centro', city: 'Canoinhas', uf: 'SC' });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json().warehouse).toMatchObject({ code: 'PRINCIPAL', city: 'Canoinhas', is_default: true });
  });

  it('depósito com saldo ou transferência pendente não desativa; vazio desativa e não recebe movimento', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('10');
    const sent = await send(principal, g, [{ variantId, qty: '4' }]);
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await boss.put(`${W}/${g}`, { name: 'Galpão', active: false })).json().error.code).toBe('WAREHOUSE_IN_USE');
    const id = sent.json().transfer.id;
    expect((await boss.post(`${T}/${id}/receive`, { requestKey: key() })).statusCode).toBe(200);
    expect((await boss.put(`${W}/${g}`, { name: 'Galpão', active: false })).json().error.code).toBe('WAREHOUSE_IN_USE');
    expect((await send(g, principal, [{ variantId, qty: '4' }], { receiveNow: true })).statusCode).toBe(201);
    const off = await boss.put(`${W}/${g}`, { name: 'Galpão', active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((await send(principal, g, [{ variantId, qty: '1' }])).json().error.code).toBe('WAREHOUSE_INACTIVE');
    expect(await reconcile()).toEqual([]);
  });
});

describe('equações do estoque e transferência em duas etapas (D3-3, D3-4)', () => {
  it('envio tira do disponível da origem e põe em trânsito no destino: vendável cai, gerencial não muda', async () => {
    const g = await newWarehouse();
    const { variantId, slug } = await newProduct('100');
    expect(await sellable(slug)).toBe(100);
    const r = await send(principal, g, [{ variantId, qty: '30' }], { documentRef: 'ROM-1' });
    expect(r.statusCode, r.body).toBe(201);
    const t = r.json().transfer;
    expect(t).toMatchObject({ status: 'in_transit', from_name: 'Depósito principal' });
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '70.000', in_transit: '0.000' });
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '0.000', in_transit: '30.000' });
    const tot = await total(variantId);
    expect(tot).toMatchObject({ on_hand: '70.000', in_transit: '30.000' });
    // Total gerencial = disponivel + bloqueado + avariado + em transito: nao mudou. Vendavel (loja) caiu.
    expect(Number(tot.on_hand) + Number(tot.blocked) + Number(tot.damaged) + Number(tot.in_transit)).toBe(100);
    expect(await sellable(slug)).toBe(70);
    // Duas linhas no livro, uma por deposito, ligadas a transferencia.
    const rows = (await owner.query(`SELECT warehouse_id, counter_warehouse_id, on_hand_delta, in_transit_delta FROM stock_movements WHERE transfer_id = $1 ORDER BY id`, [t.id])).rows;
    expect(rows).toEqual([
      { warehouse_id: principal, counter_warehouse_id: g, on_hand_delta: '-30.000', in_transit_delta: '0.000' },
      { warehouse_id: g, counter_warehouse_id: principal, on_hand_delta: '0.000', in_transit_delta: '30.000' },
    ]);
    expect(await reconcile()).toEqual([]);

    // Recebimento parcial, repeticao da mesma chave nao duplica, excesso recusado, depois o resto.
    const k = key();
    const part = await stockist.post(`${T}/${t.id}/receive`, { items: [{ variantId, qty: '10' }], requestKey: k });
    expect(part.statusCode, part.body).toBe(200);
    expect(part.json().transfer.status).toBe('partial');
    expect((await stockist.post(`${T}/${t.id}/receive`, { items: [{ variantId, qty: '10' }], requestKey: k })).json().replayed).toBe(true);
    const over = await stockist.post(`${T}/${t.id}/receive`, { items: [{ variantId, qty: '21' }], requestKey: key() });
    expect(over.json().error.code).toBe('OVER_PENDING');
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '10.000', in_transit: '20.000' });
    const rest = await stockist.post(`${T}/${t.id}/receive`, { requestKey: key() });
    expect(rest.json().transfer).toMatchObject({ status: 'received' });
    expect(rest.json().transfer.events.map((e: { kind: string }) => e.kind)).toEqual(['send', 'receive', 'receive']);
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '30.000', in_transit: '0.000' });
    expect(await sellable(slug)).toBe(100);
    expect((await stockist.post(`${T}/${t.id}/receive`, { requestKey: key() })).json().error.code).toBe('TRANSFER_CLOSED');
    expect(await reconcile()).toEqual([]);
  });

  it('recebimento imediato grava os dois eventos; mesma origem e destino é recusado', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('5');
    const r = await stockist.post(T, { fromWarehouseId: principal, toWarehouseId: g, items: [{ variantId, qty: '5' }], receiveNow: true, requestKey: key() });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().transfer.status).toBe('received');
    expect(r.json().transfer.events.map((e: { kind: string }) => e.kind)).toEqual(['send', 'receive']);
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '5.000', in_transit: '0.000' });
    expect((await send(g, g, [{ variantId, qty: '1' }])).json().error.code).toBe('SAME_WAREHOUSE');
  });

  it('não transfere mercadoria reservada nem indisponível, e nada é gravado', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('10');
    const res = await boss.post(`${S}/reservations`, { variantId, qty: '8', sourceId: `r-${uid()}` });
    expect(res.statusCode, res.body).toBe(201);
    const moves = async () => Number((await owner.query('SELECT count(*) FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].count);
    const before = await moves();
    const r = await send(principal, g, [{ variantId, qty: '3' }]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { free: '2.000' } });
    expect(await moves()).toBe(before);
    expect((await owner.query('SELECT count(*)::int AS n FROM stock_transfers t JOIN stock_transfer_items i ON i.transfer_id = t.id WHERE i.variant_id = $1', [variantId])).rows[0].n).toBe(0);
    expect((await send(principal, g, [{ variantId, qty: '2' }])).statusCode).toBe(201);
  });

  it('dois envios simultâneos do mesmo saldo: só um passa, sem negativo em nenhum depósito', async () => {
    const g = await newWarehouse();
    const h = await newWarehouse('Loja');
    const { variantId } = await newProduct('10');
    const rs = await Promise.all([send(principal, g, [{ variantId, qty: '7' }]), send(principal, h, [{ variantId, qty: '7' }])]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '3.000' });
    // Recebimentos simultaneos da mesma transferencia: nunca passam do enviado.
    const id = rs.find((r) => r.statusCode === 201)!.json().transfer.id;
    const recv = await Promise.all(Array.from({ length: 4 }, () => stockist.post(`${T}/${id}/receive`, { items: [{ variantId, qty: '3' }], requestKey: key() })));
    expect(recv.filter((r) => r.statusCode === 200)).toHaveLength(2);
    const item = (await owner.query('SELECT qty_received FROM stock_transfer_items WHERE transfer_id = $1', [id])).rows[0];
    expect(item.qty_received).toBe('6.000');
    expect(await reconcile()).toEqual([]);
  });

  it('extravio (com MFA) e recusa: encerram com divergência; cancelar só sem movimento posterior', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('20');
    const t = (await send(principal, g, [{ variantId, qty: '10' }])).json().transfer;
    expect((await stockist.post(`${T}/${t.id}/loss`, { items: [{ variantId, qty: '1' }], reason: 'Caixa perdida', requestKey: key() })).statusCode).toBe(403);
    expect((await boss.post(`${T}/${t.id}/loss`, { items: [{ variantId, qty: '1' }], reason: 'Caixa perdida no caminho', requestKey: key() })).statusCode).toBe(200);
    expect((await stockist.post(`${T}/${t.id}/return`, { items: [{ variantId, qty: '2' }], reason: 'Recusado: embalagem amassada', requestKey: key() })).statusCode).toBe(200);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '12.000' });
    expect((await boss.post(`${T}/${t.id}/cancel`, { reason: 'Desistência', requestKey: key() })).json().error.code).toBe('TRANSFER_MOVED');
    const fin = await stockist.post(`${T}/${t.id}/receive`, { requestKey: key() });
    expect(fin.json().transfer).toMatchObject({ status: 'closed_divergent' });
    expect(fin.json().transfer.items[0]).toMatchObject({ qty_sent: '10.000', qty_received: '7.000', qty_lost: '1.000', qty_returned: '2.000', qty_pending: '0.000' });
    // Total gerencial cai so pelo extravio.
    const tot = await total(variantId);
    expect(Number(tot.on_hand) + Number(tot.in_transit)).toBe(19);

    // Cancelamento sem nada recebido: estorna o envio (os dois lados), uma vez so.
    const t2 = (await send(principal, g, [{ variantId, qty: '4' }])).json().transfer;
    expect((await stockist.post(`${T}/${t2.id}/cancel`, { reason: 'Errado', requestKey: key() })).statusCode).toBe(403);
    const c = await boss.post(`${T}/${t2.id}/cancel`, { reason: 'Enviado por engano', requestKey: key() });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().transfer.status).toBe('canceled');
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '12.000' });
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '7.000', in_transit: '0.000' });
    expect((await boss.post(`${T}/${t2.id}/cancel`, { reason: 'De novo', requestKey: key() })).json().error.code).toBe('TRANSFER_MOVED');
    expect(await reconcile()).toEqual([]);
  });
});

describe('bloqueio, quarentena e avaria (saldos separados, não vendáveis)', () => {
  it('bloqueio e avaria saem do vendável e voltam; baixa do avariado exige stock.adjust', async () => {
    const { variantId, slug } = await newProduct('50');
    const hold = (op: string, qty: string, who = stockist) => who.post(`${S}/holds`, { variantId, op, qty, reason: `Teste ${op}`, requestKey: key() });
    expect((await hold('block', '10')).statusCode).toBe(201);
    expect((await hold('damage_hold', '5')).statusCode).toBe(201);
    expect(await total(variantId)).toMatchObject({ on_hand: '35.000', blocked: '10.000', damaged: '5.000' });
    expect(await sellable(slug)).toBe(35);
    expect((await hold('unblock', '11')).json().error.code).toBe('INSUFFICIENT_BUCKET');
    expect((await hold('unblock', '4')).statusCode).toBe(201);
    expect((await hold('damage_release', '1')).statusCode).toBe(201);
    expect((await hold('damage_write_off', '2')).statusCode).toBe(403);
    expect((await hold('damage_write_off', '2', boss)).statusCode).toBe(201);
    expect(await total(variantId)).toMatchObject({ on_hand: '40.000', blocked: '6.000', damaged: '2.000' });
    // Bloqueio nao toma reservado.
    await boss.post(`${S}/reservations`, { variantId, qty: '38', sourceId: `r-${uid()}` });
    expect((await hold('block', '3')).json().error.code).toBe('INSUFFICIENT_STOCK');
    const detail = (await boss.get(`${S}/variants/${variantId}`)).json();
    expect(detail.locations[0]).toMatchObject({ code: 'PRINCIPAL', on_hand: '40.000', reserved: '38.000', blocked: '6.000', damaged: '2.000', available: '2.000' });
    expect(await reconcile()).toEqual([]);
  });

  it('o banco recusa movimento com forma errada', async () => {
    const { variantId } = await newProduct('5');
    await owner.query('BEGIN');
    try {
      // Bloqueio que "cria" mercadoria: blocked sobe sem o disponivel cair.
      const e = await pgError(
        owner.query(
          `INSERT INTO stock_movements (variant_id, kind, on_hand_delta, blocked_delta, on_hand_after, reserved_after, avg_cost_after, reason) VALUES ($1, 'block', 0, 1, 5, 0, 0, 'x')`,
          [variantId],
        ),
      );
      expect(e.constraint).toBe('stock_movements_bucket_shape');
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('estorno auditável', () => {
  it('estorna ajuste uma vez só; não estorna venda, transferência nem o que já foi consumido', async () => {
    const { variantId } = await newProduct('0');
    const adj = await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '10', reason: 'Entrada errada', requestKey: key() });
    const id = adj.json().movement.id;
    expect((await stockist.post(`${S}/movements/${id}/reverse`, { reason: 'Lançado em dobro', requestKey: key() })).statusCode).toBe(403);
    const k = key();
    const r = await boss.post(`${S}/movements/${id}/reverse`, { reason: 'Lançado em dobro', requestKey: k });
    expect(r.statusCode, r.body).toBe(201);
    expect((await boss.post(`${S}/movements/${id}/reverse`, { reason: 'Lançado em dobro', requestKey: k })).json().replayed).toBe(true);
    expect((await boss.post(`${S}/movements/${id}/reverse`, { reason: 'De novo', requestKey: key() })).json().error.code).toBe('ALREADY_REVERSED');
    expect(await total(variantId)).toMatchObject({ on_hand: '0.000' });
    // Original intacto, estorno ligado a ele.
    const rows = (await owner.query('SELECT kind, on_hand_delta, reverses_id::text FROM stock_movements WHERE variant_id = $1 ORDER BY id', [variantId])).rows;
    expect(rows).toEqual([
      { kind: 'adjustment', on_hand_delta: '10.000', reverses_id: null },
      { kind: 'reversal', on_hand_delta: '-10.000', reverses_id: id },
    ]);

    // Entrada ja consumida por venda (reserva baixada): o estorno tiraria o que nao existe mais.
    const adj2 = await boss.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '5', reason: 'Entrada', requestKey: key() });
    const res = await boss.post(`${S}/reservations`, { variantId, qty: '4', sourceId: `r-${uid()}` });
    expect((await boss.post(`${S}/movements/${adj2.json().movement.id}/reverse`, { reason: 'Teste', requestKey: key() })).json().error.code).toBe('INSUFFICIENT_STOCK');
    await boss.post(`${S}/reservations/${res.json().reservation.id}/consume`);
    expect((await boss.post(`${S}/movements/${adj2.json().movement.id}/reverse`, { reason: 'Teste', requestKey: key() })).json().error.code).toBe('INSUFFICIENT_STOCK');
    const sale = (await owner.query(`SELECT id::text FROM stock_movements WHERE variant_id = $1 AND kind = 'sale'`, [variantId])).rows[0].id;
    expect((await boss.post(`${S}/movements/${sale}/reverse`, { reason: 'Teste', requestKey: key() })).json().error.code).toBe('NOT_REVERSIBLE');
    const g = await newWarehouse();
    const tr = (await send(principal, g, [{ variantId, qty: '1' }])).json().transfer;
    const trMove = (await owner.query('SELECT id::text FROM stock_movements WHERE transfer_id = $1 ORDER BY id LIMIT 1', [tr.id])).rows[0].id;
    expect((await boss.post(`${S}/movements/${trMove}/reverse`, { reason: 'Teste', requestKey: key() })).json().error.code).toBe('NOT_REVERSIBLE');

    // No banco: estorno que nao e o oposto exato e recusado mesmo pelo papel da aplicacao.
    const e = await pgError(
      appRole.query(
        `INSERT INTO stock_movements (variant_id, kind, on_hand_delta, on_hand_after, reserved_after, avg_cost_after, reason, reverses_id) VALUES ($1, 'reversal', 3, 0, 0, 0, 'x', $2)`,
        [variantId, adj2.json().movement.id],
      ),
    );
    expect(e.constraint).toBe('stock_movements_reversal_target');
    expect(await reconcile()).toEqual([]);
  });
});

describe('solicitação de ajuste com aprovação (D3-2)', () => {
  it('estoquista não ajusta direto: pede; outra pessoa aprova ou recusa; quem pede não aprova', async () => {
    const { variantId } = await newProduct('20');
    for (const kind of ['adjustment', 'loss', 'damage']) {
      expect((await stockist.post(`${S}/movements`, { variantId, kind, qty: '1', reason: 'Direto', requestKey: key() })).statusCode).toBe(403);
    }
    // Devolucao de cliente continua com o estoquista.
    expect((await stockist.post(`${S}/movements`, { variantId, kind: 'return', qty: '1', reason: 'Cliente devolveu', requestKey: key() })).statusCode).toBe(201);
    const ask = async (kind: string, qty: string, who = stockist) => {
      const r = await who.post(`${S}/adjustment-requests`, { variantId, kind, qty, reason: 'Quebra na prateleira', requestKey: key() });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().request as { id: string; status: string };
    };
    const a = await ask('loss', '3');
    expect(a.status).toBe('pending');
    expect(await total(variantId)).toMatchObject({ on_hand: '21.000' });
    expect((await stockist.post(`${S}/adjustment-requests/${a.id}/approve`, {})).statusCode).toBe(403);
    const ok = await boss.post(`${S}/adjustment-requests/${a.id}/approve`, { note: 'Conferido' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request).toMatchObject({ status: 'approved' });
    expect(await total(variantId)).toMatchObject({ on_hand: '18.000' });
    const m = (await owner.query('SELECT kind, on_hand_delta, source_type, created_by FROM stock_movements WHERE id = $1', [ok.json().request.movement_id])).rows[0];
    expect(m).toMatchObject({ kind: 'loss', on_hand_delta: '-3.000', source_type: 'adjustment_request' });
    expect((await boss.post(`${S}/adjustment-requests/${a.id}/approve`, {})).json().error.code).toBe('REQUEST_CLOSED');

    const b = await ask('adjustment', '-2');
    expect((await boss.post(`${S}/adjustment-requests/${b.id}/reject`, {})).json().error.code).toBe('REASON_REQUIRED');
    expect((await boss.post(`${S}/adjustment-requests/${b.id}/reject`, { note: 'Contar de novo' })).json().request.status).toBe('rejected');

    // Quem pede nao decide a propria (mesmo tendo stock.adjust).
    const lg = await loggedAs(app, 'logistics', { mfa: true });
    const own = await ask('adjustment', '1', lg);
    expect((await lg.post(`${S}/adjustment-requests/${own.id}/approve`, {})).json().error.code).toBe('FOUR_EYES');
    expect((await lg.post(`${S}/adjustment-requests/${own.id}/cancel`, {})).json().request.status).toBe('canceled');

    // Saldo mudou e nao cabe mais: aprovacao recusada, solicitacao continua pendente.
    const big = await ask('loss', '18');
    await boss.post(`${S}/movements`, { variantId, kind: 'loss', qty: '1', reason: 'Outra perda', requestKey: key() });
    expect((await boss.post(`${S}/adjustment-requests/${big.id}/approve`, {})).json().error.code).toBe('INSUFFICIENT_STOCK');
    expect((await boss.get(`${S}/adjustment-requests?status=pending&variantId=${variantId}`)).json().items.map((r: { id: string }) => r.id)).toEqual([big.id]);
    expect(await reconcile()).toEqual([]);
  });

  it('ajuste direto exige verificação em duas etapas', async () => {
    const { variantId } = await newProduct('0');
    const noMfa = await loggedAs(app, 'manager');
    expect((await noMfa.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '1', reason: 'Teste', requestKey: key() })).json().error.code).toBe('MFA_REQUIRED');
  });
});

describe('inventário por depósito', () => {
  it('uma contagem aberta por depósito; fechamento ajusta só o depósito contado e avisa reserva descoberta', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('30');
    await send(principal, g, [{ variantId, qty: '10' }], { receiveNow: true });
    await boss.post(`${S}/reservations`, { variantId, qty: '15', sourceId: `r-${uid()}` });
    const I = '/api/v1/admin/inventory-counts';
    const open = async (warehouseId: string) => stockist.post(I, { variantIds: [variantId], warehouseId });
    const cg = await open(g);
    expect(cg.statusCode, cg.body).toBe(201);
    const cp = await open(principal);
    expect(cp.statusCode, cp.body).toBe(201);
    expect((await open(g)).json().error.code).toBe('COUNT_OPEN');
    expect(cg.json().count.items[0].current_on_hand).toBe('10.000');
    expect(cp.json().count.items[0].current_on_hand).toBe('20.000');
    await stockist.put(`${I}/${cg.json().count.id}/items`, [{ variantId, countedQty: '8' }]);
    const closed = await stockist.post(`${I}/${cg.json().count.id}/close`);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await loc(g, variantId)).toMatchObject({ on_hand: '8.000' });
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '20.000', reserved: '15.000' });
    // Contado abaixo do reservado: a reserva nao muda e o fechamento avisa.
    await stockist.put(`${I}/${cp.json().count.id}/items`, [{ variantId, countedQty: '12' }]);
    const c2 = (await stockist.post(`${I}/${cp.json().count.id}/close`)).json();
    expect(c2.uncoveredReservations).toEqual([{ variantId, counted: '12.000', reserved: '15.000' }]);
    expect(await loc(principal, variantId)).toMatchObject({ on_hand: '12.000', reserved: '15.000' });
    expect(await reconcile()).toEqual([]);
  });
});

describe('mínimo, máximo e alertas por depósito (D3-7)', () => {
  it('alerta de mínimo pelo vendável do depósito e de máximo pelo disponível mais o que está chegando', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('100');
    const set = (warehouseId: string, b: Record<string, unknown>) => stockist.put(`${S}/locations/${warehouseId}/${variantId}`, b);
    expect((await set(g, { bin: 'A-01', minQty: '20', maxQty: '10' })).json().error.code).toBe('INVALID_RANGE');
    expect((await set(g, { bin: 'A-01', minQty: '20', maxQty: '50' })).statusCode).toBe(200);
    expect((await set(principal, { minQty: null, maxQty: '80' })).statusCode).toBe(200);
    const alerts = async () =>
      (await boss.get(`${S}/alerts?pageSize=100`)).json().items.filter((a: { variant_id: string }) => a.variant_id === variantId).map((a: { alert: string; warehouse_id: string }) => `${a.alert}@${a.warehouse_id === g ? 'g' : 'p'}`).sort();
    expect(await alerts()).toEqual(['above_max@p', 'below_min@g']);
    await send(principal, g, [{ variantId, qty: '60' }]);
    // 60 a caminho de g: passa do maximo de g; o principal (40) sai do alerta de maximo; o minimo de g segue (vendavel 0).
    expect(await alerts()).toEqual(['above_max@g', 'below_min@g']);
    const list = (await boss.get(`${S}?warehouseId=${g}&filter=below`)).json().items.find((i: { variant_id: string }) => i.variant_id === variantId);
    expect(list).toMatchObject({ bin: 'A-01', min_qty: '20.000', in_transit: '60.000', below_min: true });
    expect((await (await loggedAs(app, 'buyer')).put(`${S}/locations/${g}/${variantId}`, { bin: 'X' })).statusCode).toBe(403);
  });
});

describe('compatibilidade com a loja (requisitos 9 e 10)', () => {
  it('reserva e venda continuam no padrão; falta no padrão é recusada com o nome do depósito', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('10');
    await send(principal, g, [{ variantId, qty: '10' }], { receiveNow: true });
    // A loja ainda ve 10 vendaveis (total), mas a mercadoria esta em outro deposito: a reserva passa (total) e a
    // baixa no padrao e recusada com mensagem clara, sem erro generico. A escolha do deposito e da Fase 4.
    const res = await boss.post(`${S}/reservations`, { variantId, qty: '2', sourceId: `r-${uid()}` });
    expect(res.statusCode, res.body).toBe(201);
    expect((await owner.query('SELECT warehouse_id FROM stock_movements WHERE variant_id = $1 AND kind = $2', [variantId, 'reserve'])).rows[0].warehouse_id).toBeNull();
    const c = await boss.post(`${S}/reservations/${res.json().reservation.id}/consume`);
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(c.json().error.message).toContain('Depósito principal');
    await send(g, principal, [{ variantId, qty: '2' }], { receiveNow: true });
    expect((await boss.post(`${S}/reservations/${res.json().reservation.id}/consume`)).statusCode).toBe(200);
    expect(await reconcile()).toEqual([]);
  });

  it('a lista de estoque sem depósito continua igual (total) e o detalhe mostra cada depósito', async () => {
    const g = await newWarehouse();
    const { variantId } = await newProduct('9');
    await send(principal, g, [{ variantId, qty: '4' }]);
    const item = (await boss.get(`${S}?q=${variantId.slice(0, 0)}&pageSize=100`)).json().items.find((i: { variant_id: string }) => i.variant_id === variantId);
    expect(item).toMatchObject({ on_hand: '5.000', reserved: '0.000', available: '5.000', in_transit: '4.000' });
    const d = (await boss.get(`${S}/variants/${variantId}`)).json();
    const mine = d.locations.filter((l: { warehouse_id: string }) => l.warehouse_id === g || l.warehouse_id === principal);
    expect(mine.map((l: { code: string; on_hand: string; in_transit: string }) => [l.code === 'PRINCIPAL' ? 'P' : 'G', l.on_hand, l.in_transit]).sort()).toEqual([
      ['G', '0.000', '4.000'],
      ['P', '5.000', '0.000'],
    ]);
    expect(d.movements[0]).toMatchObject({ kind: 'transfer_out', reversible: false });
  });
});

describe('privilégios e histórico', () => {
  it('a aplicação não grava saldo, eventos nem livro por fora; o histórico é imutável', async () => {
    const { variantId } = await newProduct('3');
    const denied = [
      appRole.query('UPDATE stock_location_balances SET blocked = 1 WHERE variant_id = $1', [variantId]),
      appRole.query('UPDATE stock_transfer_events SET reason = $1', ['x']),
      appRole.query('DELETE FROM stock_transfers'),
      appRole.query('DELETE FROM stock_adjustment_requests'),
      appRole.query('DELETE FROM stock_location_settings'),
    ];
    for (const p of denied) expect((await pgError(p)).code).toBe('42501');
    // Saldo novo mexido sem movimento: recusado no COMMIT pela trava ampliada.
    const c = await appRole.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE stock_balances SET blocked = blocked + 1 WHERE variant_id = $1', [variantId]);
      expect((await pgError(c.query('COMMIT'))).constraint).toBe('stock_balances_requires_movement');
    } finally {
      c.release();
    }
    const g = await newWarehouse();
    await send(principal, g, [{ variantId, qty: '1' }]);
    expect((await pgError(owner.query('UPDATE stock_transfer_events SET reason = $1', ['x']))).code).toBe('23001');
  });

  it('papéis: só quem pode vê os botões certos no servidor', async () => {
    const { variantId } = await newProduct('5');
    const g = await newWarehouse();
    const roles: Record<string, { transfer: number; hold: number; adjust: number }> = {
      sales: { transfer: 403, hold: 403, adjust: 403 },
      buyer: { transfer: 403, hold: 403, adjust: 403 },
      finance: { transfer: 403, hold: 403, adjust: 403 },
      stock: { transfer: 201, hold: 201, adjust: 403 },
    };
    for (const [role, want] of Object.entries(roles)) {
      const c = await loggedAs(app, role);
      expect((await c.post(T, { fromWarehouseId: principal, toWarehouseId: g, items: [{ variantId, qty: '1' }], requestKey: key(), receiveNow: true })).statusCode, role).toBe(want.transfer);
      expect((await c.post(`${S}/holds`, { variantId, op: 'block', qty: '1', reason: 'Teste', requestKey: key() })).statusCode, role).toBe(want.hold);
      expect((await c.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '1', reason: 'Teste', requestKey: key() })).statusCode, role).toBe(want.adjust);
    }
    expect(await reconcile()).toEqual([]);
  });
});

describe('proprietário do sistema depois da atualização', () => {
  it('sem MFA continua operando o estoque e pede ajuste; com MFA ajusta, estorna, cadastra depósito e aprova', async () => {
    const { variantId } = await newProduct('10');
    const g = await newWarehouse();
    const plain = await loggedAs(app, 'owner');
    // Sem verificação em duas etapas: consulta, transfere, bloqueia e pede ajuste; não ajusta direto nem cadastra depósito.
    expect((await plain.get(`${S}/variants/${variantId}`)).statusCode).toBe(200);
    expect((await plain.post(T, { fromWarehouseId: principal, toWarehouseId: g, items: [{ variantId, qty: '1' }], requestKey: key(), receiveNow: true })).statusCode).toBe(201);
    expect((await plain.post(`${S}/holds`, { variantId, op: 'block', qty: '1', reason: 'Conferência', requestKey: key() })).statusCode).toBe(201);
    expect((await plain.post(`${S}/holds`, { variantId, op: 'unblock', qty: '1', reason: 'Conferido', requestKey: key() })).statusCode).toBe(201);
    expect((await plain.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '1', reason: 'Teste', requestKey: key() })).json().error.code).toBe('MFA_REQUIRED');
    expect((await plain.post(W, { code: `X${uid()}`.slice(0, 12).toUpperCase(), name: `Sem MFA ${uid()}` })).json().error.code).toBe('MFA_REQUIRED');
    const req = await plain.post(`${S}/adjustment-requests`, { variantId, kind: 'loss', qty: '1', reason: 'Pacote rasgado', requestKey: key() });
    expect(req.statusCode, req.body).toBe(201);

    // Com MFA: tudo o que é sensível, inclusive aprovar o pedido de outra pessoa.
    const mfa = await loggedAs(app, 'owner', { mfa: true });
    const adj = await mfa.post(`${S}/movements`, { variantId, kind: 'adjustment', qty: '2', reason: 'Achado na conferência', requestKey: key() });
    expect(adj.statusCode, adj.body).toBe(201);
    expect((await mfa.post(`${S}/movements/${adj.json().movement.id}/reverse`, { reason: 'Lançado errado', requestKey: key() })).statusCode).toBe(201);
    expect((await mfa.post(W, { code: `Y${uid()}`.slice(0, 12).toUpperCase(), name: `Com MFA ${uid()}` })).statusCode).toBe(201);
    const ok = await mfa.post(`${S}/adjustment-requests/${req.json().request.id}/approve`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request.status).toBe('approved');
    // 10 − 1 transferido − 1 perda aprovada (ajuste e estorno se anulam).
    expect((await loc(principal, variantId)).on_hand).toBe('8.000');
    expect(await reconcile()).toEqual([]);
  });
});

describe('migração 0022', () => {
  it('a reversão recusa quando já houve uso da Fase 3 (nada muda)', async () => {
    const { variantId } = await newProduct('2');
    const g = await newWarehouse();
    await send(principal, g, [{ variantId, qty: '1' }]);
    const down = readFileSync(new URL('../migrations/0022_sglog_estoque.down.sql', import.meta.url), 'utf8');
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      const e = await pgError(c.query(down));
      expect(e.message).toMatch(/Reversao da 0022 recusada/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'stock_balances' AND column_name = 'in_transit'`)).rows[0].n).toBe(1);
  });
});
