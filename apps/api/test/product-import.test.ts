import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { COLUMNS, nameKey, nameSimilarity } from '../src/lib/product-import.js';
import { allocateSku, skuBase } from '../src/lib/sku.js';
import { importHooks } from '../src/modules/product-imports.js';
import { appRole, loggedAs, makeApp, owner, productPayload, resetCatalog, uid } from './helpers.js';

let app: FastifyInstance;
let admin: Awaited<ReturnType<typeof loggedAs>>;
let rootId: string;
let copId: string;

const I = '/api/v1/admin/product-imports';
const P = '/api/v1/admin/products';
const C = '/api/v1/admin/categories';

beforeAll(async () => {
  app = await makeApp();
  await resetCatalog();
  admin = await loggedAs(app, 'owner', { mfa: true });
  rootId = (await admin.post(C, { name: 'Descartáveis' })).json().category.id;
  copId = (await admin.post(C, { name: 'Copos', parentId: rootId })).json().category.id;
});
afterAll(async () => {
  importHooks.beforeRow = undefined;
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

type Row = Partial<Record<string, unknown>>;
const HEADERS = COLUMNS.map((c) => (c.required ? `${c.header} *` : c.header));

/** Planilha no formato do modelo: cabecalho na linha 1, exemplo na 2, dados a partir da 3. */
async function sheet(rows: Row[], opts: { headers?: string[]; example?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Produtos');
  const headers = opts.headers ?? HEADERS;
  ws.addRow(headers);
  if (opts.example !== false) ws.addRow(['Exemplo: Copo Descartável 300ml Transparente', 'Exemplo', 'Descartáveis', '', '12,50', 'PCT - Pacote', 'Ativo']);
  const keys = COLUMNS.map((c) => c.key);
  for (const r of rows) ws.addRow(headers.map((_h, i) => (r[keys[i]!] ?? null) as ExcelJS.CellValue));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const valid = (overrides: Row = {}): Row => ({
  name: `Copo Descartável 300ml Transparente`,
  description: 'Copo resistente para festas.',
  category: 'Descartáveis',
  subcategory: 'Copos',
  price: '12,50',
  unit: 'PCT - Pacote',
  status: 'Ativo',
  ...overrides,
});

function multipart(data: Buffer, filename = 'produtos.xlsx') {
  const boundary = `----imp${uid()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// O envio tem limite por sessao (10 por minuto): cada envio do teste usa uma sessao nova de proprietario.
async function upload(buf: Buffer, filename = 'produtos.xlsx', who?: Awaited<ReturnType<typeof loggedAs>>) {
  const m = multipart(buf, filename);
  who ??= await loggedAs(app, 'owner', { mfa: true });
  return who.send('POST', I, m.payload as never, m.headers);
}

async function analyze(rows: Row[], filename?: string, who?: Awaited<ReturnType<typeof loggedAs>>) {
  const res = await upload(await sheet(rows), filename, who);
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().import.id as string;
  const detail = (await admin.get(`${I}/${id}?pageSize=200`)).json();
  return { id, imp: detail.import, rows: detail.rows as any[] };
}

async function allRows(id: string, filter = 'all') {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const r = (await admin.get(`${I}/${id}?pageSize=200&page=${page}&filter=${filter}`)).json();
    out.push(...r.rows);
    if (out.length >= r.total) return out;
  }
}

async function confirm(id: string, batchSize = 100) {
  for (let i = 0; i < 100; i++) {
    const res = await admin.post(`${I}/${id}/process`, { batchSize });
    expect(res.statusCode, res.body).toBe(200);
    if (res.json().progress.done) return res.json();
  }
  throw new Error('importacao nao terminou');
}

const productCount = async () => Number((await owner.query('SELECT count(*) FROM products')).rows[0].count);

describe('SKU automático', () => {
  it('gera SKU legível, determinístico e sem acento a partir do nome', () => {
    expect(skuBase('Copo Descartável 300ml')).toBe('COP-DES-300ML');
    expect(skuBase('Caixa para Bolo Nº 4')).toBe('CX-BOLO-N4');
    expect(skuBase('Forma de Papel Nº 5')).toBe('FOR-PAP-N5');
    expect(skuBase('Copo Descartável 300ml')).toBe(skuBase('copo descartavel 300 ML'));
    expect(skuBase('Saco Plástico 20 x 30 cm')).toBe('SAC-PLA-20X30CM');
    expect(skuBase('Pão de Mel N° 2 c/ Fita')).toBe('PAO-MEL-N2-FIT');
    expect(skuBase('★★★')).toBe('PROD');
    for (const n of ['Embalagem Ãéíõç & Cia <script>', 'Bandeja Isopor 1,5 L Grande Retangular Branca']) {
      expect(skuBase(n)).toMatch(/^[A-Z0-9][A-Z0-9.-]{1,39}$/);
    }
  });

  it('colisão ganha sufixo -02, -03', () => {
    expect(allocateSku('COP-DES-300ML', new Set())).toBe('COP-DES-300ML');
    expect(allocateSku('COP-DES-300ML', new Set(['COP-DES-300ML']))).toBe('COP-DES-300ML-02');
    expect(allocateSku('COP-DES-300ML', new Set(['COP-DES-300ML', 'COP-DES-300ML-02']))).toBe('COP-DES-300ML-03');
  });

  it('nomes semelhantes, mas tamanhos diferentes não são duplicados', () => {
    const a = nameKey('Copo Descartável 300ml Transparente');
    expect(nameSimilarity(a, nameKey('Copo 300 ML Descartável Cristal'))).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity(a, nameKey('Copo Descartável 200ml Transparente'))).toBe(0);
    expect(nameSimilarity(nameKey('Caixa para Bolo Nº 4'), nameKey('Caixa para Bolo N° 5'))).toBe(0);
    expect(nameSimilarity(nameKey('Caixa para Bolo Nº 4'), nameKey('caixa bolo n4'))).toBe(1);
  });
});

describe('modelo e permissões', () => {
  it('baixa o modelo oficial com cabeçalhos, exemplo, listas e instruções', async () => {
    const res = await admin.get(`${I}/template.xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Produtos', 'Instruções', 'Listas']);
    const ws = wb.getWorksheet('Produtos')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Nome do produto *');
    expect(String(ws.getRow(2).getCell(1).value)).toMatch(/^Exemplo:/);
    const lists = wb.getWorksheet('Listas')!;
    expect(lists.getColumn(1).values).toContain('Descartáveis');
    expect(lists.getColumn(3).values).toContain('UN - Unidade');
    const xml = await (await JSZip.loadAsync(res.rawPayload)).file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toContain('<dataValidation');
    // O modelo sem dados nao vira produto.
    expect((await upload(res.rawPayload)).json().error.code).toBe('EMPTY_SHEET');
  });

  it('só quem tem permissão de importar (com MFA) acessa', async () => {
    const buf = await sheet([valid()]);
    const sales = await loggedAs(app, 'sales');
    expect((await upload(buf, 'a.xlsx', sales)).statusCode).toBe(403);
    expect((await sales.get(`${I}/template.xlsx`)).statusCode).toBe(403);
    const stock = await loggedAs(app, 'stock', { mfa: true });
    expect((await upload(buf, 'a.xlsx', stock)).statusCode).toBe(403);
    const managerNoMfa = await loggedAs(app, 'manager');
    expect((await upload(buf, 'a.xlsx', managerNoMfa)).json().error.code).toBe('MFA_REQUIRED');
    const anon = (await app.inject({ method: 'GET', url: I })).statusCode;
    expect(anon).toBe(401);
    const manager = await loggedAs(app, 'manager', { mfa: true });
    expect((await upload(buf, 'a.xlsx', manager)).statusCode).toBe(201);
  });
});

describe('arquivo', () => {
  it('recusa coluna obrigatória ausente', async () => {
    const headers = HEADERS.filter((h) => !h.startsWith('Preço de venda'));
    const res = await upload(await sheet([valid()], { headers }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('MISSING_COLUMNS');
    expect(res.json().error.details.missing).toEqual(['Preço de venda']);
  });

  it('recusa arquivo corrompido e extensão falsa, conferindo o conteúdo real', async () => {
    const good = await sheet([valid()]);
    expect((await upload(Buffer.from('isto não é uma planilha'), 'x.xlsx')).json().error.code).toBe('INVALID_FILE');
    expect((await upload(good.subarray(0, Math.floor(good.length / 2)), 'cortado.xlsx')).json().error.code).toBe('INVALID_FILE');
    expect((await upload(good, 'produtos.csv')).json().error.code).toBe('INVALID_EXTENSION');
    expect((await upload(good, 'produtos.xlsm')).json().error.code).toBe('INVALID_EXTENSION');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect((await upload(png, 'foto.xlsx')).json().error.code).toBe('INVALID_FILE');
    // ZIP de verdade, mas sem estrutura de planilha.
    const zip = new JSZip();
    zip.file('leia.txt', 'oi');
    expect((await upload(await zip.generateAsync({ type: 'nodebuffer' }), 'z.xlsx')).json().error.code).toBe('INVALID_FILE');
  });

  it('recusa macros e objetos incorporados', async () => {
    const z = await JSZip.loadAsync(await sheet([valid()]));
    z.file('xl/vbaProject.bin', Buffer.from('macro'));
    expect((await upload(await z.generateAsync({ type: 'nodebuffer' }))).json().error.code).toBe('MACRO_NOT_ALLOWED');
    const e = await JSZip.loadAsync(await sheet([valid()]));
    e.file('xl/embeddings/oleObject1.bin', Buffer.from('x'));
    expect((await upload(await e.generateAsync({ type: 'nodebuffer' }))).json().error.code).toBe('EMBEDDED_NOT_ALLOWED');
  });

  it('nunca executa fórmulas: o conteúdo é descartado e a linha aponta o campo', async () => {
    const { rows } = await analyze([
      valid({ name: 'Prato Raso 18cm Branco', price: { formula: '10+2.5', result: 12.5 } }),
      valid({ name: '=HYPERLINK("http://exemplo.invalid","clique")' }),
      valid({ name: 'Talher Kit 3 peças', description: '@SUM(1+1)' }),
    ]);
    expect(rows[0].status).toBe('error');
    expect(rows[0].raw.price).toBeUndefined();
    expect(rows[0].issues.some((i: any) => i.field === 'price' && /fórmula/.test(i.message))).toBe(true);
    expect(rows[1].raw.name).toBeUndefined();
    expect(rows[1].formula_fields).toContain('name');
    expect(rows[2].formula_fields).toContain('description');
    expect(await productCount()).toBe(0);
  });
});

describe('análise e importação', () => {
  it('1 produto válido: prévia com SKU gerado, nada criado antes de confirmar', async () => {
    const before = await productCount();
    const { id, imp, rows } = await analyze([valid({ name: 'Copo Descartável 300ml', stock: '40', cost: '8,20', minStock: '10', weight: '350', length: '30', width: '20', height: '15,5', material: 'PP', color: 'Transparente', capacity: '300 ml', unitsPerPack: '50', applications: 'Bebidas frias', brand: 'Marca X', ean: '7891234567895' })]);
    expect(imp.totals).toMatchObject({ rows: 1, new: 1, error: 0 });
    expect(rows[0].sku).toBe('COP-DES-300ML');
    expect(rows[0].sku_generated).toBe(true);
    expect(await productCount()).toBe(before);

    const done = await confirm(id);
    expect(done.import.results).toMatchObject({ imported: 1, failed: 0, withoutImage: 1 });
    const row = (await admin.get(`${I}/${id}`)).json().rows[0];
    expect(row.result).toBe('imported');
    expect(row.without_image).toBe(true);
    // Visivel no cadastro individual.
    const product = (await admin.get(`${P}/${row.product_id}`)).json().product;
    expect(product).toMatchObject({ name: 'Copo Descartável 300ml', status: 'active', base_unit: 'PCT', category_id: copId, brand: 'Marca X', min_stock: '10.000' });
    expect(product.variants[0]).toMatchObject({ sku: 'COP-DES-300ML', barcode: '7891234567895', weight_g: 350, length_mm: 300, width_mm: 200, height_mm: 155 });
    expect(product.variants[0].packagings[0]).toMatchObject({ kind: 'sale', label: 'Pacote com 50', unit_code: 'PCT', price_cents: '1250', is_default: true });
    expect(product.specs).toEqual(expect.arrayContaining([{ label: 'Material', value: 'PP' }, { label: 'Unidades por embalagem', value: '50' }]));
    // Estoque pelo mecanismo de movimentacao existente, com o custo.
    const mv = await owner.query('SELECT kind, on_hand_delta, unit_cost_cents, request_key FROM stock_movements WHERE variant_id = $1', [product.variants[0].id]);
    expect(mv.rows).toEqual([{ kind: 'adjustment', on_hand_delta: '40.000', unit_cost_cents: '820.0000', request_key: `import-${id}-3` }]);
    const actions = (await owner.query('SELECT action FROM audit_logs WHERE entity_id = $1 OR entity_id = $2', [id, row.product_id])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['product_imports.analyzed', 'product_imports.confirmed', 'product_imports.finished', 'products.imported']));

    // Relatorio e historico.
    const rep = await admin.get(`${I}/${id}/report.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rep.rawPayload as never);
    const res = wb.getWorksheet('Resultado')!;
    expect(res.getRow(2).getCell(3).value).toBe('COP-DES-300ML');
    expect(res.getRow(2).getCell(7).value).toBe('Cadastrado');
    expect(res.getRow(2).getCell(9).value).toBe('Sem imagem');
    const hist = (await admin.get(I)).json().imports.find((x: any) => x.id === id);
    expect(hist).toMatchObject({ status: 'done', file_name: 'produtos.xlsx', created_by_name: expect.any(String), results: { imported: 1 } });
  });

  it('SKU duplicado e EAN duplicado: já existe, não cadastra; repetidos na planilha viram erro', async () => {
    const existing = (await admin.post(P, productPayload({ name: 'Bandeja Laminada 25cm', categoryId: rootId }))).json().product;
    const sku = existing.variants[0].sku as string;
    await owner.query(`UPDATE product_variants SET barcode = '7896543210982' WHERE id = $1`, [existing.variants[0].id]);
    const version = existing.version;
    const { id, rows } = await analyze([
      valid({ name: 'Tampa Copo 300ml', sku }),
      valid({ name: 'Tampa Copo 500ml', ean: '7896543210982' }),
      valid({ name: 'Canudo Flexível 6mm', sku: 'CAN-NOVO-1' }),
      valid({ name: 'Canudo Flexível 8mm', sku: 'can-novo-1' }),
      valid({ name: 'Colher Sobremesa 12cm', ean: '7891234567802' }),
      valid({ name: 'Colher Sopa 15cm', ean: '7891234567802' }),
      valid({ name: 'Colher Chá 10cm', ean: '7891234567803' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['existing', 'existing', 'new', 'error', 'new', 'error', 'error']);
    expect(rows[0].matches[0].message).toContain(sku);
    expect(rows[5].issues[0].message).toContain('linha 7');
    expect(rows[6].issues[0]).toMatchObject({ field: 'ean', level: 'error' }); // digito verificador errado
    await confirm(id);
    const after = (await admin.get(`${P}/${existing.id}`)).json().product;
    expect(after.version).toBe(version);
    expect((await owner.query(`SELECT count(*)::int AS n FROM products WHERE name LIKE 'Tampa Copo%'`)).rows[0].n).toBe(0);
  });

  it('preço inválido e campos ausentes, com correção na própria tela', async () => {
    const { id, imp, rows } = await analyze([valid({ name: 'Prato Fundo 21cm', price: 'doze reais' }), valid({ name: 'Prato Fundo 23cm', price: '-5' }), valid({ name: 'Prato Fundo 15cm', price: '1,999' }), valid({ name: 'Prato Fundo 25cm', description: null, status: 'talvez' })]);
    expect(rows.map((r) => r.status)).toEqual(['error', 'error', 'error', 'incomplete']);
    expect(imp.totals).toMatchObject({ error: 3, incomplete: 1 });
    expect(rows[0].issues[0]).toMatchObject({ field: 'price' });
    const fixed = (await admin.patch(`${I}/${id}/rows/3`, { values: { price: 'R$ 1.234,50' } })).json();
    expect(fixed.row.status).toBe('new');
    expect(fixed.row.data.priceCents).toBe(123450);
    expect(fixed.totals.error).toBe(2);
    expect((await admin.patch(`${I}/${id}/rows/4`, { values: { price: '=1+1' } })).json().error.code).toBe('FORMULA_NOT_ALLOWED');
    const done = await confirm(id);
    expect(done.import.results).toMatchObject({ imported: 1, skipped: 3 });
    expect((await admin.patch(`${I}/${id}/rows/4`, { values: { price: '5' } })).json().error.code).toBe('IMPORT_LOCKED');
  });

  it('nome semelhante vai para conferência; tamanho diferente não é duplicado; aprovar cadastra sem alterar o existente', async () => {
    const { id, rows } = await analyze([
      valid({ name: 'Copo 300 ML Descartável Cristal' }),
      valid({ name: 'Copo Descartável 200ml Transparente' }),
      valid({ name: 'Copo Descartável 200ml Transparente' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['duplicate', 'new', 'duplicate']);
    expect(rows[0].matches[0]).toMatchObject({ kind: 'name', name: 'Copo Descartável 300ml' });
    expect(rows[2].matches[0]).toMatchObject({ kind: 'name', row: 4 });
    expect(rows[0].sku).toBe('COP-300ML-DES-CRI');
    const review = (await admin.get(`${I}/${id}?filter=review`)).json();
    expect(review.total).toBe(2);
    expect((await admin.patch(`${I}/${id}/rows/3`, { decision: 'approve' })).json().row.status).toBe('new');
    expect((await admin.patch(`${I}/${id}/rows/5`, { decision: 'skip' })).json().row.status).toBe('duplicate');
    const done = await confirm(id);
    expect(done.import.results).toMatchObject({ imported: 2, skipped: 1 });
    const imported = await allRows(id, 'imported');
    expect(imported.map((r) => r.sku).sort()).toEqual(['COP-300ML-DES-CRI', 'COP-DES-200ML-TRA']);
  });

  it('categoria inexistente: aparece na prévia, o admin autoriza, e não duplica por acento ou maiúsculas', async () => {
    const { id, imp, rows } = await analyze([
      valid({ name: 'Forma de Papel Nº 5', category: 'Confeitaria', subcategory: 'Forminhas' }),
      valid({ name: 'Forma de Papel Nº 6', category: '  confeitaria ', subcategory: 'FORMINHAS' }),
      valid({ name: 'Forma de Papel Nº 7', category: 'Descartaveis', subcategory: 'copos' }),
      valid({ name: 'Forma de Papel Nº 8', category: 'Descartáveis', subcategory: 'Talheres' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['category', 'category', 'new', 'category']);
    expect(rows[2].data.categoryId).toBe(copId);
    expect(imp.pending_categories).toHaveLength(2);
    const conf = imp.pending_categories.find((p: any) => p.category === 'Confeitaria');
    expect(conf.rows).toBe(2);
    const tal = imp.pending_categories.find((p: any) => p.subcategory === 'Talheres');
    expect(tal.parentId).toBe(rootId);
    // Sem decisao, nada de categoria nova; com decisao, cria uma vez so.
    const res = (await admin.put(`${I}/${id}/categories`, { decisions: { [conf.key]: { action: 'create' }, [tal.key]: { action: 'map', categoryId: copId } } })).json();
    expect(res.totals).toMatchObject({ category: 0, new: 4 });
    expect((await owner.query(`SELECT count(*)::int AS n FROM categories WHERE name ILIKE 'confeitaria'`)).rows[0].n).toBe(0);
    await confirm(id);
    const cats = (await owner.query(`SELECT c.name, p.name AS parent FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE search_text(c.name) IN ('confeitaria', 'forminhas')`)).rows;
    expect(cats).toEqual(expect.arrayContaining([{ name: 'Confeitaria', parent: null }, { name: 'Forminhas', parent: 'Confeitaria' }]));
    expect(cats).toHaveLength(2);
    const skus = (await allRows(id, 'imported')).map((r) => r.sku);
    expect(skus).toEqual(['FOR-PAP-N5', 'FOR-PAP-N6', 'FOR-PAP-N7', 'FOR-PAP-N8']);
    // Segunda planilha com "CONFEITÁRIA": usa a existente.
    const again = await analyze([valid({ name: 'Forma de Papel Nº 9', category: 'CONFEITÁRIA', subcategory: 'forminhas ' })]);
    expect(again.rows[0].status).toBe('new');
  });

  it('acentos e caracteres especiais são normalizados e sanitizados', async () => {
    const { rows } = await analyze([valid({ name: 'Caixa  para Bolo Nº 4 <b>Café</b>\u0007 & Cia', description: 'Linha 1\r\nLinha 2 <script>alert(1)</script>', unit: 'unidade', status: 'inativo', category: 'DESCARTÁVEIS', subcategory: 'Côpos' })]);
    expect(rows[0].raw.name).toBe('Caixa para Bolo Nº 4 Café & Cia');
    expect(rows[0].raw.description).toBe('Linha 1\nLinha 2 alert(1)');
    expect(rows[0].sku).toBe('CX-BOLO-N4-CAF');
    expect(rows[0].data).toMatchObject({ unit: 'UN', status: 'inactive', categoryId: copId });
  });

  it('100 produtos', async () => {
    const before = await productCount();
    const list = Array.from({ length: 100 }, (_, i) => valid({ name: `Pote Redondo ${i + 1}0ml`, stock: String(i + 1) }));
    const { id, imp } = await analyze(list);
    expect(imp.totals).toMatchObject({ rows: 100, new: 100 });
    const done = await confirm(id, 25);
    expect(done.import.results.imported).toBe(100);
    expect(await productCount()).toBe(before + 100);
    const skus = (await allRows(id)).map((r) => r.sku);
    expect(new Set(skus).size).toBe(100);
    expect((await owner.query(`SELECT count(*)::int AS n FROM stock_movements WHERE source_id = $1`, [id])).rows[0].n).toBe(100);
  });

  it('1.000 produtos', { timeout: 240_000 }, async () => {
    const before = await productCount();
    const list = Array.from({ length: 1000 }, (_, i) => valid({ name: `Saco Kraft ${i + 1} x ${i + 31} cm`, category: 'Sacos', subcategory: null, price: `${(i % 90) + 1},90`, ean: undefined }));
    const { id, imp } = await analyze(list, 'mil.xlsx');
    expect(imp.totals).toMatchObject({ rows: 1000, category: 1000 });
    const key = imp.pending_categories[0].key;
    expect((await admin.put(`${I}/${id}/categories`, { decisions: { [key]: { action: 'create' } } })).json().totals.new).toBe(1000);
    const done = await confirm(id, 200);
    expect(done.import.results).toMatchObject({ imported: 1000, failed: 0 });
    expect(await productCount()).toBe(before + 1000);
    expect((await owner.query(`SELECT count(*)::int AS n FROM categories WHERE name = 'Sacos'`)).rows[0].n).toBe(1);
    // Todos completos: variacao, embalagem de venda e registro fiscal.
    const incomplete = await owner.query(
      `SELECT count(*)::int AS n FROM product_import_rows r WHERE r.import_id = $1 AND NOT EXISTS (
         SELECT 1 FROM product_variants v JOIN packagings k ON k.variant_id = v.id JOIN product_fiscal f ON f.product_id = v.product_id WHERE v.product_id = r.product_id AND k.kind = 'sale')`,
      [id],
    );
    expect(incomplete.rows[0].n).toBe(0);
  });

  it('interrupção no meio: o lote volta inteiro e a importação continua sem duplicar', async () => {
    const list = Array.from({ length: 30 }, (_, i) => valid({ name: `Bandeja Isopor ${i + 1}cm`, stock: '5' }));
    const { id } = await analyze(list);
    let calls = 0;
    importHooks.beforeRow = (row) => {
      calls++;
      if (row === 25) throw new Error('queda simulada');
    };
    try {
      expect((await admin.post(`${I}/${id}/process`, { batchSize: 10 })).statusCode).toBe(200);
      expect((await admin.post(`${I}/${id}/process`, { batchSize: 10 })).statusCode).toBe(200);
      expect((await admin.post(`${I}/${id}/process`, { batchSize: 10 })).statusCode).toBe(500);
    } finally {
      importHooks.beforeRow = undefined;
    }
    expect(calls).toBe(23);
    const mid = (await admin.get(`${I}/${id}`)).json().import;
    expect(mid.status).toBe('importing');
    expect(mid.results).toMatchObject({ imported: 20, pending: 10 });
    const made = await owner.query(`SELECT count(*)::int AS n FROM products WHERE name LIKE 'Bandeja Isopor %'`);
    expect(made.rows[0].n).toBe(20);
    const orphans = await owner.query(`SELECT count(*)::int AS n FROM products p WHERE p.name LIKE 'Bandeja Isopor %' AND NOT EXISTS (SELECT 1 FROM product_variants v JOIN packagings k ON k.variant_id = v.id WHERE v.product_id = p.id)`);
    expect(orphans.rows[0].n).toBe(0);
    const done = await confirm(id, 10);
    expect(done.import.results).toMatchObject({ imported: 30, pending: 0 });
    expect((await owner.query(`SELECT count(*)::int AS n FROM products WHERE name LIKE 'Bandeja Isopor %'`)).rows[0].n).toBe(30);
    expect((await owner.query(`SELECT count(*)::int AS n FROM stock_movements WHERE source_id = $1`, [id])).rows[0].n).toBe(30);
  });

  it('reenvio do mesmo arquivo: avisa e não cadastra de novo', async () => {
    const buf = await sheet([valid({ name: 'Guardanapo Folha Dupla 30cm', sku: 'GUA-REENVIO' }), valid({ name: 'Guardanapo Folha Simples 20cm' })]);
    const first = (await upload(buf, 'guardanapos.xlsx')).json().import.id;
    await confirm(first);
    const second = await upload(buf, 'guardanapos.xlsx');
    const imp = second.json().import;
    expect(imp.warnings[0]).toMatch(/já foi importado/);
    const rows = await allRows(imp.id);
    expect(rows.map((r) => r.status)).toEqual(['existing', 'duplicate']);
    const done = await confirm(imp.id);
    expect(done.import.results).toMatchObject({ imported: 0, skipped: 2 });
    expect((await owner.query(`SELECT count(*)::int AS n FROM products WHERE name LIKE 'Guardanapo Folha%'`)).rows[0].n).toBe(2);
  });

  it('SKU único mesmo com duas importações confirmadas ao mesmo tempo', async () => {
    // Mesma base de SKU (POT-SOR-RED), nomes diferentes o bastante para nao serem duplicados.
    const a = await analyze([valid({ name: 'Pote Sorvete Redondo Liso' })], 'a.xlsx');
    const b = await analyze([valid({ name: 'Pote Sorvete Redondo Decorado Colorido Grande' })], 'b.xlsx');
    expect([a.rows[0].sku, b.rows[0].sku]).toEqual(['POT-SOR-RED', 'POT-SOR-RED']);
    const [ra, rb] = await Promise.all([admin.post(`${I}/${a.id}/process`, {}), admin.post(`${I}/${b.id}/process`, {})]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    const skus = (await owner.query(`SELECT v.sku::text AS sku FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.name LIKE 'Pote Sorvete Redondo%' ORDER BY 1`)).rows.map((r) => r.sku);
    expect(skus).toEqual(['POT-SOR-RED', 'POT-SOR-RED-02']);
  });

  it('SKU previsto tomado depois da análise: nova tentativa com o próximo sufixo', async () => {
    const { id, rows } = await analyze([valid({ name: 'Caixa para Torta Nº 3' })]);
    expect(rows[0].sku).toBe('CX-TOR-N3');
    // Outro cadastro pega o SKU previsto no meio do lote, depois da conferencia da confirmacao.
    const other = (await admin.post(P, productPayload({ name: 'Caixa genérica', categoryId: rootId }))).json().product;
    importHooks.beforeRow = async () => {
      await owner.query(`UPDATE product_variants SET sku = 'CX-TOR-N3' WHERE id = $1`, [other.variants[0].id]);
    };
    try {
      await confirm(id);
    } finally {
      importHooks.beforeRow = undefined;
    }
    const row = (await allRows(id))[0];
    expect(row).toMatchObject({ result: 'imported', sku: 'CX-TOR-N3-02' });
    expect(row.result_reason).toContain('foi usado por outro cadastro');
  });

  it('a importação não altera usuários, permissões nem configurações', async () => {
    const snap = async () =>
      (await owner.query(`SELECT (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM users u) AS users, (SELECT md5(coalesce(string_agg(p::text, ',' ORDER BY user_id, permission), '')) FROM user_permissions p) AS perms, (SELECT md5(string_agg(s::text, ',')) FROM store_settings s) AS settings`)).rows[0];
    const before = await snap();
    const { id } = await analyze([valid({ name: 'Palito Bambu 20cm' })], undefined, admin);
    await confirm(id);
    expect(await snap()).toEqual(before);
    const actions = (await owner.query(`SELECT DISTINCT action FROM audit_logs WHERE metadata->>'importId' = $1 OR entity_id = $1`, [id])).rows.map((r) => r.action).sort();
    expect(actions.every((a: string) => /^(products|categories|product_imports)\./.test(a))).toBe(true);
  });

  it('localiza produtos por SKU para o envio de imagens em lote', async () => {
    const res = (await admin.post(`${I}/image-targets`, { skus: ['cop-des-300ml', 'NAO-EXISTE'] })).json();
    expect(res.targets).toEqual([expect.objectContaining({ sku: 'COP-DES-300ML', image_count: 0 })]);
  });
});
