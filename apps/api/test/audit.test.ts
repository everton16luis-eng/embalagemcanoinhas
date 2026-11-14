/* eslint-disable @typescript-eslint/no-explicit-any */
// Auditoria (13/11/2026): concorrencia comercial e entradas maliciosas. Complementa security.test.ts e store.test.ts.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { appRole, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
let pickupId: string;

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider());
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  pickupId = (await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada', kind: 'pickup', baseCents: 0, minDays: 0, maxDays: 1 })).json().option.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

function shopper() {
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const c of res.cookies) {
      if (c.value) jar[c.name] = c.value;
      else delete jar[c.name];
    }
    return res;
  };
  return { jar, send, get: (u: string) => send('GET', u), post: (u: string, b: unknown = {}) => send('POST', u, b), put: (u: string, b: unknown) => send('PUT', u, b) };
}

async function product(stock: string) {
  const p = (await boss.post('/api/v1/admin/products', productPayload())).json().product;
  const v = p.variants[0];
  if (stock !== '0') await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: `k-${uid()}` });
  return { p, variantId: v.id as string, unit: v.packagings.find((k: any) => k.label === 'Unidade') };
}
const balance = async (variantId: string) => (await boss.get(`/api/v1/admin/stock/variants/${variantId}`)).json().variant;
const buyer = { kind: 'pf', name: 'Cliente Teste', email: 'cliente@teste.local', phone: '47999990000', document: '529.982.247-25' };
const checkoutBody = async (s: ReturnType<typeof shopper>) => ({
  requestKey: `pedido-${uid()}`,
  buyer,
  shippingOptionId: pickupId,
  paymentMethod: 'pix',
  expectedTotalCents: (await s.get('/api/v1/public/cart')).json().cart.subtotalCents,
});

describe('integridade comercial sob concorrência', () => {
  it('última unidade: de 8 clientes ao mesmo tempo, só um compra e o estoque nunca fica negativo', async () => {
    const { variantId, unit } = await product('1');
    const shoppers = Array.from({ length: 8 }, shopper);
    for (const s of shoppers) expect((await s.post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 1 })).statusCode).toBe(200);
    const bodies = await Promise.all(shoppers.map(checkoutBody));
    const results = await Promise.all(shoppers.map((s, i) => s.post('/api/v1/public/checkout', bodies[i])));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    const b = await balance(variantId);
    expect([b.on_hand, b.reserved]).toEqual(['1.000', '1.000']);
  });

  it('o mesmo checkout disparado 6 vezes ao mesmo tempo cria um pedido só', async () => {
    const { variantId, unit } = await product('50');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 2 });
    const body = await checkoutBody(s);
    const results = await Promise.all(Array.from({ length: 6 }, () => s.post('/api/v1/public/checkout', body)));
    expect(results.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    const ids = new Set(results.filter((r) => r.statusCode < 300).map((r) => r.json().order.id));
    expect(ids.size).toBe(1);
    const orders = (await owner.query('SELECT count(*)::int AS n FROM orders WHERE request_key = $1', [body.requestKey])).rows[0].n;
    expect(orders).toBe(1);
    expect((await balance(variantId)).reserved).toBe('2.000');
  });

  it('ajustes de estoque simultâneos somam certo e o livro bate com o saldo', async () => {
    const { variantId } = await product('0');
    const res = await Promise.all(Array.from({ length: 20 }, () => boss.post('/api/v1/admin/stock/movements', { variantId, kind: 'adjustment', qty: '5', reason: 'Entrada concorrente', requestKey: `k-${uid()}` })));
    expect(res.map((r) => `${r.statusCode} ${r.statusCode === 201 ? "" : r.body}`).filter((x) => !x.startsWith("201"))).toEqual([]);
    expect((await balance(variantId)).on_hand).toBe('100.000');
    const ledger = (await owner.query('SELECT sum(on_hand_delta)::numeric(14,3)::text AS s FROM stock_movements WHERE variant_id = $1', [variantId])).rows[0].s;
    expect(ledger).toBe('100.000');
  });

  it('preço muda com o cliente no carrinho: o checkout pede confirmação do novo total', async () => {
    const { p, unit } = await product('10');
    const s = shopper();
    await s.post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 1 });
    const body = await checkoutBody(s);
    const full = (await boss.get(`/api/v1/admin/products/${p.id}`)).json().product;
    full.variants[0].packagings.find((k: any) => k.id === unit.id).price_cents = String(Number(unit.price_cents) + 100);
    await owner.query('UPDATE packagings SET price_cents = price_cents + 100 WHERE id = $1', [unit.id]);
    const r = await s.post('/api/v1/public/checkout', body);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('PRICE_CHANGED');
  });
});

