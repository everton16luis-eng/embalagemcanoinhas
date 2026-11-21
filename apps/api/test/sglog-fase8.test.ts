/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { FakeCarrier, MelhorEnvioProvider, meDate, setCarrierProvider, type CarrierItem, type Fetcher } from '../src/lib/carriers.js';
import { safeError } from '../src/lib/integration-jobs.js';
import { FakeProvider } from '../src/lib/payments.js';
import { integrationTick } from '../src/modules/freight.js';
import { allocateOrder, appRole, loggedAs, makeApp, ORIGIN, owner, packOrder, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// SGLog Fase 8 (docs/35-sglog-fase8.md): cotacao por deposito e volumes medidos, etiqueta bloqueada (e, so nos testes,
// liberada com o simulado), idempotencia e respostas incertas, fila, rastreio e avisos do transportador, custos e
// relatorio, permissoes e MFA, compatibilidade e a reversao da 0027.

class SpyCarrier extends FakeCarrier {
  last: { fromCep: string; toCep: string; services: string[]; items: CarrierItem[] } | null = null;
  override async quote(q: { fromCep: string; toCep: string; services: string[]; items: CarrierItem[] }) {
    this.last = q;
    return super.quote(q);
  }
}

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>; // gerente com MFA
const carrier = new SpyCarrier();
let carrierId: string;
let pickupId: string;
let principal: string;

const F = '/api/v1/admin/freight';
const SH = '/api/v1/admin/shipments';
const key = () => `k-${uid()}-${uid()}`;
const buyer = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '(47) 99999-0000', document: '529.982.247-25' };
const address = { recipient: 'Maria Confeiteira', cep: '01310-100', street: 'Avenida Paulista', number: '1000', district: 'Bela Vista', city: 'São Paulo', uf: 'SP' };
const VOLUMES = [
  { weightG: 1500, lengthMm: 300, widthMm: 200, heightMm: 150 },
  { weightG: 800, lengthMm: 200, widthMm: 200, heightMm: 100 },
];

function shopper() {
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const c of res.cookies) {
      if (c.value) jar[c.name] = c.value;
      else delete jar[c.name];
    }
    return res;
  };
  return { get: (u: string) => send('GET', u), post: (u: string, b: unknown = {}) => send('POST', u, b) };
}

