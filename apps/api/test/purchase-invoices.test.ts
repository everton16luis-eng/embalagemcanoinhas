/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { accessKeyValid, parsePurchaseNfe } from '../src/lib/nfe-xml.js';
import { appRole, loggedAs, makeApp, owner, productPayload, resetCatalog, uid } from './helpers.js';

// Dados ficticios de teste: CNPJ valido de exemplo, produtos e valores inventados so para o teste.
const SUPPLIER_DOC = '11222333000181';
const GTIN = '7891000315507';

/** Chave de 44 digitos com o digito verificador calculado (modulo 11). */
function makeKey(seed: string) {
  const base = `4226111122233300018155001${seed.padStart(9, '0')}1${'0'.repeat(8)}`.slice(0, 43);
  let sum = 0;
  let w = 2;
  for (let i = 42; i >= 0; i -= 1) {
    sum += Number(base[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const r = sum % 11;
  return `${base}${r < 2 ? 0 : 11 - r}`;
}

function nfeXml(o: { key: string; model?: string; items: { code: string; ean?: string; name: string; qty: string; unit: string; price: string }[]; withProtocol?: boolean }) {
  const det = o.items
    .map(
      (it, i) => `<det nItem="${i + 1}"><prod><cProd>${it.code}</cProd><cEAN>${it.ean ?? 'SEM GTIN'}</cEAN><xProd>${it.name}</xProd><NCM>48195000</NCM><CFOP>5102</CFOP>
<uCom>${it.unit}</uCom><qCom>${it.qty}</qCom><vUnCom>${it.price}</vUnCom><vProd>${(Number(it.qty) * Number(it.price)).toFixed(2)}</vProd></prod></det>`,
    )
    .join('');
  const total = o.items.reduce((s, it) => s + Number(it.qty) * Number(it.price), 0).toFixed(2);
  const nfe = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${o.key}" versao="4.00"><ide><mod>${o.model ?? '55'}</mod><serie>1</serie><nNF>${Number(o.key.slice(25, 34))}</nNF>
<dhEmi>2026-11-10T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${SUPPLIER_DOC}</CNPJ><xNome>Fornecedor de Teste &amp; Cia</xNome><enderEmit><UF>SC</UF></enderEmit><IE>123456789</IE></emit>
<dest><CNPJ>12ABC34501DE35</CNPJ></dest>${det}<total><ICMSTot><vNF>${total}</vNF></ICMSTot></total></infNFe></NFe>`;
  return o.withProtocol === false
    ? `<?xml version="1.0" encoding="UTF-8"?>${nfe}`
    : `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${nfe}<protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
}

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
let supplierId: string;
let otherSupplierId: string;
let packA: string;
let packB: string;

const upload = (c: typeof boss, xml: string) => {
  const boundary = `----teste${uid()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nota.xml"\r\nContent-Type: application/xml\r\n\r\n`),
    Buffer.from(xml),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return c.send('POST', '/api/v1/admin/purchase-invoices', body as never, { 'content-type': `multipart/form-data; boundary=${boundary}` });
};

async function purchasePack() {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  return res.json().product.variants[0].packagings.find((k: any) => k.kind === 'purchase').id as string;
}

beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  boss = await loggedAs(app, 'manager', { mfa: true });
  supplierId = (await owner.query(`INSERT INTO suppliers (name, document) VALUES ('Fornecedor de Teste', $1) RETURNING id`, [SUPPLIER_DOC])).rows[0].id;
  otherSupplierId = (await owner.query(`INSERT INTO suppliers (name) VALUES ('Outro fornecedor') RETURNING id`)).rows[0].id;
  packA = await purchasePack();
  packB = await purchasePack();
  await owner.query(`INSERT INTO supplier_products (supplier_id, packaging_id, supplier_sku, cost_cents) VALUES ($1, $2, 'F-100', 1500)`, [supplierId, packA]);
  await owner.query('UPDATE packagings SET barcode = $2 WHERE id = $1', [packB, GTIN]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('leitura do XML de compra', () => {
  it('confere a chave, recusa DOCTYPE e modelo diferente de 55', () => {
    const key = makeKey('77');
    expect(accessKeyValid(key)).toBe(true);
    expect(accessKeyValid(`${key.slice(0, 43)}${(Number(key[43]) + 1) % 10}`)).toBe(false);
    const nfe = parsePurchaseNfe(Buffer.from(nfeXml({ key, items: [{ code: 'F-100', name: 'Caixa', qty: '2.0000', unit: 'CX', price: '15.00' }] })));
    expect(nfe).toMatchObject({ accessKey: key, supplier: { document: SUPPLIER_DOC, name: 'Fornecedor de Teste & Cia' }, totalCents: 3000, protocolStatus: '100' });
    expect(nfe.items[0]).toMatchObject({ code: 'F-100', gtin: null, qty: '2.0000', unitValue: '15.00', totalCents: 3000 });
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><NFe><infNFe Id="NFe${key}"/></NFe>`;
    expect(() => parsePurchaseNfe(Buffer.from(evil))).toThrow(/DOCTYPE/);
    expect(() => parsePurchaseNfe(Buffer.from(nfeXml({ key, model: '65', items: [{ code: 'x', name: 'x', qty: '1', unit: 'UN', price: '1' }] })))).toThrow(/modelo 55/);
    expect(() => parsePurchaseNfe(Buffer.from('<html></html>'))).toThrow(/infNFe/);
  });
});

describe('importação e conferência', () => {
  it('importa uma vez, reconhece fornecedor e itens e aponta o que não tem cadastro', async () => {
    const key = makeKey('101');
    const xml = nfeXml({
      key,
      items: [
        { code: 'F-100', name: 'Caixa kraft', qty: '3', unit: 'CX', price: '15.00' },
        { code: 'Z-9', ean: GTIN, name: 'Forminha', qty: '2', unit: 'PCT', price: '8.00' },
        { code: 'Q-1', name: 'Item novo', qty: '1', unit: 'UN', price: '1.00' },
      ],
    });
    const r = await upload(boss, xml);
    expect(r.statusCode, r.body).toBe(201);
    const { invoice, conference } = r.json();
    expect(invoice).toMatchObject({ access_key: key, supplier_id: supplierId, total_cents: '6200', protocol_status: '100' });
    expect(conference.supplier.id).toBe(supplierId);
    expect(conference.items.map((i: any) => i.match?.by ?? null)).toEqual(['supplier_sku', 'gtin', null]);
    expect(conference.items[2].divergences[0]).toMatch(/Sem correspondência/);

    const again = await upload(boss, xml);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, invoice: { id: invoice.id } });

    const file = await boss.get(`/api/v1/admin/purchase-invoices/${invoice.id}/xml`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe(xml);
    // Importar nao movimenta estoque e a nota nao pode ser apagada.
    expect((await owner.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n).toBe(0);
    await expect(appRole.query('DELETE FROM purchase_invoices WHERE id = $1', [invoice.id])).rejects.toThrow(/permission denied/);
    await expect(appRole.query(`UPDATE purchase_invoices SET total_cents = 1 WHERE id = $1`, [invoice.id])).rejects.toThrow(/permission denied/);
  });

  it('vinculada ao pedido de compra, compara quantidade e preço item a item', async () => {
    const xml = nfeXml({
      key: makeKey('202'),
      items: [
        { code: 'F-100', name: 'Caixa kraft', qty: '4', unit: 'CX', price: '16.00' },
        { code: 'Z-9', ean: GTIN, name: 'Forminha', qty: '2', unit: 'PCT', price: '8.00' },
      ],
      withProtocol: false,
    });
    const inv = (await upload(boss, xml)).json();
    expect(inv.conference.warnings.join(' ')).toMatch(/protocolo/);
    const mkOrder = async (sup: string) => {
      const po = (await owner.query(`INSERT INTO purchase_orders (supplier_id, status, created_by) VALUES ($1, 'sent', $2) RETURNING id`, [sup, boss.user.id])).rows[0].id;
      return po as string;
    };
    const other = await mkOrder(otherSupplierId);
    expect((await boss.post(`/api/v1/admin/purchase-invoices/${inv.invoice.id}/link`, { purchaseOrderId: other })).json().error.code).toBe('SUPPLIER_MISMATCH');

    const po = await mkOrder(supplierId);
    const variantOf = async (pack: string) => (await owner.query('SELECT variant_id, label, base_qty FROM packagings WHERE id = $1', [pack])).rows[0];
    for (const [pack, packs, cost] of [
      [packA, '5', 1500],
      [packB, '2', 800],
    ] as const) {
      const k = await variantOf(pack);
      await owner.query(
        'INSERT INTO purchase_order_items (order_id, variant_id, packaging_id, packaging_label, base_qty_per_pack, packs, pack_cost_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [po, k.variant_id, pack, k.label, k.base_qty, packs, cost],
      );
    }
    const third = await purchasePack();
    const k3 = await variantOf(third);
    await owner.query('INSERT INTO purchase_order_items (order_id, variant_id, packaging_id, packaging_label, base_qty_per_pack, packs, pack_cost_cents) VALUES ($1, $2, $3, $4, $5, 1, 100)', [
      po,
      k3.variant_id,
      third,
      k3.label,
      k3.base_qty,
    ]);

    const linked = await boss.post(`/api/v1/admin/purchase-invoices/${inv.invoice.id}/link`, { purchaseOrderId: po });
    expect(linked.statusCode, linked.body).toBe(200);
    const c = linked.json().conference;
    expect(c.items[0].divergences).toEqual(['Quantidade: nota 4, pendente no pedido 5.', 'Preço: nota R$ 16.00, pedido R$ 15.00.']);
    expect(c.items[1].divergences).toEqual([]);
    expect(c.missingFromInvoice).toHaveLength(1);
    expect(c.ok).toBe(false);
    expect((await boss.get('/api/v1/admin/purchase-invoices')).json().invoices[0]).toMatchObject({ id: inv.invoice.id, item_count: 2 });
  });

  it('só quem gerencia compras importa', async () => {
    const sales = await loggedAs(app, 'sales');
    expect((await upload(sales, nfeXml({ key: makeKey('303'), items: [{ code: 'x', name: 'x', qty: '1', unit: 'UN', price: '1' }] }))).statusCode).toBe(403);
    const stock = await loggedAs(app, 'stock');
    expect((await upload(stock, '<NFe>sem chave</NFe>')).json().error.code).toBe('INVALID_NFE_XML');
  });
});
