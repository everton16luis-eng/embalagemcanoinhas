/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeFiscalProvider, FocusNfeProvider, WEBHOOK_HEADER } from '../src/lib/fiscal.js';
import { buildNfePayload, HOMOLOGATION_NAME, taxQuantities, type NfeInput } from '../src/lib/nfe-payload.js';
import { FakeProvider } from '../src/lib/payments.js';
import { certificateAlert, fiscalTick } from '../src/modules/fiscal.js';
import { appRole, loggedAs, makeApp, ORIGIN, owner, productPayload, randomIp, resetCatalog, uid } from './helpers.js';

// Codigos fiscais abaixo sao valores de TESTE, so para exercitar o fluxo. Os reais vem do contador.
const TEST_RULE = {
  name: 'Teste: venda interna a pessoa física',
  destination: 'internal',
  buyerKind: 'pf',
  naturezaOperacao: 'Venda de mercadoria',
  cfop: '5102',
  icmsSituacaoTributaria: '102',
  pisSituacaoTributaria: '49',
  cofinsSituacaoTributaria: '49',
  consumidorFinal: true,
  presencaComprador: 2,
};
// CNPJ do exemplo oficial da Receita e endereco ficticio. Nao sao dados da empresa.
const TEST_COMPANY = {
  legalName: 'Empresa de Teste Ltda',
  cnpj: '12.ABC.345/01DE-35',
  stateRegistration: '123456789',
  street: 'Rua de Teste',
  number: '1',
  district: 'Centro',
  city: 'Canoinhas',
  cityIbge: '4200000',
  uf: 'SC',
  cep: '89460-000',
  taxRegime: 'simples_nacional',
};
const ADDRESS = { recipient: 'Maria', cep: '89460-100', street: 'Rua Vidal Ramos', number: '100', district: 'Centro', city: 'Canoinhas', uf: 'SC' };
const BUYER = { kind: 'pf', name: 'Maria Confeiteira', email: 'maria@teste.local', phone: '47999990000', document: '529.982.247-25' };

let app: FastifyInstance;
let fake: FakeFiscalProvider;
let boss: Awaited<ReturnType<typeof loggedAs>>;
let deliveryId: string;
let ruleId: string;

const resetSettings = () =>
  owner.query(
    `UPDATE fiscal_settings SET environment = 'homologacao', production_released_by = NULL, production_released_at = NULL, production_validator_name = NULL,
       accreditation_status = 'not_started', emission_policy = 'manual'`,
  );