async function newProduct(stock = '1000') {
  const res = await boss.post(
    '/api/v1/admin/products',
    productPayload({
      variants: [
        {
          sku: `F8S-${uid()}`.toUpperCase(),
          weightG: 4,
          lengthMm: 80,
          widthMm: 80,
          heightMm: 95,
          packagings: [
            { kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 25 },
            { kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true },
          ],
        },
      ],
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  const v = res.json().product.variants[0];
  await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: key() });
  return { variantId: v.id as string, pack50: (v.packagings as any[]).find((k) => k.label === 'Pacote com 50').id as string };
}

/** Pedido pago com entrega por transportadora, alocado; `pack` leva ate embalada com os volumes informados. */
async function deliveryOrder(opts: { pack?: boolean; packages?: object[]; pickup?: boolean } = {}) {
  const p = await newProduct();
  const s = shopper();
  await s.post('/api/v1/public/cart/items', { packagingId: p.pack50, packs: 2 });
  const cart = (await s.get('/api/v1/public/cart')).json().cart;
  let freight = 0;
  if (!opts.pickup) {
    const q = (await s.get('/api/v1/public/shipping/quote?cep=01310100')).json();
    freight = q.options.find((o: any) => o.id === carrierId).priceCents;
  }
  const placed = await s.post('/api/v1/public/checkout', {
    requestKey: `f8-${uid()}`,
    buyer,
    shippingOptionId: opts.pickup ? pickupId : carrierId,
    ...(opts.pickup ? {} : { address }),
    paymentMethod: 'pix',
    expectedTotalCents: cart.subtotalCents + freight,
  });
  expect(placed.statusCode, placed.body).toBe(201);
  const o = placed.json().order as { id: string; token: string };
  expect((await s.post(`/api/v1/public/orders/${o.token}/pay/pix`)).statusCode).toBe(200);
  expect((await s.post(`/api/v1/public/dev-payments/${o.token}/approve-pix`)).statusCode).toBe(200);
  await allocateOrder(boss, o.id);
  const shipment = (await owner.query<{ id: string }>(`SELECT id FROM shipments WHERE order_id = $1 AND status <> 'canceled'`, [o.id])).rows[0]!.id;
  if (opts.pack !== false) await packOrder(boss, o.id, (opts.packages ?? VOLUMES) as any);
  return { orderId: o.id, token: o.token, shipment, variantId: p.variantId, freight, s };
}

const authorize = (orderId: string) => owner.query(`UPDATE orders SET invoice_status = 'authorized' WHERE id = $1`, [orderId]);
const view = async (id: string, c = boss) => {
  const r = await c.get(`${F}/shipments/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().freight;
};
async function quote(id: string, c = boss) {
  const r = await c.post(`${F}/shipments/${id}/quotes`, {});
  expect(r.statusCode, r.body).toBe(200);
  return r.json().freight;
}
async function select(id: string, quoteId?: string) {
  const f = await view(id);
  const q = quoteId ?? f.quotes.filter((x: any) => !x.expired && !x.stale).sort((a: any, b: any) => a.price_cents - b.price_cents)[0].id;
  const r = await boss.post(`${F}/shipments/${id}/quote-selection`, { quoteId: q, version: f.shipment.version, requestKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().freight;
}
const requestLabel = async (id: string, c = boss, extra: Record<string, unknown> = {}) => {
  const f = await view(id);
  return c.post(`${F}/shipments/${id}/labels`, { version: f.shipment.version, requestKey: key(), ...extra });
};
const labels = async (shipmentId: string) =>
  (await owner.query('SELECT id, status, external_id, tracking_code, cost_cents, refund_status, version, error FROM shipping_labels WHERE shipment_id = $1 ORDER BY requested_at', [shipmentId])).rows;
const costs = async (shipmentId: string) => (await owner.query('SELECT kind, amount_cents, label_id FROM shipment_freight_costs WHERE shipment_id = $1 ORDER BY id', [shipmentId])).rows;
const shipmentRow = async (id: string) =>
  (await owner.query('SELECT status, version, tracking_code, tracking_status, carrier_provider, carrier_service, quote_id, delivered_at FROM shipments WHERE id = $1', [id])).rows[0];
const movements = async (variantId: string) => (await owner.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].n as number;
const settingsVersion = async () => (await owner.query('SELECT version FROM logistics_settings')).rows[0].version as number;
const tick = () => integrationTick(carrier, 50);
const dueNow = () => owner.query(`UPDATE integration_jobs SET next_run_at = now() WHERE status = 'pending'`);

async function enableLabels(maxCents = 50_000) {
  (config as any).SHIPPING_LABELS_ENABLED = true;
  const r = await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste automatizado', maxCents, version: await settingsVersion() });
  expect(r.statusCode, r.body).toBe(200);
}
async function blockLabels() {
  const r = await boss.put(`${F}/settings/labels`, { status: 'blocked', version: await settingsVersion() });
  expect(r.statusCode, r.body).toBe(200);
  (config as any).SHIPPING_LABELS_ENABLED = false;
}
/** Remessa embalada, NF-e autorizada, cotada e com servico escolhido. */
async function ready() {
  const o = await deliveryOrder();
  await authorize(o.orderId);
  await quote(o.shipment);
  await select(o.shipment);
  return o;
}
async function purchased() {
  const o = await ready();
  const r = await requestLabel(o.shipment);
  expect(r.statusCode, r.body).toBe(200);
  await tick();
  const [l] = await labels(o.shipment);
  expect(l.status).toBe('purchased');
  return { ...o, label: l };
}
async function dispatch(id: string, body: Record<string, unknown> = {}) {
  const s = (await boss.get(`${SH}/${id}`)).json().shipment;
  const r = await boss.post(`${SH}/${id}/dispatch`, { version: s.version, requestKey: key(), ...body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().shipment;
}
const signedWebhook = (body: unknown, secret = FakeCarrier.WEBHOOK_SECRET) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/carriers/fake',
    headers: { 'content-type': 'application/json', 'x-me-signature': createHmac('sha256', secret).update(raw).digest('base64') },
    payload: raw,
  });
};
const pgError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string; message: string };
  }
  throw new Error('a operacao deveria ter sido recusada');
};

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { carrier });
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  (config as any).SHIP_FROM_CEP = '89460000';
  (config as any).SHIPPING_LABELS_ENABLED = false;
  pickupId = (await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', baseCents: 0, minDays: 0, maxDays: 1 })).json().option.id;
  const c = await boss.post('/api/v1/admin/shipping-options', { name: 'Transportadora econômica', kind: 'carrier', carrierService: '3', handlingDays: 1, baseCents: 0, minDays: 0, maxDays: 0 });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().option.id;
  await boss.post('/api/v1/admin/shipping-options', { name: 'Transportadora expressa', kind: 'carrier', carrierService: '4', handlingDays: 0, baseCents: 0, minDays: 0, maxDays: 0 });
  principal = (await owner.query('SELECT id FROM warehouses WHERE is_default')).rows[0].id;
  await owner.query(`UPDATE warehouses SET cep = '88010000', street = 'Rua do Depósito', number = '10', district = 'Centro', city = 'Florianópolis', uf = 'SC' WHERE id = $1`, [principal]);
});
afterEach(() => {
  carrier.labelMode = 'ok';
  carrier.cancelMode = 'ok';
  carrier.findUnknown = 0;
  carrier.trackDown = false;
  carrier.down = false;
  carrier.costDelta = 0;
  setCarrierProvider(carrier);
});
afterAll(async () => {
  (config as any).SHIPPING_LABELS_ENABLED = false;
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('cotação da remessa', () => {
  it('usa o CEP do depósito e os volumes medidos; guarda a cotação com validade e os volumes', async () => {
    const o = await deliveryOrder();
    const f = await quote(o.shipment);
    expect(carrier.last!.fromCep).toBe('88010000'); // deposito, nao a empresa (89460000)
    expect(carrier.last!.toCep).toBe('01310100');
    expect(carrier.last!.items).toHaveLength(2);
    expect(carrier.last!.items[0]).toMatchObject({ widthCm: 20, heightCm: 15, lengthCm: 30, weightKg: 1.5, quantity: 1 });
    expect(carrier.last!.services.sort()).toEqual(['3', '4']);
    // 2,3 kg -> 3 kg: 1500 + 300 + 750 (servico 3) e 1500 + 400 + 750 (servico 4).
    expect(f.quotes.map((q: any) => q.price_cents)).toEqual([2550, 2650]);
    expect(f.quotes[0]).toMatchObject({ from_cep: '88010000', to_cep: '01310100', expired: false, stale: false });
    expect(f.quotes[0].packages).toEqual(VOLUMES);
    // Seguro: valor dos itens da remessa (2 pacotes de R$ 10,00), dividido entre os volumes.
    expect(f.quotes[0].insurance_cents).toBe(2000);
    expect(carrier.last!.items.reduce((s, i) => s + i.insuranceCents, 0)).toBe(2000);
    expect(f.charged).toMatchObject({ cents: o.freight, split: false });
    expect(f.selectedQuote).toBeNull();
    const sel = await select(o.shipment);
    expect(sel.selectedQuote.price_cents).toBe(2550);
    expect(await shipmentRow(o.shipment)).toMatchObject({ carrier_provider: 'fake', carrier_service: '3' });
    // Log da chamada sem corpo.
    const log = (await owner.query(`SELECT provider, operation, ok, error FROM integration_logs WHERE operation = 'quote' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log).toMatchObject({ provider: 'fake', operation: 'quote', ok: true, error: null });
  });

  it('recusa sem medidas, sem CEP do depósito, sem embalar, retirada; provedor fora do ar não muda nada', async () => {
    const noDims = await deliveryOrder({ packages: [{ weightG: 900 }] });
    const r1 = await boss.post(`${F}/shipments/${noDims.shipment}/quotes`, {});
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe('PACKAGES_INCOMPLETE');

    const open = await deliveryOrder({ pack: false });
    expect((await boss.post(`${F}/shipments/${open.shipment}/quotes`, {})).json().error.code).toBe('NOT_PACKED');

    const pick = await deliveryOrder({ pickup: true });
    expect((await boss.post(`${F}/shipments/${pick.shipment}/quotes`, {})).json().error.code).toBe('NOT_CARRIER_SHIPMENT');

    const o = await deliveryOrder();
    await owner.query('UPDATE warehouses SET cep = NULL WHERE id = $1', [principal]);
    try {
      expect((await boss.post(`${F}/shipments/${o.shipment}/quotes`, {})).json().error.code).toBe('WAREHOUSE_ADDRESS_MISSING');
    } finally {
      await owner.query(`UPDATE warehouses SET cep = '88010000' WHERE id = $1`, [principal]);
    }
    carrier.down = true;
    const down = await boss.post(`${F}/shipments/${o.shipment}/quotes`, {});
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe('CARRIER_UNAVAILABLE');
    expect((await owner.query('SELECT count(*)::int AS n FROM shipping_quotes WHERE shipment_id = $1', [o.shipment])).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT ok FROM integration_logs WHERE operation = 'quote' ORDER BY id DESC LIMIT 1`)).rows[0].ok).toBe(false);
  });

  it('cotação vencida ou de outra embalagem não vale; reabrir a embalagem tira o serviço escolhido', async () => {
    const o = await deliveryOrder();
    const f = await quote(o.shipment);
    // Cotacao vencida (gravada pelo dono: a tabela e imutavel).
    const old = (
      await owner.query(
        `INSERT INTO shipping_quotes (shipment_id, batch_id, provider, service, service_name, price_cents, days, from_cep, to_cep, packages, insurance_cents, quoted_at, expires_at)
         VALUES ($1, gen_random_uuid(), 'fake', '3', 'Velha', 999, 3, '88010000', '01310100', $2, 0, now() - interval '3 hours', now() - interval '1 hour') RETURNING id`,
        [o.shipment, JSON.stringify(VOLUMES)],
      )
    ).rows[0].id;
    const exp = await boss.post(`${F}/shipments/${o.shipment}/quote-selection`, { quoteId: old, version: f.shipment.version, requestKey: key() });
    expect(exp.json().error.code).toBe('QUOTE_EXPIRED');
    expect(await pgError(owner.query('UPDATE shipping_quotes SET price_cents = 1 WHERE id = $1', [old]))).toBeTruthy();

    await select(o.shipment);
    const s = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    const reopen = await boss.post(`${SH}/${o.shipment}/reopen`, { version: s.version, to: 'checking', note: 'Trocar a caixa', requestKey: key() });
    expect(reopen.statusCode, reopen.body).toBe(200);
    expect(await shipmentRow(o.shipment)).toMatchObject({ quote_id: null, carrier_service: null });
    await packOrder(boss, o.orderId, [{ weightG: 2000, lengthMm: 400, widthMm: 300, heightMm: 200 }]);
    const g = await view(o.shipment);
    expect(g.quotes.every((q: any) => q.stale)).toBe(true);
    const stale = await boss.post(`${F}/shipments/${o.shipment}/quote-selection`, { quoteId: g.quotes[0].id, version: g.shipment.version, requestKey: key() });
    expect(stale.json().error.code).toBe('QUOTE_STALE');
  });
});

describe('etiqueta: compra real bloqueada', () => {
  it('por padrão a API recusa; nada é gravado nem enviado ao provedor', async () => {
    const o = await ready();
    const before = carrier.buyCalls;
    const r = await requestLabel(o.shipment);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('LABELS_BLOCKED');
    expect(r.json().error.details.reasons.join(' ')).toMatch(/SHIPPING_LABELS_ENABLED/);
    expect(r.json().error.details.reasons.join(' ')).toMatch(/limite por etiqueta não foi definido/);
    expect(await labels(o.shipment)).toHaveLength(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'label_purchase'`)).rows[0].n).toBe(0);
    await tick();
    expect(carrier.buyCalls).toBe(before);
    const ov = (await boss.get(`${F}/overview`)).json();
    expect(ov.gate.allowed).toBe(false);
  });

  it('liberar exige o servidor, um provedor que compre, quem validou e um limite definido (nunca "sem limite")', async () => {
    const v = await settingsVersion();
    const off = await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste', maxCents: 5000, version: v });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('LABELS_BLOCKED');
    (config as any).SHIPPING_LABELS_ENABLED = true;
    try {
      expect((await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste', version: v })).statusCode).toBe(400);
      expect((await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste', maxCents: 0, version: v })).statusCode).toBe(400);
      // Banco: liberado sem limite e recusado.
      expect((await pgError(owner.query(`UPDATE logistics_settings SET label_status = 'enabled', label_validator_name = 'x x x', label_validated_by = (SELECT id FROM users LIMIT 1), label_validated_at = now()`))).constraint).toBe(
        'logistics_settings_label_validated',
      );
      // Melhor Envio nao compra etiqueta nesta versao: liberar e recusado mesmo com o servidor ligado.
      const me = new MelhorEnvioProvider({ token: 'x'.repeat(30), userAgent: 'Loja (teste@loja.test)', sandbox: true });
      expect(me.capabilities.labels).toBe(false);
      expect((me as any).buyLabel).toBeUndefined();
      setCarrierProvider(me);
      const r = await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste', maxCents: 5000, version: v });
      expect(r.statusCode).toBe(409);
      const g = (await boss.get(`${F}/settings`)).json().gate;
      expect(g.allowed).toBe(false);
      expect(g.reasons.join(' ')).toMatch(/Melhor Envio não compra etiqueta/);
    } finally {
      setCarrierProvider(carrier);
      (config as any).SHIPPING_LABELS_ENABLED = false;
    }
  });

  it('bloquear depois do pedido: a fila não compra (processo automático também respeita a trava)', async () => {
    await enableLabels();
    const o = await ready();
    expect((await requestLabel(o.shipment)).statusCode).toBe(200);
    await blockLabels();
    const before = carrier.buyCalls;
    await tick();
    expect(carrier.buyCalls).toBe(before);
    const [l] = await labels(o.shipment);
    expect(l.status).toBe('failed');
    expect(l.error).toMatch(/bloqueada/);
  });
});

describe('etiqueta liberada só nos testes (simulado)', () => {
  beforeAll(() => enableLabels());
  afterAll(() => blockLabels());

  it('permissões e MFA: expedição não compra; gerente sem MFA é recusado; logística com MFA compra', async () => {
    const o = await ready();
    const ship = await loggedAs(app, 'shipping', { mfa: true });
    expect((await requestLabel(o.shipment, ship)).statusCode).toBe(403);
    const noMfa = await loggedAs(app, 'manager');
    const r = await requestLabel(o.shipment, noMfa);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MFA_REQUIRED');
    // Expedicao cota (shipping.manage), mas nao compra.
    expect((await ship.post(`${F}/shipments/${o.shipment}/quotes`, {})).statusCode).toBe(200);
    const log = await loggedAs(app, 'logistics', { mfa: true });
    expect((await requestLabel(o.shipment, log)).statusCode).toBe(200);
    const fin = await loggedAs(app, 'finance');
    expect((await fin.get(`${F}/overview`)).statusCode).toBe(403);
    expect((await fin.get(`${F}/report`)).statusCode).toBe(200);
  });

  it('pré-condições: NF-e, cotação, limite com justificativa', async () => {
    const o = await deliveryOrder();
    expect((await requestLabel(o.shipment)).json().error.code).toBe('INVOICE_REQUIRED');
    await authorize(o.orderId);
    await quote(o.shipment);
    expect((await requestLabel(o.shipment)).json().error.code).toBe('QUOTE_REQUIRED');
    await select(o.shipment);
    const v = await settingsVersion();
    expect((await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste automatizado', maxCents: 1000, version: v })).statusCode).toBe(200);
    try {
      const over = await requestLabel(o.shipment);
      expect(over.statusCode).toBe(422);
      expect(over.json().error).toMatchObject({ code: 'OVER_LABEL_LIMIT', details: { limitCents: 1000 } });
      const ok = await requestLabel(o.shipment, boss, { overLimitReason: 'Cliente pediu o serviço mais rápido' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await owner.query('SELECT over_limit_reason FROM shipping_labels WHERE shipment_id = $1', [o.shipment])).rows[0].over_limit_reason).toMatch(/Cliente/);
    } finally {
      await boss.put(`${F}/settings/labels`, { status: 'enabled', validatorName: 'Teste automatizado', maxCents: 50_000, version: await settingsVersion() });
    }
  });

  it('idempotência e concorrência: uma etiqueta e uma cobrança por remessa; a etiqueta não despacha nem mexe no estoque', async () => {
    const o = await ready();
    const m0 = await movements(o.variantId);
    const f = await view(o.shipment);
    const k = key();
    const same = await Promise.all([1, 2].map(() => boss.post(`${F}/shipments/${o.shipment}/labels`, { version: f.shipment.version, requestKey: k })));
    expect(same.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await labels(o.shipment)).toHaveLength(1);
    const rival = await requestLabel(o.shipment);
    expect(rival.statusCode).toBe(409);
    expect(rival.json().error.code).toBe('LABEL_ACTIVE');

    const o2 = await ready();
    const f2 = await view(o2.shipment);
    const race = await Promise.all([1, 2, 3].map(() => boss.post(`${F}/shipments/${o2.shipment}/labels`, { version: f2.shipment.version, requestKey: key() })));
    expect(race.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(race.filter((r) => r.statusCode === 409)).toHaveLength(2);
    expect(await labels(o2.shipment)).toHaveLength(1);

    const before = carrier.buyCalls;
    const pending = (await owner.query(`SELECT count(*)::int AS n FROM shipping_labels WHERE status = 'requested'`)).rows[0].n as number;
    await tick();
    await tick();
    expect(carrier.buyCalls).toBe(before + pending);
    expect((await labels(o2.shipment)).map((x: any) => x.status)).toEqual(['purchased']);
    const [l] = await labels(o.shipment);
    expect(l).toMatchObject({ status: 'purchased' });
    expect(l.tracking_code).toMatch(/^FK\d{9}BR$/);
    expect(await costs(o.shipment)).toEqual([{ kind: 'label', amount_cents: l.cost_cents, label_id: l.id }]);
    expect(await shipmentRow(o.shipment)).toMatchObject({ status: 'packed', tracking_code: l.tracking_code, carrier_provider: 'fake' });
    expect(await movements(o.variantId)).toBe(m0);
    // Despacho: rastreio vem da etiqueta; custo manual recusado (veio da etiqueta).
    const s = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    const bad = await boss.post(`${SH}/${o.shipment}/dispatch`, { version: s.version, requestKey: key(), freightCostCents: 100 });
    expect(bad.json().error.code).toBe('COST_FROM_LABEL');
    const d = await dispatch(o.shipment);
    expect(d.tracking_code).toBe(l.tracking_code);
    expect(await movements(o.variantId)).toBeGreaterThan(m0); // a baixa e do despacho
  });

  it('resposta incerta com cobrança: nunca compra de novo; a reconciliação encontra a compra', async () => {
    const o = await ready();
    carrier.labelMode = 'uncertain_charged';
    expect((await requestLabel(o.shipment)).statusCode).toBe(200);
    const before = carrier.buyCalls;
    await tick();
    expect(carrier.buyCalls).toBe(before + 1);
    let [l] = await labels(o.shipment);
    expect(l.status).toBe('uncertain');
    expect(await costs(o.shipment)).toEqual([]);
    // Nova compra recusada enquanto incerta; cancelar tambem.
    expect((await requestLabel(o.shipment)).json().error.code).toBe('LABEL_ACTIVE');
    expect((await boss.post(`${F}/labels/${l.id}/cancel`, { version: l.version, reason: 'Teste' })).json().error.code).toBe('LABEL_UNCERTAIN');
    const s = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    expect((await boss.post(`${SH}/${o.shipment}/dispatch`, { version: s.version, requestKey: key() })).json().error.code).toBe('LABEL_PENDING');
    carrier.labelMode = 'ok';
    await tick(); // reconciliacao
    expect(carrier.buyCalls).toBe(before + 1);
    [l] = await labels(o.shipment);
    expect(l.status).toBe('purchased');
    expect((await costs(o.shipment)).map((c: any) => c.kind)).toEqual(['label']);
    const ev = (await owner.query('SELECT to_status FROM shipping_label_events WHERE label_id = $1 ORDER BY id', [l.id])).rows.map((r) => r.to_status);
    expect(ev).toEqual(['requested', 'purchasing', 'uncertain', 'purchased']);
  });

  it('resposta incerta sem cobrança: aguarda o provedor, confirma que não houve compra e libera nova etiqueta', async () => {
    const o = await ready();
    carrier.labelMode = 'uncertain_none';
    carrier.findUnknown = 1;
    expect((await requestLabel(o.shipment)).statusCode).toBe(200);
    await tick();
    expect((await labels(o.shipment))[0].status).toBe('uncertain');
    await tick(); // reconciliacao: provedor ainda nao sabe
    const job = (await owner.query(`SELECT status, attempts, last_error FROM integration_jobs WHERE kind = 'label_reconcile' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await labels(o.shipment))[0].status).toBe('uncertain');
    await dueNow();
    await tick();
    expect((await labels(o.shipment))[0].status).toBe('failed');
    carrier.labelMode = 'ok';
    expect((await requestLabel(o.shipment)).statusCode).toBe(200);
    await tick();
    expect((await labels(o.shipment)).map((l: any) => l.status)).toEqual(['failed', 'purchased']);
    expect(await costs(o.shipment)).toHaveLength(1);
  });

  it('queda no meio da compra vira incerta (sem nova chamada); recusa do provedor vira falha; resolução manual com MFA', async () => {
    const o = await ready();
    expect((await requestLabel(o.shipment)).statusCode).toBe(200);
    const [l0] = await labels(o.shipment);
    await owner.query(`UPDATE shipping_labels SET status = 'purchasing' WHERE id = $1`, [l0.id]);
    const before = carrier.buyCalls;
    await tick();
    expect(carrier.buyCalls).toBe(before);
    let [l] = await labels(o.shipment);
    expect(l.status).toBe('uncertain');
    // Decisao registrada: conferido no painel do transportador.
    const noMfa = await loggedAs(app, 'manager');
    expect((await noMfa.post(`${F}/labels/${l.id}/resolve`, { version: l.version, outcome: 'not_purchased', note: 'Conferido no painel' })).statusCode).toBe(403);
    const r = await boss.post(`${F}/labels/${l.id}/resolve`, { version: l.version, outcome: 'not_purchased', note: 'Conferido no painel do transportador: sem compra' });
    expect(r.statusCode, r.body).toBe(200);
    [l] = await labels(o.shipment);
    expect(l.status).toBe('failed');
    expect((await owner.query(`SELECT status FROM integration_jobs WHERE kind = 'label_reconcile' AND ref_id = $1`, [l.id])).rows.every((j) => j.status !== 'pending')).toBe(true);

    carrier.labelMode = 'reject';
    expect((await requestLabel(o.shipment)).statusCode).toBe(200);
    await tick();
    const all = await labels(o.shipment);
    expect(all.map((x: any) => x.status)).toEqual(['failed', 'failed']);
    expect(all[1].error).toMatch(/indisponível/);
  });

  it('cancelamento: pedido ao provedor, aguarda confirmação; remessa com etiqueta ativa não cancela; estorno só confirmado', async () => {
    const o = await purchased();
    const s = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    // Remessa com etiqueta ativa: cancelar, liberar e reabrir recusados; o banco tambem recusa.
    expect((await boss.post(`${SH}/${o.shipment}/release`, { version: s.version, note: 'Teste', requestKey: key() })).json().error.code).toBe('LABEL_ACTIVE');
    expect((await boss.post(`${SH}/${o.shipment}/reopen`, { version: s.version, to: 'checking', note: 'Teste', requestKey: key() })).json().error.code).toBe('LABEL_ACTIVE');
    expect((await boss.post(`${SH}/${o.shipment}/cancel`, { version: s.version, reason: 'Teste', requestKey: key() })).json().error.code).toBe('LABEL_ACTIVE');
    expect(
      (await pgError(owner.query(`UPDATE shipments SET status = 'canceled', canceled_at = now(), cancel_reason = 'teste direto' WHERE id = $1`, [o.shipment]))).constraint,
    ).toBe('shipments_label_active');

    carrier.cancelMode = 'pending';
    const c = await boss.post(`${F}/labels/${o.label.id}/cancel`, { version: o.label.version, reason: 'Cliente desistiu' });
    expect(c.statusCode, c.body).toBe(200);
    await tick();
    let [l] = await labels(o.shipment);
    expect(l.status).toBe('cancel_requested');
    expect((await boss.post(`${SH}/${o.shipment}/release`, { version: s.version, note: 'Teste', requestKey: key() })).json().error.code).toBe('LABEL_ACTIVE');
    carrier.cancelMode = 'ok';
    await dueNow();
    await tick();
    [l] = await labels(o.shipment);
    expect(l).toMatchObject({ status: 'canceled', refund_status: 'pending' });
    // Estorno pendente nao entra como valor: o pago continua o da etiqueta.
    let f = await view(o.shipment);
    expect(f.costs).toMatchObject({ paidCents: l.cost_cents, refundedCents: null, pendingRefunds: 1 });
    const refund = await boss.post(`${F}/labels/${l.id}/refund`, { version: l.version, status: 'refunded', amountCents: l.cost_cents, note: 'Estorno no extrato do transportador' });
    expect(refund.statusCode, refund.body).toBe(200);
    f = await view(o.shipment);
    expect(f.costs).toMatchObject({ paidCents: l.cost_cents, refundedCents: -l.cost_cents, netCents: 0, pendingRefunds: 0 });
    // Agora a remessa pode voltar (etiqueta cancelada).
    const s2 = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    expect((await boss.post(`${SH}/${o.shipment}/release`, { version: s2.version, note: 'Recomeçar', requestKey: key() })).statusCode).toBe(200);
  });

  it('cancelamento recusado pelo provedor volta a etiqueta; remessa despachada não pede cancelamento', async () => {
    const o = await purchased();
    carrier.cancelMode = 'refused';
    expect((await boss.post(`${F}/labels/${o.label.id}/cancel`, { version: o.label.version, reason: 'Teste' })).statusCode).toBe(200);
    await tick();
    const [l] = await labels(o.shipment);
    expect(l.status).toBe('purchased');
    await dispatch(o.shipment);
    expect((await boss.post(`${F}/labels/${l.id}/cancel`, { version: l.version, reason: 'Teste' })).json().error.code).toBe('LABEL_POSTED');
  });
});

describe('rastreio', () => {
  beforeAll(() => enableLabels());
  afterAll(() => blockLabels());

  it('avança só para a frente; duplicado ignorado; atrasado e falha só no histórico; entregue projeta o pedido', async () => {
    const o = await purchased();
    await dispatch(o.shipment);
    const ext = o.label.external_id as string;
    // Horarios depois do despacho e antes de agora (evento no futuro e limitado ao horario atual).
    const t0 = Date.now();
    const t = (ms: number) => new Date(t0 + ms);
    carrier.trackScript.set(ext, [
      { status: 'posted', at: t(1), key: 'fake:posted', tracking: o.label.tracking_code },
      { status: 'out_for_delivery', at: t(4), key: 'fake:ofd', tracking: o.label.tracking_code },
    ]);
    await tick();
    expect(await shipmentRow(o.shipment)).toMatchObject({ status: 'out_for_delivery', tracking_status: 'out_for_delivery' });
    // Mesma consulta de novo (janela nova): nada duplicado.
    await owner.query('UPDATE shipments SET last_tracked_at = NULL WHERE id = $1', [o.shipment]);
    carrier.trackScript.set(ext, [
      ...carrier.trackScript.get(ext)!,
      { status: 'in_transit', at: t(2), key: 'fake:late', tracking: null },
      { status: 'delivery_failed', at: t(5), key: 'fake:fail', tracking: null },
    ]);
    await owner.query(`UPDATE integration_jobs SET idempotency_key = idempotency_key || ':' || id WHERE kind = 'tracking_poll'`);
    await tick();
    const ev = (await owner.query(`SELECT action, from_status, to_status, note FROM shipment_events WHERE shipment_id = $1 AND action LIKE 'track%' ORDER BY id`, [o.shipment])).rows;
    expect(ev.map((e) => e.action)).toEqual(['track_posted', 'track_out_for_delivery', 'track_in_transit', 'track_delivery_failed']);
    expect(ev[2]).toMatchObject({ from_status: 'out_for_delivery', to_status: 'out_for_delivery' });
    expect(ev[2].note).toMatch(/atrasado/);
    expect(ev[3].note).toMatch(/ocorrência/);
    expect((await shipmentRow(o.shipment)).status).toBe('out_for_delivery');
    // Entregue: remessa e pedido.
    await owner.query('UPDATE shipments SET last_tracked_at = NULL WHERE id = $1', [o.shipment]);
    await owner.query(`UPDATE integration_jobs SET idempotency_key = idempotency_key || ':' || id WHERE kind = 'tracking_poll'`);
    carrier.trackScript.set(ext, [...carrier.trackScript.get(ext)!, { status: 'delivered', at: t(6), key: 'fake:delivered', tracking: o.label.tracking_code }]);
    await tick();
    expect((await shipmentRow(o.shipment)).status).toBe('delivered');
    // Fase 9: a falha na entrega abriu ocorrencia que segura a conclusao ate alguem resolver.
    expect((await owner.query('SELECT status, logistics_status FROM orders WHERE id = $1', [o.orderId])).rows[0]).toMatchObject({ status: 'delivered', logistics_status: 'on_hold' });
    // Pagina do cliente: linha do tempo sem notas nem nomes.
    const pub = (await o.s.get(`/api/v1/public/orders/${o.token}`)).json().order;
    const tl = pub.shipments[0].timeline;
    expect(tl.map((x: any) => x.action)).toEqual(['dispatch', 'track_posted', 'track_in_transit', 'track_out_for_delivery', 'track_delivery_failed', 'track_delivered']);
    expect(JSON.stringify(tl)).not.toMatch(/note|actor|Transportador/);
  });

  it('código divergente não muda a remessa; provedor fora do ar: novas tentativas e falha definitiva com reprocessamento', async () => {
    const o = await purchased();
    await dispatch(o.shipment);
    const ext = o.label.external_id as string;
    carrier.trackScript.set(ext, [{ status: 'delivered', at: new Date(), key: 'fake:other', tracking: 'OUTRO123BR' }]);
    await tick();
    const row = await shipmentRow(o.shipment);
    expect(row.status).toBe('shipped');
    expect((await owner.query(`SELECT note FROM shipment_events WHERE shipment_id = $1 AND action = 'track_delivered'`, [o.shipment])).rows[0].note).toMatch(/diferente/);

    carrier.trackDown = true;
    await owner.query('UPDATE shipments SET last_tracked_at = NULL WHERE id = $1', [o.shipment]);
    await owner.query(`UPDATE integration_jobs SET idempotency_key = idempotency_key || ':' || id WHERE kind = 'tracking_poll'`);
    for (let i = 0; i < 3; i++) {
      await tick();
      await dueNow();
    }
    const job = (await owner.query(`SELECT id::text, status, attempts, last_error FROM integration_jobs WHERE kind = 'tracking_poll' AND ref_id = $1 ORDER BY id DESC LIMIT 1`, [o.shipment])).rows[0];
    expect(job).toMatchObject({ status: 'dead', attempts: 3 });
    expect(job.last_error).toMatch(/fora do ar/);
    const jobs = (await boss.get(`${F}/jobs?status=dead`)).json();
    expect(jobs.items.some((j: any) => j.id === job.id && j.logs.length > 0)).toBe(true);
    const stock = await loggedAs(app, 'stock');
    expect((await stock.post(`${F}/jobs/${job.id}/retry`, {})).statusCode).toBe(403);
    expect((await boss.post(`${F}/jobs/${job.id}/retry`, {})).statusCode).toBe(200);
    expect((await boss.post(`${F}/jobs/${job.id}/retry`, {})).statusCode).toBe(409);
    carrier.trackDown = false;
    carrier.trackScript.set(ext, []);
    await tick();
    expect((await owner.query('SELECT status FROM integration_jobs WHERE id = $1', [job.id])).rows[0].status).toBe('done');
  });

  it('aviso do transportador: assinatura inválida recusada; repetido uma vez só; fora de ordem não rebaixa', async () => {
    const o = await purchased();
    await dispatch(o.shipment);
    const ext = o.label.external_id as string;
    const delivered = { event: 'order.delivered', id: ext, status: 'delivered', at: new Date(Date.now() - 60_000).toISOString(), tracking: o.label.tracking_code };
    const bad = await signedWebhook(delivered, 'segredo-errado-errado');
    expect(bad.statusCode).toBe(401);
    const nosig = await app.inject({ method: 'POST', url: '/api/v1/webhooks/carriers/fake', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(delivered) });
    expect(nosig.statusCode).toBe(401);
    expect((await owner.query('SELECT count(*)::int AS n FROM logistics_webhook_events')).rows[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM integration_logs WHERE operation = 'webhook_rejected'`)).rows[0].n).toBeGreaterThanOrEqual(2);

    expect((await signedWebhook(delivered)).statusCode).toBe(200);
    expect((await signedWebhook(delivered)).statusCode).toBe(200);
    expect((await owner.query('SELECT count(*)::int AS n FROM logistics_webhook_events WHERE external_id = $1', [ext])).rows[0].n).toBe(1);
    await tick();
    expect((await shipmentRow(o.shipment)).status).toBe('delivered');
    // Atrasado: saiu para entrega depois de entregue.
    const late = { event: 'order.out', id: ext, status: 'out_for_delivery', at: new Date(Date.now() - 3_600_000).toISOString(), tracking: o.label.tracking_code };
    expect((await signedWebhook(late)).statusCode).toBe(200);
    await tick();
    expect((await shipmentRow(o.shipment)).status).toBe('delivered');
    expect((await owner.query(`SELECT status FROM logistics_webhook_events WHERE external_id = $1 ORDER BY id`, [ext])).rows.map((r) => r.status)).toEqual(['processed', 'processed']);
    // Etiqueta desconhecida: aceito e ignorado (nao atualiza remessa errada).
    expect((await signedWebhook({ event: 'order.delivered', id: 'fake-desconhecida', status: 'delivered', at: new Date().toISOString() })).statusCode).toBe(200);
    await tick();
    expect((await owner.query(`SELECT status, error FROM logistics_webhook_events WHERE external_id = 'fake-desconhecida'`)).rows[0]).toMatchObject({ status: 'ignored' });
  });

  it('rastreio manual (transportadora sem integração): mesmas regras e chave de requisição', async () => {
    const o = await deliveryOrder();
    await authorize(o.orderId);
    await dispatch(o.shipment, { carrier: 'Transportadora local', trackingCode: 'LOC123' });
    expect((await shipmentRow(o.shipment)).carrier_provider).toBe('manual');
    const k = key();
    for (let i = 0; i < 2; i++) expect((await boss.post(`${F}/shipments/${o.shipment}/tracking`, { status: 'in_transit', requestKey: k })).statusCode).toBe(200);
    expect((await owner.query(`SELECT count(*)::int AS n FROM shipment_events WHERE shipment_id = $1 AND action = 'track_in_transit'`, [o.shipment])).rows[0].n).toBe(1);
    expect((await shipmentRow(o.shipment)).status).toBe('in_transit');
    const r = await boss.post(`${F}/shipments/${o.shipment}/tracking`, { status: 'returned', note: 'Endereço não encontrado', requestKey: key() });
    expect(r.json().result).toBe('recorded');
    expect((await shipmentRow(o.shipment)).status).toBe('in_transit');
    const ship = await loggedAs(app, 'shipping');
    expect((await ship.post(`${F}/shipments/${o.shipment}/tracking`, { status: 'out_for_delivery', requestKey: key() })).statusCode).toBe(200);
    const pick = await deliveryOrder({ pickup: true });
    expect((await boss.post(`${F}/shipments/${pick.shipment}/tracking`, { status: 'in_transit', requestKey: key() })).json().error.code).toBe('NOT_CARRIER_SHIPMENT');
  });
});

describe('custos e relatório', () => {
  it('cobrado, cotado e pago separados; desconhecido não vira zero; ajuste e estorno', async () => {
    const a = await deliveryOrder();
    await authorize(a.orderId);
    await quote(a.shipment);
    await select(a.shipment);
    await dispatch(a.shipment, { carrier: 'Transportadora simulada', trackingCode: 'AAA1', freightCostCents: 3100 });
    const b = await deliveryOrder();
    await authorize(b.orderId);
    await dispatch(b.shipment, { carrier: 'Outra', trackingCode: 'BBB1' });

    const dup = await boss.post(`${F}/shipments/${a.shipment}/costs`, { kind: 'manual', amountCents: 100, requestKey: key() });
    expect(dup.json().error.code).toBe('COST_EXISTS');
    expect((await boss.post(`${F}/shipments/${a.shipment}/costs`, { kind: 'adjustment', amountCents: 250, requestKey: key() })).statusCode).toBe(400); // sem motivo
    const k = key();
    for (let i = 0; i < 2; i++) expect((await boss.post(`${F}/shipments/${a.shipment}/costs`, { kind: 'adjustment', amountCents: 250, note: 'Peso cubado', requestKey: k })).statusCode).toBe(200);
    expect((await boss.post(`${F}/shipments/${a.shipment}/costs`, { kind: 'refund', amountCents: 100, note: 'Crédito da transportadora', requestKey: key() })).statusCode).toBe(200);
    expect(await costs(a.shipment)).toEqual([
      { kind: 'manual', amount_cents: 3100, label_id: null },
      { kind: 'adjustment', amount_cents: 250, label_id: null },
      { kind: 'refund', amount_cents: -100, label_id: null },
    ]);
    const fa = await view(a.shipment);
    expect(fa.costs).toMatchObject({ paidCents: 3350, refundedCents: -100, netCents: 3250 });
    expect((await view(b.shipment)).costs).toMatchObject({ paidCents: null, netCents: null });

    const rep = (await boss.get(`${F}/report`)).json().report;
    const ra = rep.items.find((i: any) => i.shipmentId === a.shipment);
    const rb = rep.items.find((i: any) => i.shipmentId === b.shipment);
    expect(ra).toMatchObject({ chargedCents: a.freight, quotedCents: 2550, paidCents: 3350, refundedCents: -100, netCents: 3250, diffCents: a.freight - 3250 });
    expect(rb).toMatchObject({ chargedCents: b.freight, quotedCents: null, paidCents: null, netCents: null, diffCents: null });
    expect(rep.totals.unknownShipments).toBeGreaterThanOrEqual(1);
    expect(rep.totals.netCents).not.toBe(0);
    const g = rep.byCarrier.find((x: any) => x.carrier === 'Outra');
    expect(g).toMatchObject({ unknown: 1, diffCents: null });
    // Custo e imutavel.
    expect(await pgError(owner.query(`UPDATE shipment_freight_costs SET amount_cents = 1 WHERE shipment_id = $1`, [a.shipment]))).toBeTruthy();
    expect((await boss.get(`${F}/shipments?view=without_cost`)).json().items.some((i: any) => i.id === b.shipment)).toBe(true);
  });

  it('todos os cards e abas da tela Fretes respondem, inclusive em cliques seguidos (com e sem remessa em transporte)', async () => {
    const views = ['to_quote', 'quoted', 'labels', 'stale', 'without_cost', 'tracking'];
    const check = async () => {
      const all = await Promise.all([
        ...views.map((v) => boss.get(`${F}/shipments?view=${v}&pageSize=50`)),
        ...['open', 'dead', 'done', 'all'].map((st) => boss.get(`${F}/jobs?status=${st}&pageSize=30`)),
        boss.get(`${F}/overview`),
        boss.get(`${F}/report`),
        boss.get(`${F}/settings`),
      ]);
      for (const r of all) expect(r.statusCode, r.body).toBe(200);
      return all;
    };
    await check();
    const o = await ready();
    await boss.post(`${SH}/${o.shipment}/dispatch`, { version: (await boss.get(`${SH}/${o.shipment}`)).json().shipment.version, carrier: 'Outra', requestKey: key() });
    const [, , , , , tracking] = await check();
    expect(tracking!.json().items.some((i: any) => i.id === o.shipment)).toBe(true);
    for (let i = 0; i < 3; i++) await check();
  });
});

describe('Melhor Envio (contrato pelos exemplos da documentação oficial)', () => {
  it('rastreio: corpo {orders}, eventos pelas datas, chave estável por situação; datas sem fuso lidas em Brasília', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, body: init.body ?? '' });
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            'a1b2c3d4-0000-0000-0000-000000000001': { id: 'a1b2c3d4-0000-0000-0000-000000000001', status: 'posted', tracking: 'ME23002OWZ7BR', posted_at: '2023-04-14 20:32:15', delivered_at: null, canceled_at: null },
          }),
      };
    };
    const me = new MelhorEnvioProvider({ token: 'x'.repeat(30), userAgent: 'Loja (teste@loja.test)', sandbox: true, webhookSecret: 'segredo-do-app-melhor-envio' }, fetcher);
    const out = await me.track(['a1b2c3d4-0000-0000-0000-000000000001']);
    expect(calls[0]!.url).toBe('https://sandbox.melhorenvio.com.br/api/v2/me/shipment/tracking');
    expect(JSON.parse(calls[0]!.body)).toEqual({ orders: ['a1b2c3d4-0000-0000-0000-000000000001'] });
    const ev = out.get('a1b2c3d4-0000-0000-0000-000000000001')!;
    expect(ev).toEqual([{ status: 'posted', at: new Date('2023-04-14T23:32:15.000Z'), key: 'me:posted', tracking: 'ME23002OWZ7BR' }]);
    expect(meDate('2024-03-29T23:49:26+00:00')!.toISOString()).toBe('2024-03-29T23:49:26.000Z');
    // Aviso: X-ME-Signature = HMAC-SHA256 do corpo com o segredo do aplicativo (base64).
    const raw = JSON.stringify({ event: 'order.delivered', data: { id: 'a1', status: 'delivered', tracking: 'ME1', posted_at: '2024-03-28T10:00:00+00:00', delivered_at: '2024-03-29T23:49:26+00:00' } });
    const sig = createHmac('sha256', 'segredo-do-app-melhor-envio').update(raw).digest('base64');
    expect(me.verifyWebhook(raw, { 'x-me-signature': sig })).toBe(true);
    expect(me.verifyWebhook(raw + ' ', { 'x-me-signature': sig })).toBe(false);
    expect(me.verifyWebhook(raw, {})).toBe(false);
    const p = me.parseWebhook(JSON.parse(raw))!;
    expect(p.events.map((e) => e.key)).toEqual(['me:posted', 'me:delivered']);
    // Sem segredo configurado: nenhum aviso aceito.
    expect(new MelhorEnvioProvider({ token: 'x'.repeat(30), userAgent: 'Loja (teste@loja.test)', sandbox: true }).verifyWebhook(raw, { 'x-me-signature': sig })).toBe(false);
  });
});

