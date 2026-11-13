/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { expireOrders } from '../src/modules/orders.js';
import { appRole, client, loggedAs, makeApp, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
let seller: Awaited<ReturnType<typeof loggedAs>>;
let pickupId: string;
let deliveryId: string;

type Pack = { id: string; label: string };
async function newProduct(stock: string, extra: Record<string, unknown> = {}) {
  const sku = `ORC-${uid()}`.toUpperCase();
  const res = await boss.post(
    '/api/v1/admin/products',
    productPayload({
      ...extra,
      variants: [
        {
          sku,
          weightG: 4,
          packagings: [
            { kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 25 },
            { kind: 'sale', label: 'Pacote com 50', unitCode: 'PCT', baseQty: '50', priceCents: 1000, isDefault: true, tiers: [{ minPacks: 10, priceCents: 900 }] },
          ],
        },
      ],
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  const p = res.json().product;
  const v = p.variants[0];
  if (stock !== '0') {
    const m = await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: stock, reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
    expect(m.statusCode, m.body).toBe(201);
  }
  const packs = v.packagings as Pack[];
  return { product: p, sku, variantId: v.id as string, pack50: packs.find((k) => k.label === 'Pacote com 50')!, unit: packs.find((k) => k.label === 'Unidade')! };
}

const buyer = { kind: 'pf', name: 'Joana Doceira', phone: '(47) 99999-1234' };
const quoteBody = (items: { packagingId: string; packs: number }[], extra: Record<string, unknown> = {}) => ({ requestKey: `orc-${uid()}`, buyer, items, shippingOptionId: pickupId, ...extra });
const reserved = async (variantId: string) => (await owner.query('SELECT coalesce(sum(qty), 0)::text AS q FROM stock_reservations WHERE variant_id = $1 AND status = $2', [variantId, 'active'])).rows[0].q;

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider());
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  seller = await loggedAs(app, 'sales');
  pickupId = (await boss.post('/api/v1/admin/shipping-options', { name: 'Retirada na loja', kind: 'pickup', baseCents: 0, minDays: 0, maxDays: 1 })).json().option.id;
  deliveryId = (
    await boss.post('/api/v1/admin/shipping-options', { name: 'Entrega Canoinhas', kind: 'delivery', cepRanges: ['89460-000-89479-999'], baseCents: 1500, perKgCents: 0, minDays: 1, maxDays: 2 })
  ).json().option.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('busca rápida do balcão', () => {
  it('acha por nome, SKU e código de barras, com preço, faixas e saldo em embalagens', async () => {
    const { sku, product, pack50 } = await newProduct('1000');
    await owner.query('UPDATE packagings SET barcode = $2 WHERE id = $1', [pack50.id, '7890000000017']);
    const bySku = (await seller.get(`/api/v1/admin/sales-desk/search?q=${sku.toLowerCase()}`)).json();
    const row = bySku.results.find((r: any) => r.packaging_id === pack50.id);
    expect(row).toMatchObject({ sku, price_cents: '1000', packs_available: 20, tiers: [{ minPacks: 10, priceCents: 900 }] });
    expect(bySku.storeUrl).toBeTruthy();
    expect((await seller.get(`/api/v1/admin/sales-desk/search?q=${encodeURIComponent(product.name)}`)).json().results.length).toBeGreaterThan(0);
    expect((await seller.get('/api/v1/admin/sales-desk/search?q=7890000000017')).json().results[0].packaging_id).toBe(pack50.id);
    // Curinga do LIKE e tratado como texto.
    expect((await seller.get('/api/v1/admin/sales-desk/search?q=%25')).json().results).toEqual([]);
    const stock = await loggedAs(app, 'stock');
    expect((await stock.get('/api/v1/admin/sales-desk/search?q=a')).statusCode).toBe(403);
  });
});

describe('orçamento', () => {
  it('congela o preço do banco, repete sem duplicar e só gerente com MFA dá desconto', async () => {
    const { pack50, unit } = await newProduct('1000');
    const body = quoteBody([
      { packagingId: pack50.id, packs: 10 },
      { packagingId: unit.id, packs: 4 },
    ]);
    const r = await seller.post('/api/v1/admin/sales-desk/quotes', body);
    expect(r.statusCode, r.body).toBe(201);
    const q = r.json().quote;
    expect(q).toMatchObject({ status: 'open', subtotal_cents: '9100', total_cents: '9100', expired: false, missing: ['email', 'document'] });
    expect(q.items.map((i: any) => i.unit_price_cents)).toEqual(['900', '25']);
    expect(q.buyer.phone).toBe('47999991234');
    const again = await seller.post('/api/v1/admin/sales-desk/quotes', body);
    expect(again.statusCode).toBe(200);
    expect(again.json().quote.id).toBe(q.id);

    expect((await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 1 }], { discountCents: 5 }))).statusCode).toBe(403);
    expect((await boss.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 4 }], { discountCents: 100 }))).json().error.code).toBe('DISCOUNT_TOO_HIGH');
    const disc = await boss.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 4 }], { discountCents: 10 }));
    expect(disc.json().quote).toMatchObject({ subtotal_cents: '100', discount_cents: '10', total_cents: '90' });
  });

  it('recusa item fora de venda, documento inválido e entrega sem endereço', async () => {
    const { pack50, product } = await newProduct('0');
    await owner.query(`UPDATE products SET status = 'draft' WHERE id = $1`, [product.id]);
    expect((await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: pack50.id, packs: 1 }]))).json().error.code).toBe('ITEM_UNAVAILABLE');
    const ok = await newProduct('100');
    const items = [{ packagingId: ok.unit.id, packs: 1 }];
    expect((await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody(items, { buyer: { ...buyer, document: '111.111.111-11' } }))).json().error.code).toBe('INVALID_DOCUMENT');
    expect((await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody(items, { shippingOptionId: deliveryId }))).json().error.code).toBe('ADDRESS_REQUIRED');
    const address = { recipient: 'Joana', cep: '89460-000', street: 'Rua A', number: '10', district: 'Centro', city: 'Canoinhas', uf: 'sc' };
    const d = await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody(items, { shippingOptionId: deliveryId, address }));
    expect(d.json().quote).toMatchObject({ freight_cents: '1500', total_cents: '1525' });
  });

  it('link público mostra o orçamento sem os dados de contato do cliente', async () => {
    const { unit } = await newProduct('100');
    const q = (await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 2 }], { buyer: { ...buyer, email: 'joana@teste.local' } }))).json().quote;
    const visitor = client(app);
    const pub = (await visitor.get(`/api/v1/public/quotes/${q.token}`)).json().quote;
    expect(pub).toMatchObject({ number: q.number, buyerName: 'Joana Doceira', missing: ['document'], totalCents: '50', orderToken: null });
    expect(JSON.stringify(pub)).not.toMatch(/47999991234|joana@teste/);
    expect((await visitor.get(`/api/v1/public/quotes/${'x'.repeat(43)}`)).statusCode).toBe(404);
  });
});