beforeAll(async () => {
  fake = new FakeFiscalProvider('segredo-de-teste-do-aviso-fiscal');
  app = await makeApp(undefined, new FakeProvider(), fake);
  await resetCatalog();
  await resetSettings();
  boss = await loggedAs(app, 'owner', { mfa: true });
  expect((await boss.put('/api/v1/admin/company', { ...TEST_COMPANY, changeNote: `teste fiscal ${uid()}` })).statusCode).toBe(200);
  const d = await boss.post('/api/v1/admin/shipping-options', { name: 'Entrega Canoinhas', kind: 'delivery', cepRanges: ['89460000-89479999'], baseCents: 1500, minDays: 1, maxDays: 2 });
  expect(d.statusCode, d.body).toBe(201);
  deliveryId = d.json().option.id;
  const r = await boss.post('/api/v1/admin/fiscal/rules', TEST_RULE);
  expect(r.statusCode, r.body).toBe(201);
  ruleId = r.json().rule.id;
  expect((await boss.post(`/api/v1/admin/fiscal/rules/${ruleId}/validate`, { validatorName: 'Contador de Teste' })).statusCode).toBe(200);
});
afterAll(async () => {
  await resetSettings();
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

async function product(validated = true) {
  const res = await boss.post('/api/v1/admin/products', productPayload());
  expect(res.statusCode, res.body).toBe(201);
  const p = res.json().product;
  const v = p.variants[0];
  await boss.post('/api/v1/admin/stock/movements', { variantId: v.id, kind: 'adjustment', qty: '1000', reason: 'Saldo inicial', requestKey: `k-${uid()}-${uid()}` });
  await boss.put(`/api/v1/admin/products/${p.id}/fiscal`, { ncm: '48195000', origin: 0, taxUnit: 'UN', taxUnitQty: '1' });
  if (validated) await boss.post(`/api/v1/admin/products/${p.id}/fiscal/validate`, { validatorName: 'Contador de Teste' });
  return { productId: p.id as string, pack50: v.packagings.find((k: any) => k.label === 'Pacote com 50') };
}

/** Pedido com entrega em SC, ja pago (o pagamento e testado em store.test.ts). */
async function paidOrder(opts: { validated?: boolean; paid?: boolean; address?: typeof ADDRESS } = {}) {
  const { pack50, productId } = await product(opts.validated ?? true);
  const jar: Record<string, string> = {};
  const ip = randomIp();
  const send = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { origin: ORIGIN }, cookies: { ...jar }, ...(payload ? { payload } : {}) });
    for (const c of res.cookies) if (c.value) jar[c.name] = c.value;
    return res;
  };
  await send('POST', '/api/v1/public/cart/items', { packagingId: pack50.id, packs: 3 });
  const res = await send('POST', '/api/v1/public/checkout', {
    requestKey: `pedido-${uid()}`,
    buyer: BUYER,
    shippingOptionId: deliveryId,
    address: opts.address ?? ADDRESS,
    paymentMethod: 'pix',
    expectedTotalCents: 4500,
  });
  expect(res.statusCode, res.body).toBe(201);
  const order = res.json().order as { id: string; token: string; number: number };
  if (opts.paid ?? true) await owner.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [order.id]);
  return { ...order, productId };
}

const emit = (orderId: string) => boss.post(`/api/v1/admin/fiscal/orders/${orderId}/emit`);
const orderRow = async (id: string) => (await owner.query('SELECT status, invoice_status, version FROM orders WHERE id = $1', [id])).rows[0];
const webhook = (body: object, token = 'segredo-de-teste-do-aviso-fiscal') =>
  app.inject({ method: 'POST', url: '/api/v1/webhooks/fiscal', headers: { [WEBHOOK_HEADER]: token }, payload: body });