describe('segurança, compatibilidade e migração', () => {
  it('erros guardados sem dados pessoais nem token', () => {
    expect(safeError('Bearer abc.def.ghi falhou para maria@teste.local, CPF 529.982.247-25, fone (47) 99999-0000, CEP 89460-000')).toBe(
      'Bearer [oculto] falhou para [e-mail], CPF [numero], fone [numero], CEP [numero]',
    );
    expect(safeError('x'.repeat(900))).toHaveLength(500);
  });

  it('remessas antigas e de retirada seguem iguais; a conciliação C1-C13 não acusa divergência', async () => {
    const pick = await deliveryOrder({ pickup: true });
    await authorize(pick.orderId);
    const d = await dispatch(pick.shipment);
    expect(d.status).toBe('delivered');
    expect((await shipmentRow(pick.shipment)).carrier_provider).toBeNull();
    expect(await costs(pick.shipment)).toEqual([]);
    const f = await view(pick.shipment);
    expect(f.quotes).toEqual([]);
    const rows = (await appRole.query('SELECT check_code, field, expected, found FROM stock_reconcile()')).rows.filter((r) => r.check_code !== 'run');
    expect(rows).toEqual([]);
  });

  it('pedido de marketplace (inclusive despacho anterior) fica fora do frete da loja: listas, relatório, painel, custo e rastreio', async () => {
    const o = await ready();
    await dispatch(o.shipment);
    // Simula o pedido antigo da Shopee: remessa do despacho anterior, canal do marketplace.
    await owner.query(`UPDATE orders SET channel = 'shopee' WHERE id = $1`, [o.orderId]);
    await owner.query(`UPDATE shipments SET kind = 'legacy' WHERE id = $1`, [o.shipment]);
    await owner.query(`UPDATE shipments SET shipped_at = now() - interval '10 days' WHERE id = $1`, [o.shipment]);
    expect((await view(o.shipment)).shipment.storeCarrier).toBe(false);
    for (const v of ['stale', 'without_cost', 'tracking']) {
      const r = await boss.get(`${F}/shipments?view=${v}&pageSize=100`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().items.some((i: any) => i.id === o.shipment), v).toBe(false);
    }
    expect((await boss.get(`${F}/report`)).json().report.items.some((i: any) => i.shipmentId === o.shipment)).toBe(false);
    const cost = await boss.post(`${F}/shipments/${o.shipment}/costs`, { kind: 'manual', amountCents: 1000, requestKey: key() });
    expect(cost.json().error.code).toBe('NOT_CARRIER_SHIPMENT');
    const track = await boss.post(`${F}/shipments/${o.shipment}/tracking`, { status: 'in_transit', requestKey: key() });
    expect(track.json().error.code).toBe('NOT_CARRIER_SHIPMENT');
    expect(await costs(o.shipment)).toEqual([]);
    // O mesmo despacho anterior, de pedido da loja, continua com frete da loja.
    await owner.query(`UPDATE orders SET channel = 'store' WHERE id = $1`, [o.orderId]);
    expect((await view(o.shipment)).shipment.storeCarrier).toBe(true);
    expect((await boss.get(`${F}/shipments?view=stale&pageSize=100`)).json().items.some((i: any) => i.id === o.shipment)).toBe(true);
    const ok = await boss.post(`${F}/shipments/${o.shipment}/costs`, { kind: 'manual', amountCents: 1000, requestKey: key() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await view(o.shipment)).costs.netCents).toBe(1000);
    // Rastreio manual no despacho anterior da loja: fica no historico, a situacao segue o pedido e sai do "parado".
    const t = await boss.post(`${F}/shipments/${o.shipment}/tracking`, { status: 'out_for_delivery', requestKey: key() });
    expect(t.statusCode, t.body).toBe(200);
    expect((await shipmentRow(o.shipment)).status).toBe('shipped');
    const ev = (await view(o.shipment)).tracking.events.find((e: any) => e.action === 'track_out_for_delivery');
    expect(ev.note).toMatch(/despacho anterior/);
    expect((await boss.get(`${F}/shipments?view=stale&pageSize=100`)).json().items.some((i: any) => i.id === o.shipment)).toBe(false);
  });

  it('despacho anterior: a expedição recusa marcar entregue (a tela esconde o botão); a entrega vem pelo pedido', async () => {
    const o = await ready();
    await dispatch(o.shipment);
    await owner.query(`UPDATE shipments SET kind = 'legacy' WHERE id = $1`, [o.shipment]);
    const s = (await boss.get(`${SH}/${o.shipment}`)).json().shipment;
    expect(s.kind).toBe('legacy');
    const r = await boss.post(`${SH}/${o.shipment}/deliver`, { version: s.version, requestKey: key() });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('LEGACY_SHIPMENT');
    expect((await shipmentRow(o.shipment)).status).toBe('shipped');
    const order = (await boss.get(`/api/v1/admin/orders/${o.orderId}`)).json().order;
    expect(order.status).toBe('shipped');
    const d = await boss.post(`/api/v1/admin/orders/${o.orderId}/deliver`, { version: order.version });
    expect(d.statusCode, d.body).toBe(200);
    expect((await shipmentRow(o.shipment)).status).toBe('delivered');
  });

  it('a aplicação não altera cotação, log nem histórico da etiqueta (imutáveis)', async () => {
    expect((await pgError(appRole.query('DELETE FROM integration_logs'))).message).toMatch(/permission denied|imutavel|imutável/i);
    expect((await pgError(appRole.query('UPDATE shipping_label_events SET note = NULL'))).message).toMatch(/permission denied/);
  });

  it('a reversão da 0027 recusa depois do uso (nada muda)', async () => {
    const down = readFileSync(new URL('../migrations/0027_sglog_frete.down.sql', import.meta.url), 'utf8');
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      const e = await pgError(c.query(down));
      expect(e.message).toMatch(/Reversao da 0027 recusada/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'shipping_labels'`)).rows[0].n).toBe(1);
  });
});
