import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { appRole, COOKIE, loggedAs, makeApp, ORIGIN, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let manager: Awaited<ReturnType<typeof loggedAs>>;
beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  manager = await loggedAs(app, 'manager');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const P = '/api/v1/admin/products';
const C = '/api/v1/admin/categories';

describe('categorias', () => {
  it('cria árvore com slug automático e impede ciclo e mais de 3 níveis', async () => {
    const a = (await manager.post(C, { name: 'Embalagens para Bolo' })).json().category;
    expect(a.slug).toBe('embalagens-para-bolo');
    const b = (await manager.post(C, { name: 'Caixas', parentId: a.id })).json().category;
    const c = (await manager.post(C, { name: 'Caixas com visor', parentId: b.id })).json().category;
    expect((await manager.post(C, { name: 'Quarto nível', parentId: c.id })).json().error.code).toBe('CATEGORY_DEPTH');
    expect((await manager.patch(`${C}/${a.id}`, { parentId: c.id })).json().error.code).toMatch(/CATEGORY_(CYCLE|DEPTH)/);
    expect((await manager.post(C, { name: 'caixas', parentId: a.id })).json().error.code).toBe('NAME_IN_USE');
  });

  it('não apaga categoria com produto', async () => {
    const cat = (await manager.post(C, { name: `Forminhas ${uid()}` })).json().category;
    expect((await manager.post(P, productPayload({ categoryId: cat.id }))).statusCode).toBe(201);
    expect((await manager.del(`${C}/${cat.id}`)).json().error.code).toBe('CATEGORY_IN_USE');
  });
});

describe('produtos, variações e embalagens', () => {
  it('cadastra produto com unidade, pacote e embalagem de compra, e registra o preço inicial', async () => {
    const res = await manager.post(P, productPayload({ name: 'Forminha de papel nº 5 marrom' }));
    expect(res.statusCode).toBe(201);
    const p = res.json().product;
    expect(p.slug).toBe('forminha-de-papel-n-5-marrom');
    expect(p.fiscal.status).toBe('pending');
    const packs = p.variants[0].packagings;
    expect(packs.map((k: { label: string }) => k.label).sort()).toEqual(['Pacote com 50', 'Pacote do fornecedor com 100', 'Unidade']);
    expect(packs.find((k: { label: string }) => k.label === 'Pacote com 50').is_default).toBe(true);
    // compra de 1 pacote = 100 unidades base: a conversao vem da embalagem
    expect(packs.find((k: { kind: string }) => k.kind === 'purchase').base_qty).toBe('100.000');
    const hist = await owner.query('SELECT count(*)::int AS n, bool_and(changed_by IS NOT NULL) AS authored FROM price_history h JOIN packagings k ON k.id = h.packaging_id JOIN product_variants v ON v.id = k.variant_id WHERE v.product_id = $1', [p.id]);
    expect(hist.rows[0]).toEqual({ n: 2, authored: true });
  });

  it('recusa fração em unidade inteira e aceita em quilo', async () => {
    const bad = productPayload();
    bad.variants[0]!.packagings[0]!.baseQty = '0.5';
    expect((await manager.post(P, bad)).json().error.code).toBe('FRACTION_NOT_ALLOWED');
    const kg = productPayload({ baseUnit: 'KG', name: `Açúcar de confeiteiro ${uid()}` });
    kg.variants[0]!.packagings = [
      { kind: 'sale', label: '500 g', unitCode: 'G', baseQty: '0.5', priceCents: 900 },
      { kind: 'purchase', label: 'Saco de 25 kg', unitCode: 'KG', baseQty: '25' },
    ] as never;
    expect((await manager.post(P, kg)).statusCode).toBe(201);
  });

  it('exige embalagem de venda com preço e recusa preço na embalagem de compra', async () => {
    const noSale = productPayload();
    noSale.variants[0]!.packagings = [{ kind: 'purchase', label: 'Caixa', unitCode: 'CX', baseQty: '100' }] as never;
    expect((await manager.post(P, noSale)).json().error.code).toBe('NO_SALE_PACKAGING');
    const priced = productPayload();
    (priced.variants[0]!.packagings[2] as Record<string, unknown>).priceCents = 500;
    expect((await manager.post(P, priced)).json().error.code).toBe('PURCHASE_PRICE');
  });

  it('SKU é único em todo o catálogo e código de barras precisa de dígito válido', async () => {
    const first = productPayload();
    expect((await manager.post(P, first)).statusCode).toBe(201);
    const again = productPayload();
    again.variants[0]!.sku = first.variants[0]!.sku.toLowerCase();
    expect((await manager.post(P, again)).json().error.code).toBe('SKU_IN_USE');
    const bad = productPayload();
    (bad.variants[0] as Record<string, unknown>).barcode = '7891000315508';
    expect((await manager.post(P, bad)).statusCode).toBe(400);
  });

  it('alterar preço exige permissão de preços com MFA, e o histórico guarda o autor', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const body = toInput(created);
    body.variants[0].packagings[0].priceCents = 30;
    const denied = await manager.put(`${P}/${created.id}`, body);
    expect(denied.json().error.code).toBe('PRICE_FORBIDDEN');

    const pricer = await loggedAs(app, 'manager', { mfa: true });
    const ok = await pricer.put(`${P}/${created.id}`, body);
    expect(ok.statusCode).toBe(200);
    const hist = (await pricer.get(`${P}/${created.id}`)).json().priceHistory;
    expect(hist[0]).toMatchObject({ old_price_cents: '25', new_price_cents: '30' });
    expect(hist[0].changed_by).toBe('Usuario manager');
  });

  it('impede sobrescrever alteração de outra pessoa (versão)', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const body = toInput(created);
    expect((await manager.put(`${P}/${created.id}`, { ...body, name: 'Primeira edição' })).statusCode).toBe(200);
    expect((await manager.put(`${P}/${created.id}`, { ...body, name: 'Edição atrasada' })).json().error.code).toBe('STALE_VERSION');
  });

  it('variação retirada do cadastro fica inativa, não é apagada', async () => {
    const payload = productPayload();
    payload.variants.push({ sku: `CP-${uid()}`.toUpperCase(), packagings: [{ kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', priceCents: 30 }] } as never);
    const created = (await manager.post(P, payload)).json().product;
    expect(created.variants).toHaveLength(2);
    const body = toInput(created);
    body.variants = body.variants.slice(0, 1);
    const after = (await manager.put(`${P}/${created.id}`, body)).json().product;
    expect(after.variants.map((v: { active: boolean }) => v.active)).toEqual([true, false]);
  });

  it('busca sem acento por nome e por SKU', async () => {
    const p = productPayload({ name: `Caixa para doces ${uid()} com divisória` });
    await manager.post(P, p);
    const byName = (await manager.get(`${P}?q=${encodeURIComponent('DIVISORIA')}`)).json();
    expect(byName.products.some((x: { name: string }) => x.name === p.name)).toBe(true);
    const bySku = (await manager.get(`${P}?q=${p.variants[0]!.sku.toLowerCase()}`)).json();
    expect(bySku.products).toHaveLength(1);
    expect(bySku.products[0].unit_price_cents).toBe('20');
  });

  it('envia imagem: confere o conteúdo, gera WebP e define a principal', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#d9a066' } }).png().toBuffer();
    const boundary = '----x';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await manager.send('POST', `${P}/${created.id}/images`, payload as never, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(res.statusCode).toBe(201);
    expect(res.json().image.is_primary).toBe(true);
    const img = await app.inject({ method: 'GET', url: `/api/v1/public/images/${res.json().image.file_key}/320.webp` });
    expect(img.headers['content-type']).toBe('image/webp');
    expect((await sharp(img.rawPayload).metadata()).width).toBe(320);

    const fake = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`), Buffer.from('não sou imagem'), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const bad = await manager.send('POST', `${P}/${created.id}/images`, fake as never, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(bad.json().error.code).toBe('INVALID_IMAGE');
  });

  const multipart = (data: Buffer, name = 'a.png', type = 'image/png') => {
    const boundary = '----y';
    return {
      body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };
  const sendImage = async (productId: string, data: Buffer, path = 'images', name?: string, type?: string) => {
    const m = multipart(data, name, type);
    return manager.send('POST', `${P}/${productId}/${path}`, m.body as never, m.headers);
  };
  const solid = (color: string, format: 'png' | 'jpeg' | 'webp' = 'png') => sharp({ create: { width: 500, height: 500, channels: 3, background: color } })[format]().toBuffer();

  it('organiza a galeria: ordem nova define a principal, troca o arquivo e remove só a escolhida', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const ids: string[] = [];
    for (const [c, f] of [['#ff0000', 'png'], ['#00ff00', 'jpeg'], ['#0000ff', 'webp']] as const) {
      const r = await sendImage(created.id, await solid(c, f));
      expect(r.statusCode).toBe(201);
      ids.push(r.json().image.id);
    }
    const [a, b, c] = ids as [string, string, string];

    const ordered = await manager.put(`${P}/${created.id}/images/order`, { ids: [c, a, b] });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().images.map((i: { id: string; is_primary: boolean; position: number }) => [i.id, i.is_primary, i.position])).toEqual([
      [c, true, 0],
      [a, false, 1],
      [b, false, 2],
    ]);
    // lista incompleta ou com foto de outro produto e recusada
    expect((await manager.put(`${P}/${created.id}/images/order`, { ids: [c, a] })).json().error.code).toBe('IMAGES_CHANGED');
    expect((await manager.put(`${P}/${created.id}/images/order`, { ids: [c, a, a] })).json().error.code).toBe('IMAGES_CHANGED');

    // trocar o arquivo da principal: mesma posicao, chave nova, arquivo antigo sai do disco
    const oldKey = ordered.json().images[0].file_key;
    const replaced = await sendImage(created.id, await solid('#ffff00'), `images/${c}/file`);
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().image).toMatchObject({ id: c, is_primary: true, position: 0 });
    expect(replaced.json().image.file_key).not.toBe(oldKey);
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/images/${oldKey}/320.webp` })).statusCode).toBe(404);
    const novo = await app.inject({ method: 'GET', url: `/api/v1/public/images/${replaced.json().image.file_key}/320.webp` });
    expect((await sharp(novo.rawPayload).stats()).channels[2]!.mean).toBeLessThan(10); // amarelo: sem azul
    // troca com arquivo invalido nao mexe na foto
    expect((await sendImage(created.id, Buffer.from('GIF89a falso'), `images/${c}/file`)).json().error.code).toBe('INVALID_IMAGE');

    // remover a principal: as outras ficam, a proxima vira principal
    expect((await manager.send('DELETE', `${P}/${created.id}/images/${c}`)).statusCode).toBe(200);
    const left = (await manager.get(`${P}/${created.id}`)).json().product.images;
    expect(left.map((i: { id: string; is_primary: boolean }) => [i.id, i.is_primary])).toEqual([
      [a, true],
      [b, false],
    ]);
  });

  it('recusa formato fora da lista (pelo conteúdo, não pela extensão), imagem pequena e arquivo acima de 8 MB', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const gif = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#000' } }).gif().toBuffer();
    expect((await sendImage(created.id, gif, 'images', 'foto.png', 'image/png')).json().error.code).toBe('INVALID_IMAGE');
    const tiny = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await sendImage(created.id, tiny)).json().error.code).toBe('IMAGE_TOO_SMALL');
    const big = await sendImage(created.id, Buffer.alloc(8 * 1024 * 1024 + 10, 1));
    expect(big.statusCode).toBe(413);
    expect((await manager.get(`${P}/${created.id}`)).json().product.images).toHaveLength(0);
  });

  it('foto JPEG acima de 8 MB chegando em pedaços pela rede: 413 com mensagem, nunca erro interno', async () => {
    // Pelo inject o corpo chega inteiro e o limite sempre dispara. Pela rede o arquivo chega em pedaços e o
    // plugin entregava o JPEG cortado em 8 MB sem erro; o sharp falhava e a resposta era 500 (achado em 14/11/2026).
    const created = (await manager.post(P, productPayload())).json().product;
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer()
      // Passa do limite por pouco (como a foto real de 8,24 MB): o excesso cabe no ultimo pedaco recebido.
      .then((b) => b.subarray(0, 8 * 1024 * 1024 + 250_000));
    expect(big.length).toBeGreaterThan(8 * 1024 * 1024);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    // A falha era intermitente (dependia da ordem dos pedacos): varias tentativas.
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const fd = new FormData();
      fd.append('file', new Blob([big], { type: 'image/jpeg' }), 'grande.jpg');
      const res = await fetch(`${address}${P}/${created.id}/images`, { method: 'POST', headers: { origin: ORIGIN, cookie: `${COOKIE}=${manager.sid}` }, body: fd });
      codes.push(`${res.status} ${((await res.json()) as { error?: { code: string } }).error?.code}`);
    }
    expect(codes).toEqual(Array(8).fill('413 FILE_TOO_LARGE'));
    expect((await manager.get(`${P}/${created.id}`)).json().product.images).toHaveLength(0);
  });

  it('só quem gerencia o catálogo envia, ordena ou troca fotos', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const img = (await sendImage(created.id, await solid('#123456'))).json().image;
    const seller = await loggedAs(app, 'sales');
    const m = multipart(await solid('#654321'));
    expect((await seller.send('POST', `${P}/${created.id}/images`, m.body as never, m.headers)).statusCode).toBe(403);
    expect((await seller.send('POST', `${P}/${created.id}/images/${img.id}/file`, m.body as never, m.headers)).statusCode).toBe(403);
    expect((await seller.put(`${P}/${created.id}/images/order`, { ids: [img.id] })).statusCode).toBe(403);
  });
});