describe('JSON da NF-e', () => {
  const input = (over: Partial<NfeInput> = {}): NfeInput => ({
    environment: 'homologacao',
    issuedAt: new Date('2026-11-13T15:00:00Z'),
    company: { legal_name: 'Empresa de Teste Ltda', trade_name: null, cnpj: '12ABC34501DE35', state_registration: '123456789', street: 'Rua', number: '1', district: 'Centro', city: 'Canoinhas', uf: 'SC', cep: '89460000', phone: null, tax_regime: 'simples_nacional' },
    rule: { natureza_operacao: 'Venda', cfop: '5102', icms_situacao_tributaria: '102', pis_situacao_tributaria: '49', cofins_situacao_tributaria: '49', consumidor_final: true, presenca_comprador: 2, extra_fields: { cnpj_emitente: 'X', observacoes_contribuinte: 'ok' }, item_extra_fields: { cfop: '9999', ibs_cbs_situacao_tributaria: '000' } },
    destination: 'internal',
    buyer: { kind: 'pf', name: 'Maria', document: '52998224725', stateRegistration: null, phone: null, email: 'm@teste.local' },
    address: { street: 'Rua', number: '2', district: 'Centro', city: 'Canoinhas', uf: 'SC', cep: '89460100' },
    shippingKind: 'delivery',
    paymentMethod: 'pix',
    subtotalCents: 3000,
    discountCents: 0,
    freightCents: 1500,
    totalCents: 4500,
    items: [{ sku: 'CP-1', description: 'Copo - Pacote com 50', unitCode: 'PCT', packs: 3, unitPriceCents: 1000, totalCents: 3000, baseQtyPerPack: '50', ncm: '48195000', origin: 0, taxUnit: 'UN', taxUnitQty: '1' }],
    ...over,
  });

  it('usa só campos documentados, nome de homologação e regra do contador sem sobrescrever a loja', () => {
    const p = buildNfePayload(input()) as any;
    expect(p).toMatchObject({
      nome_destinatario: HOMOLOGATION_NAME,
      cpf_destinatario: '52998224725',
      indicador_inscricao_estadual_destinatario: 9,
      local_destino: 1,
      consumidor_final: 1,
      indicador_intermediario: 0,
      regime_tributario_emitente: 1,
      cnpj_emitente: '12ABC34501DE35',
      modalidade_frete: 0,
      valor_total: 45,
      valor_frete: 15,
      formas_pagamento: [{ forma_pagamento: '17', valor_pagamento: 45 }],
      observacoes_contribuinte: 'ok',
      data_emissao: '2026-11-13T12:00:00-03:00',
    });
    expect(p.items[0]).toMatchObject({ cfop: '5102', quantidade_comercial: 3, unidade_comercial: 'PCT', quantidade_tributavel: 150, unidade_tributavel: 'UN', valor_unitario_tributavel: 0.2, ibs_cbs_situacao_tributaria: '000' });
    const prod = buildNfePayload(input({ environment: 'producao', shippingKind: 'pickup', paymentMethod: 'card' })) as any;
    expect(prod.nome_destinatario).toBe('Maria');
    expect(prod.modalidade_frete).toBe(9);
    expect(prod.formas_pagamento[0]).toMatchObject({ forma_pagamento: '03', tipo_integracao: 2 });
  });

  it('quantidade tributável sem unidade cadastrada repete a comercial', () => {
    expect(taxQuantities({ sku: 'x', description: 'x', unitCode: 'PCT', packs: 2, unitPriceCents: 1234, totalCents: 2468, baseQtyPerPack: '50', ncm: '1', origin: 0, taxUnit: null, taxUnitQty: null })).toEqual({ unit: 'PCT', qty: 2, unitValue: 12.34 });
  });
});