describe('orçamento → pedido sem redigitar', () => {
  it('converte com o preço do orçamento, reserva o estoque e não duplica', async () => {
    const { pack50, variantId } = await newProduct('1000');
    const q = (await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: pack50.id, packs: 10 }]))).json().quote;
    // Preco subiu depois do orcamento: vale o do orcamento ate a validade.
    await owner.query('UPDATE price_tiers SET price_cents = 950 WHERE packaging_id = $1', [pack50.id]);

    const url = `/api/v1/admin/sales-desk/quotes/${q.id}/convert`;
    expect((await seller.post(url, { paymentMethod: 'pix' })).json().error.code).toBe('BUYER_INCOMPLETE');
    const conv = await seller.post(url, { paymentMethod: 'pix', buyer: { email: 'Joana@Teste.local', document: '529.982.247-25' } });
    expect(conv.statusCode, conv.body).toBe(201);
    const { order, orderToken } = conv.json();
    expect(order).toMatchObject({ channel: 'sales_desk', status: 'pending_payment', subtotal_cents: '9000', total_cents: '9000', payment_method: 'pix' });
    expect(order.buyer).toMatchObject({ name: 'Joana Doceira', email: 'joana@teste.local', document: '52998224725', phone: '47999991234' });
    expect(order.items[0]).toMatchObject({ unit_price_cents: '900', packs: 10 });
    expect(order.events[0].note).toMatch(`orçamento Nº ${q.number}`);
    expect(await reserved(variantId)).toBe('500.000');

    // Clique duplo, outro atendente ou o cliente pelo link: o mesmo pedido.
    const again = await seller.post(url, { paymentMethod: 'card' });
    expect(again.statusCode).toBe(200);
    expect(again.json().order.id).toBe(order.id);
    const accepted = await client(app).post(`/api/v1/public/quotes/${q.token}/accept`, { paymentMethod: 'pix' });
    expect(accepted.json()).toMatchObject({ orderToken, replay: true });
    expect((await client(app).get(`/api/v1/public/orders/${orderToken}`)).json().order.number).toBe(order.number);
    expect(await reserved(variantId)).toBe('500.000');
    const view = (await seller.get(`/api/v1/admin/sales-desk/quotes/${q.id}`)).json().quote;
    expect(view).toMatchObject({ status: 'converted', order_id: order.id, conversions: 1 });

    // Pedido cancelado por falta de pagamento: o orcamento valido gera outro pedido.
    await owner.query(`UPDATE orders SET payment_due_at = now() - interval '1 hour' WHERE id = $1`, [order.id]);
    await expireOrders(null);
    expect(Number(await reserved(variantId))).toBe(0);
    const second = await client(app).post(`/api/v1/public/quotes/${q.token}/accept`, { paymentMethod: 'card' });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().orderToken).not.toBe(orderToken);
    expect((await seller.get(`/api/v1/admin/sales-desk/quotes/${q.id}`)).json().quote.conversions).toBe(2);
  });

  it('cliente aceita pelo link completando só o que falta, com entrega escolhida na hora', async () => {
    const { unit } = await newProduct('100');
    const q = (await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 4 }], { shippingOptionId: null }))).json().quote;
    const visitor = client(app);
    const url = `/api/v1/public/quotes/${q.token}/accept`;
    expect((await visitor.post(url, { paymentMethod: 'pix', buyer: { email: 'j@teste.local', document: '52998224725' } })).json().error.code).toBe('SHIPPING_REQUIRED');
    const r = await visitor.post(url, { paymentMethod: 'pix', buyer: { email: 'j@teste.local', document: '52998224725' }, shippingOptionId: pickupId });
    expect(r.statusCode, r.body).toBe(201);
    const order = (await visitor.get(`/api/v1/public/orders/${r.json().orderToken}`)).json().order;
    expect(order).toMatchObject({ channel: 'sales_desk', total_cents: '100' });
  });

  it('não converte orçamento vencido, cancelado ou com item sem estoque', async () => {
    const { unit, variantId } = await newProduct('10');
    const mk = async () => (await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 5 }], { buyer: { ...buyer, email: 'x@teste.local', document: '52998224725' } }))).json().quote;
    const expired = await mk();
    await owner.query(`UPDATE quotes SET valid_until = current_date - 2 WHERE id = $1`, [expired.id]);
    expect((await seller.post(`/api/v1/admin/sales-desk/quotes/${expired.id}/convert`, { paymentMethod: 'pix' })).json().error.code).toBe('QUOTE_EXPIRED');
    expect((await seller.get('/api/v1/admin/sales-desk/quotes?status=expired')).json().items.map((i: any) => i.id)).toContain(expired.id);

    // Copia com preco atual resolve o vencido.
    const copy = await seller.post(`/api/v1/admin/sales-desk/quotes/${expired.id}/duplicate`, { requestKey: `dup-${uid()}` });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().quote).toMatchObject({ status: 'open', expired: false, total_cents: '125' });

    const canceled = await mk();
    expect((await seller.post(`/api/v1/admin/sales-desk/quotes/${canceled.id}/cancel`, { reason: 'Cliente desistiu' })).statusCode).toBe(200);
    expect((await seller.post(`/api/v1/admin/sales-desk/quotes/${canceled.id}/convert`, { paymentMethod: 'pix' })).json().error.code).toBe('QUOTE_CANCELED');

    const short = await mk();
    const m = await boss.post('/api/v1/admin/stock/movements', { variantId, kind: 'adjustment', qty: '-8', reason: 'Quebra', requestKey: `k-${uid()}-${uid()}` });
    expect(m.statusCode, m.body).toBe(201);
    const blocked = (await seller.post(`/api/v1/admin/sales-desk/quotes/${short.id}/convert`, { paymentMethod: 'pix' })).json();
    expect(blocked.error.code).toBe('QUOTE_BLOCKED');
  });

  it('itens e eventos do orçamento não podem ser alterados nem apagados', async () => {
    const { unit } = await newProduct('100');
    const q = (await seller.post('/api/v1/admin/sales-desk/quotes', quoteBody([{ packagingId: unit.id, packs: 1 }]))).json().quote;
    await expect(appRole.query('UPDATE quote_items SET unit_price_cents = 1 WHERE quote_id = $1', [q.id])).rejects.toThrow();
    await expect(appRole.query('UPDATE quotes SET total_cents = 1 WHERE id = $1', [q.id])).rejects.toThrow(/permission denied/);
    await expect(appRole.query('DELETE FROM quotes WHERE id = $1', [q.id])).rejects.toThrow(/permission denied/);
    const shared = await seller.post(`/api/v1/admin/sales-desk/quotes/${q.id}/shared`, { channel: 'whatsapp' });
    expect(shared.json().quote.events.map((e: any) => e.kind)).toEqual(['created', 'shared']);
  });
});