describe('entradas maliciosas', () => {
  const sqli = ["' OR '1'='1", "'; DROP TABLE products; --", '%\' UNION SELECT password_hash FROM users --', '\\', '%%%%', '_'.repeat(200)];

  it('busca e filtros públicos tratam injeção de SQL como texto', async () => {
    for (const q of sqli) {
      const r = await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products?q=${encodeURIComponent(q)}` });
      expect(r.statusCode, q).toBeLessThan(500);
      expect(r.body).not.toMatch(/argon2|password_hash/);
    }
    for (const sort of ['name; DROP TABLE x', 'price_asc,(select 1)']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products?sort=${encodeURIComponent(sort)}` })).statusCode).toBe(400);
    }
    expect((await owner.query("SELECT to_regclass('public.products') IS NOT NULL AS ok")).rows[0].ok).toBe(true);
  });

  it('imagens: caminho com ../ ou chave fora do padrão não lê arquivo', async () => {
    for (const url of ['/api/v1/public/images/..%2F..%2F.env/320.webp', '/api/v1/public/images/../../package.json', '/api/v1/public/images/00000000-0000-0000-0000-000000000000/..%2F..%2Fx.webp', '/api/v1/public/images/00000000-0000-0000-0000-000000000000/999.webp']) {
      const r = await app.inject({ method: 'GET', url });
      expect([400, 404], url).toContain(r.statusCode);
      expect(r.body).not.toMatch(/DB_|ENC_KEY|"name":/);
    }
  });

  it('campos extras no corpo são recusados (mass assignment)', async () => {
    const s = shopper();
    const { unit } = await product('5');
    const r = await s.post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 1, priceCents: 1 });
    expect(r.statusCode).toBe(400);
    const reg = await s.post('/api/v1/customer/register', { kind: 'pf', name: 'X', email: `x-${uid()}@teste.local`, phone: '47999990000', password: 'Senha-segura-9', role: 'owner' });
    expect(reg.statusCode).toBe(400);
    const me = await loggedAs(app, 'sales');
    expect((await me.put('/api/v1/auth/me', { role: 'owner' })).statusCode).not.toBe(200);
  });

  it('texto com HTML/script é guardado como texto e devolvido em JSON (o React escapa ao mostrar)', async () => {
    const r = await boss.post('/api/v1/admin/products', productPayload({ name: `<img src=x onerror=alert(1)> ${uid()}`, status: 'active' }));
    expect(r.statusCode, r.body).toBe(201);
    const pub = await app.inject({ method: 'GET', url: `/api/v1/public/catalog/products/${r.json().product.slug}` });
    expect(pub.headers['content-type']).toMatch(/application\/json/);
    expect(pub.json().product.name).toContain('<img src=x onerror=alert(1)>');
  });

  it('login do cliente bloqueia depois de várias senhas erradas', async () => {
    const s = shopper();
    const email = `bf-${uid()}@teste.local`;
    await s.post('/api/v1/customer/register', { kind: 'pf', name: 'Alvo', email, phone: '47999990000', password: 'Senha-segura-1' });
    await s.post('/api/v1/customer/logout');
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await shopper().post('/api/v1/customer/login', { email, password: `errada-${i}-xxxx` })).statusCode);
    expect(codes).toContain(429);
    expect((await shopper().post('/api/v1/customer/login', { email, password: 'Senha-segura-1' })).statusCode).toBe(429);
  });

  it('pedido público só abre com o token longo; id do pedido não serve', async () => {
    const s = shopper();
    const { unit } = await product('5');
    await s.post('/api/v1/public/cart/items', { packagingId: unit.id, packs: 1 });
    const order = (await s.post('/api/v1/public/checkout', await checkoutBody(s))).json().order;
    expect(order.token.length).toBeGreaterThanOrEqual(40);
    expect([400, 404]).toContain((await app.inject({ method: 'GET', url: `/api/v1/public/orders/${order.id}` })).statusCode);
    expect([400, 404]).toContain((await app.inject({ method: 'GET', url: `/api/v1/public/orders/${String(order.number)}` })).statusCode);
    // Outro navegador nao ve nem mexe no carrinho alheio sem o cookie.
    expect((await shopper().get('/api/v1/public/cart')).json().cart.items).toEqual([]);
  });

  it('requisição que altera dados vinda de outro site é recusada', async () => {
    const s = shopper();
    await s.get('/api/v1/public/cart');
    const r = await app.inject({ method: 'POST', url: '/api/v1/public/cart/items', headers: { origin: 'https://site-malicioso.example' }, cookies: s.jar, payload: { packagingId: uid(), packs: 1 } });
    expect(r.statusCode).toBe(403);
  });
});