describe('adaptador Focus NFe', () => {
  it('autentica por Basic com o token, manda a ref e reconsulta quando já recebida', async () => {
    const seen: { url: string; auth: string; method: string }[] = [];
    const fetcher = (async (url: string | URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: String((init.headers as Record<string, string>).Authorization), method: String(init.method ?? 'GET') });
      if (init.method === 'POST') return new Response(JSON.stringify({ codigo: 'already_processed', mensagem: 'já processada' }), { status: 422 });
      return new Response(JSON.stringify({ status: 'autorizado', status_sefaz: '100', chave_nfe: 'NFe42261112345678000123550010000000011000000011', numero: '1', serie: '1', caminho_xml_nota_fiscal: '/arquivos/x.xml' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new FocusNfeProvider({ homologacao: 'token-de-teste-123456' }, 'segredo', fetcher);
    const r = await p.emit('homologacao', 'h1-1-abc', { a: 1 });
    expect(r).toMatchObject({ status: 'authorized', number: '1', accessKey: '42261112345678000123550010000000011000000011', files: { nfe_xml: '/arquivos/x.xml' } });
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'https://homologacao.focusnfe.com.br/v2/nfe?ref=h1-1-abc', auth: `Basic ${Buffer.from('token-de-teste-123456:').toString('base64')}` });
    expect(seen[1]).toMatchObject({ method: 'GET', url: 'https://homologacao.focusnfe.com.br/v2/nfe/h1-1-abc' });
    expect(p.configured('producao')).toBe(false);
    await expect(p.emit('producao', 'p1-1-abc', {})).rejects.toThrow(/sem token/);
  });

  it('erro de validação vira rejeição; 5xx vira falha de comunicação; download só do provedor', async () => {
    let status = 422;
    const fetcher = (async () => new Response(JSON.stringify({ codigo: 'erro_validacao_schema', mensagem: 'Erro', erros: [{ mensagem: 'NCM inválido', campo: 'codigo_ncm' }] }), { status })) as unknown as typeof fetch;
    const p = new FocusNfeProvider({ homologacao: 'token-de-teste-123456' }, 'segredo-do-aviso', fetcher);
    expect(await p.emit('homologacao', 'h1-1-abc', {})).toMatchObject({ status: 'rejected', errors: [{ message: 'NCM inválido', field: 'codigo_ncm' }] });
    status = 503;
    await expect(p.emit('homologacao', 'h1-1-abc', {})).rejects.toThrow(/indisponível/);
    await expect(p.download('homologacao', 'https://exemplo.com/arquivo.xml')).rejects.toThrow(/não reconhecido/);
    expect(p.verifyWebhook({ [WEBHOOK_HEADER]: 'segredo-do-aviso' })).toBe(true);
    expect(p.verifyWebhook({ [WEBHOOK_HEADER]: 'outro' })).toBe(false);
  });
});

describe('conferência antes da emissão', () => {
  it('lista o que falta e não emite', async () => {
    const o = await paidOrder({ validated: false, paid: false });
    const check = (await boss.get(`/api/v1/admin/fiscal/orders/${o.id}`)).json();
    expect(check.ready).toBe(false);
    expect(check.issues.map((i: any) => i.code).sort()).toEqual(['ORDER_STATUS', 'PRODUCT_FISCAL']);
    const r = await emit(o.id);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('FISCAL_NOT_READY');
    expect(fake.calls.filter((c) => c.op === 'emit')).toHaveLength(0);

    const other = await paidOrder({ address: { ...ADDRESS, cep: '89460-200', uf: 'PR' } });
    expect((await boss.get(`/api/v1/admin/fiscal/orders/${other.id}`)).json().issues.map((i: any) => i.code)).toEqual(['RULE_MISSING']);
  });
});

describe('emissão', () => {
  it('autoriza, guarda XML e DANFE com hash, libera a expedição e não emite de novo', async () => {
    const o = await paidOrder();
    const r = await emit(o.id);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().document).toMatchObject({ status: 'authorized', environment: 'homologacao', series: '1' });
    expect((await orderRow(o.id)).invoice_status).toBe('authorized');
    const again = await emit(o.id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, document: { id: r.json().document.id } });
    expect(fake.calls.filter((c) => c.op === 'emit' && c.ref === r.json().document.ref)).toHaveLength(1);

    const detail = (await boss.get(`/api/v1/admin/fiscal/documents/${r.json().document.id}`)).json();
    expect(detail.files.map((f: any) => f.kind).sort()).toEqual(['danfe_pdf', 'nfe_xml']);
    expect(detail.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.document.payload.nome_destinatario).toBe(HOMOLOGATION_NAME);

    // Cliente: o link do pedido mostra a nota e baixa o DANFE.
    const pub = (await app.inject({ method: 'GET', url: `/api/v1/public/orders/${o.token}` })).json().order;
    expect(pub.invoice).toMatchObject({ status: 'authorized', number: r.json().document.number });
    const danfe = await app.inject({ method: 'GET', url: `/api/v1/public/orders/${o.token}/invoice/danfe` });
    expect(danfe.statusCode).toBe(200);
    expect(danfe.headers['content-type']).toBe('application/pdf');
    expect(danfe.body.startsWith('%PDF')).toBe(true);

    // Pedido com nota autorizada nao e cancelado sem cancelar a nota.
    const ord = (await boss.get(`/api/v1/admin/orders/${o.id}`)).json().order;
    expect((await boss.post(`/api/v1/admin/orders/${o.id}/cancel`, { reason: 'Desistiu', version: ord.version })).json().error.code).toBe('INVOICE_ACTIVE');
  });

  it('dois cliques ao mesmo tempo geram uma nota só', async () => {
    const o = await paidOrder();
    const [a, b] = await Promise.all([emit(o.id), emit(o.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((await owner.query('SELECT count(*)::int AS n FROM fiscal_documents WHERE order_id = $1', [o.id])).rows[0].n).toBe(1);
  });

  it('em processamento: aviso sem o header é recusado e a situação vem da consulta, não do corpo', async () => {
    fake.mode = 'process';
    const o = await paidOrder();
    const doc = (await emit(o.id)).json().document;
    fake.mode = 'authorize';
    expect(doc.status).toBe('processing');
    expect((await webhook({ ref: doc.ref, status: 'autorizado' }, 'errado')).statusCode).toBe(401);
    // Corpo diz autorizado, mas o provedor ainda processa: nada muda.
    expect((await webhook({ ref: doc.ref, status: 'autorizado' })).statusCode).toBe(200);
    expect((await orderRow(o.id)).invoice_status).toBe('processing');
    fake.settle(doc.ref);
    expect((await webhook({ ref: doc.ref, status: 'autorizado' })).statusCode).toBe(200);
    expect((await orderRow(o.id)).invoice_status).toBe('authorized');
    const notes = (await owner.query('SELECT auth_valid FROM fiscal_webhook_notifications WHERE ref = $1 ORDER BY id', [doc.ref])).rows.map((r) => r.auth_valid);
    expect(notes).toEqual([false, true, true]);
  });

  it('falha de rede: fica pendente e a rotina reenvia com a mesma ref', async () => {
    fake.mode = 'network_error';
    const o = await paidOrder();
    const r = await emit(o.id);
    fake.mode = 'authorize';
    expect(r.json().document.status).toBe('pending');
    expect(r.json().warning).toMatch(/rede/);
    await fiscalTick(fake);
    const doc = (await owner.query('SELECT status, ref FROM fiscal_documents WHERE order_id = $1', [o.id])).rows[0];
    expect(doc.status).toBe('authorized');
    expect(fake.calls.filter((c) => c.op === 'emit' && c.ref === doc.ref)).toHaveLength(2);

    // Resposta perdida: o provedor recebeu; a rotina so consulta, nao reenvia.
    fake.mode = 'lost';
    const o2 = await paidOrder();
    const d2 = (await emit(o2.id)).json().document;
    fake.mode = 'authorize';
    fake.settle(d2.ref);
    await fiscalTick(fake);
    expect((await orderRow(o2.id)).invoice_status).toBe('authorized');
    expect(fake.calls.filter((c) => c.op === 'emit' && c.ref === d2.ref)).toHaveLength(1);
  });

  it('rejeição fica registrada e a nova tentativa usa outra ref', async () => {
    fake.mode = 'reject';
    const o = await paidOrder();
    const first = (await emit(o.id)).json().document;
    fake.mode = 'authorize';
    expect(first).toMatchObject({ status: 'rejected' });
    expect((await orderRow(o.id)).invoice_status).toBe('rejected');
    const second = (await emit(o.id)).json().document;
    expect(second.status).toBe('authorized');
    expect(second.ref).not.toBe(first.ref);
    const docs = (await boss.get(`/api/v1/admin/fiscal/orders/${o.id}`)).json().documents;
    expect(docs.map((d: any) => d.status)).toEqual(['authorized', 'rejected']);
  });
});

describe('eventos da nota', () => {
  it('carta de correção e cancelamento com arquivos; pedido libera o cancelamento', async () => {
    const o = await paidOrder();
    const doc = (await emit(o.id)).json().document;
    const D = `/api/v1/admin/fiscal/documents/${doc.id}`;
    expect((await boss.post(`${D}/correction`, { text: 'curta' })).statusCode).toBe(400);
    const cce = await boss.post(`${D}/correction`, { text: 'Correção do complemento do endereço de entrega.' });
    expect(cce.statusCode, cce.body).toBe(200);
    expect(cce.json().sequence).toBe(1);
    expect((await boss.post(`${D}/cancel`, { reason: 'curta' })).statusCode).toBe(400);
    const c = await boss.post(`${D}/cancel`, { reason: 'Pedido cancelado a pedido do cliente.' });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().document.status).toBe('canceled');
    expect((await orderRow(o.id)).invoice_status).toBe('canceled');
    const files = (await boss.get(D)).json().files.map((f: any) => `${f.kind}:${f.sequence}`).sort();
    expect(files).toEqual(['cancel_xml:1', 'cce_pdf:1', 'cce_xml:1', 'danfe_pdf:1', 'nfe_xml:1']);
    expect((await boss.post(`${D}/cancel`, { reason: 'Pedido cancelado a pedido do cliente.' })).json().error.code).toBe('NOT_AUTHORIZED');
    const ord = (await boss.get(`/api/v1/admin/orders/${o.id}`)).json().order;
    expect((await boss.post(`/api/v1/admin/orders/${o.id}/cancel`, { reason: 'Desistiu', version: ord.version })).statusCode).toBe(200);
  });

  it('nota não é apagada e o enviado não muda; arquivo adulterado é detectado', async () => {
    const o = await paidOrder();
    const doc = (await emit(o.id)).json().document;
    await expect(appRole.query('DELETE FROM fiscal_documents WHERE id = $1', [doc.id])).rejects.toThrow(/permission denied/);
    await expect(owner.query('DELETE FROM fiscal_documents WHERE id = $1', [doc.id])).rejects.toThrow(/nao pode ser apagado/);
    await expect(owner.query(`UPDATE fiscal_documents SET payload = '{}' WHERE id = $1`, [doc.id])).rejects.toThrow(/imutaveis/);
    await expect(owner.query(`UPDATE fiscal_documents SET status = 'rejected' WHERE id = $1`, [doc.id])).rejects.toThrow(/so pode ser cancelada/);
    await expect(owner.query('DELETE FROM fiscal_files WHERE document_id = $1', [doc.id])).rejects.toThrow();
    await expect(owner.query('DELETE FROM fiscal_document_events WHERE document_id = $1', [doc.id])).rejects.toThrow();

    const f = (await owner.query(`SELECT id, storage_key FROM fiscal_files WHERE document_id = $1 AND kind = 'nfe_xml'`, [doc.id])).rows[0];
    const ok = await boss.get(`/api/v1/admin/fiscal/files/${f.id}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/xml');
    const file = path.join(process.env.STORAGE_DIR!, 'fiscal', f.storage_key);
    await writeFile(file, `${await readFile(file, 'utf8')}<!-- alterado -->`);
    const bad = await boss.get(`/api/v1/admin/fiscal/files/${f.id}`);
    expect(bad.statusCode).toBe(500);
    expect(bad.json().error.code).toBe('FISCAL_FILE_CORRUPTED');
  });

  it('inutilização registra o protocolo e recusa faixa com nota emitida', async () => {
    const used = (await owner.query(`SELECT number FROM fiscal_documents WHERE status = 'authorized' AND series = '1' LIMIT 1`)).rows[0].number;
    expect((await boss.post('/api/v1/admin/fiscal/inutilizations', { series: '1', start: Number(used), end: Number(used), justification: 'Salto de numeração no sistema.' })).json().error.code).toBe('RANGE_USED');
    const r = await boss.post('/api/v1/admin/fiscal/inutilizations', { series: '1', start: 900000, end: 900002, justification: 'Salto de numeração no sistema.' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().inutilization).toMatchObject({ status: 'authorized', protocol: '342000000000001' });
    const list = (await boss.get('/api/v1/admin/fiscal/inutilizations')).json().inutilizations;
    expect(list[0].file_id).toBeTruthy();
  });
});

describe('regras, permissões e produção', () => {
  it('editar regra validada derruba a validação; quem não valida recebe 403; campo da loja não é substituído', async () => {
    const fiscal = await loggedAs(app, 'fiscal', { mfa: true });
    const r = await fiscal.post('/api/v1/admin/fiscal/rules', { ...TEST_RULE, name: 'Teste interestadual', destination: 'interstate' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().rule.status).toBe('informed');
    expect((await fiscal.post(`/api/v1/admin/fiscal/rules/${r.json().rule.id}/validate`, { validatorName: 'X Y' })).statusCode).toBe(403);
    expect((await fiscal.post('/api/v1/admin/fiscal/rules', { ...TEST_RULE, destination: 'interstate', buyerKind: 'pj_contribuinte', extraFields: { valor_total: 1 } })).statusCode).toBe(400);
    expect((await fiscal.post('/api/v1/admin/fiscal/rules', TEST_RULE)).json().error.code).toBe('RULE_EXISTS');
    const edited = await boss.put(`/api/v1/admin/fiscal/rules/${ruleId}`, { ...TEST_RULE, cfop: '5405' });
    expect(edited.json().rule).toMatchObject({ status: 'informed', validator_name: null });
    expect((await boss.get(`/api/v1/admin/fiscal/rules/${ruleId}/history`)).json().history.length).toBeGreaterThanOrEqual(3);
    await boss.put(`/api/v1/admin/fiscal/rules/${ruleId}`, TEST_RULE);
    await boss.post(`/api/v1/admin/fiscal/rules/${ruleId}/validate`, { validatorName: 'Contador de Teste' });

    const sales = await loggedAs(app, 'sales');
    expect((await sales.get('/api/v1/admin/fiscal/overview')).statusCode).toBe(403);
    const shipping = await loggedAs(app, 'shipping');
    const o = await paidOrder();
    expect((await shipping.post(`/api/v1/admin/fiscal/orders/${o.id}/emit`)).statusCode).toBe(403);
  });

  it('produção só depois de credenciamento e nota autorizada em homologação', async () => {
    const S = '/api/v1/admin/fiscal/settings';
    expect((await boss.patch(S, { environment: 'producao' })).json().error.code).toBe('PRODUCTION_LOCKED');
    const blocked = await boss.post('/api/v1/admin/fiscal/production-release', { validatorName: 'Contador de Teste', confirm: true });
    expect(blocked.json().error.code).toBe('PRODUCTION_REQUIREMENTS');
    expect(blocked.json().error.details.missing).toEqual(['credenciamento na SEFAZ concluído']);
    await boss.patch(S, { accreditationStatus: 'accredited' });
    const ok = await boss.post('/api/v1/admin/fiscal/production-release', { validatorName: 'Contador de Teste', confirm: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().settings.production_validator_name).toBe('Contador de Teste');
    expect((await boss.patch(S, { environment: 'producao' })).json().settings.environment).toBe('producao');
    const overview = (await boss.get('/api/v1/admin/fiscal/overview')).json();
    expect(overview.productionChecklist).toEqual({ accredited: true, homologationAuthorized: true, productionCredential: true, released: true });
    await resetSettings();
  });

  it('emissão automática ao pagar, quando o contador escolher', async () => {
    const o = await paidOrder();
    await fiscalTick(fake);
    expect((await orderRow(o.id)).invoice_status).toBe('pending');
    await boss.patch('/api/v1/admin/fiscal/settings', { emissionPolicy: 'on_paid' });
    const r = await fiscalTick(fake);
    expect(r.emitted).toBeGreaterThanOrEqual(1);
    expect((await orderRow(o.id)).invoice_status).toBe('authorized');
    await resetSettings();
  });

  it('certificado: avisos com 30, 15 e 7 dias', async () => {
    const now = new Date('2026-11-13T12:00:00-03:00');
    expect(certificateAlert('2027-01-31', now).level).toBe('ok');
    expect(certificateAlert('2026-12-10', now).level).toBe('d30');
    expect(certificateAlert('2026-11-25', now).level).toBe('d15');
    expect(certificateAlert('2026-11-13', now)).toEqual({ days: 0, level: 'd7' });
    expect(certificateAlert('2026-11-12', now).level).toBe('expired');
    const c = await boss.post('/api/v1/admin/fiscal/certificates', { holderName: 'EMPRESA DE TESTE LTDA', cnpj: TEST_COMPANY.cnpj, validFrom: '2026-01-01', validUntil: '2027-01-01' });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().certificate.alert.level).toMatch(/^(ok|d30|d15|d7)$/);
    expect((await boss.get('/api/v1/admin/fiscal/overview')).json().certificate.holder_name).toBe('EMPRESA DE TESTE LTDA');
  });
});