describe('classificação fiscal do produto', () => {
  it('informar e validar ficam registrados; mudar o NCM derruba a validação', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const fiscal = await loggedAs(app, 'fiscal', { mfa: true });
    const informed = await fiscal.put(`${P}/${created.id}/fiscal`, { ncm: '48195000', origin: 0 });
    expect(informed.json().fiscal.status).toBe('informed');

    // validar e uma permissao a parte, concedida ao contador
    expect((await fiscal.post(`${P}/${created.id}/fiscal/validate`, { validatorName: 'Contador Responsável' })).statusCode).toBe(403);
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const validated = await boss.post(`${P}/${created.id}/fiscal/validate`, { validatorName: 'Contador Responsável' });
    expect(validated.json().fiscal).toMatchObject({ status: 'validated', validator_name: 'Contador Responsável' });

    const changed = await fiscal.put(`${P}/${created.id}/fiscal`, { ncm: '48191000', origin: 0 });
    expect(changed.json().fiscal).toMatchObject({ status: 'informed', validator_name: null });
    const history = (await fiscal.get(`${P}/${created.id}/fiscal/history`)).json().history;
    expect(history.length).toBeGreaterThanOrEqual(4);
  });

  it('não valida sem NCM e origem; NCM precisa de 8 dígitos', async () => {
    const created = (await manager.post(P, productPayload())).json().product;
    const boss = await loggedAs(app, 'owner', { mfa: true });
    expect((await boss.post(`${P}/${created.id}/fiscal/validate`, { validatorName: 'Contador' })).json().error.code).toBe('FISCAL_INCOMPLETE');
    expect((await boss.put(`${P}/${created.id}/fiscal`, { ncm: '4819', origin: 0 })).statusCode).toBe(400);
  });
});

/** Converte o produto lido de volta para o formato de gravacao. */
function toInput(p: any) {
  return {
    version: p.version,
    name: p.name,
    slug: p.slug,
    categoryId: p.category_id,
    status: p.status,
    baseUnit: p.base_unit,
    availabilityMode: p.availability_mode,
    minStock: p.min_stock,
    specs: p.specs,
    variants: p.variants
      .filter((v: any) => v.active)
      .map((v: any) => ({
        id: v.id,
        sku: v.sku,
        attributes: v.attributes,
        packagings: v.packagings.map((k: any) => ({ id: k.id, kind: k.kind, label: k.label, unitCode: k.unit_code, baseQty: k.base_qty, priceCents: k.price_cents === null ? null : Number(k.price_cents), isDefault: k.is_default })),
      })),
  };
}
