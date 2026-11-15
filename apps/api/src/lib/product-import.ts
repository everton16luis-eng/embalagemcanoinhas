// Importacao de produtos por planilha .xlsx (docs/14-importacao-produtos.md).
// Este modulo le e analisa; nao grava nada. Quem grava e modules/product-imports.ts, so depois da confirmacao.
//
// Seguranca da leitura:
// - o arquivo precisa ser um ZIP/OOXML de verdade (assinatura e diretorio central conferidos antes do parser);
// - macros (vbaProject.bin), ActiveX, objetos incorporados e vinculos externos recusam o arquivo inteiro;
// - formulas nunca sao calculadas: o conteudo da celula e descartado e a linha aponta o campo;
// - texto que comeca com =, + ou @ e tratado como formula (injecao de formula ao reabrir no Excel);
// - caracteres de controle e marcacao HTML sao removidos.
import ExcelJS from 'exceljs';
import { isValidGtin } from './br.js';
import { AppError } from './errors.js';
import { allocateSku, SKU_PATTERN, skuBase } from './sku.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 2000;
const MAX_UNCOMPRESSED = 60 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
export const DATA_SHEET = 'Produtos';

export type FieldKey =
  | 'name' | 'description' | 'category' | 'subcategory' | 'price' | 'unit' | 'status'
  | 'sku' | 'brand' | 'ean' | 'cost' | 'stock' | 'minStock' | 'weight' | 'length' | 'width' | 'height'
  | 'material' | 'color' | 'capacity' | 'unitsPerPack' | 'applications';

type Column = { key: FieldKey; header: string; required: boolean; format: string; example: string; aliases: string[]; width: number; multiline?: boolean; max: number };

/**
 * Colunas do modelo oficial. Cada uma tem destino no cadastro atual (docs/14, tabela de campos).
 * Preco promocional, palavras-chave e observacoes internas nao tem campo no banco e nao entram no modelo.
 */
export const COLUMNS: Column[] = [
  { key: 'name', header: 'Nome do produto', required: true, format: 'Texto, 2 a 150 caracteres. Inclua tamanho ou capacidade.', example: 'Exemplo: Copo Descartável 300ml Transparente', aliases: ['nome', 'produto'], width: 42, max: 150 },
  { key: 'description', header: 'Descrição comercial', required: true, format: 'Texto que aparece na loja, até 10.000 caracteres.', example: 'Copo descartável resistente, ideal para festas e eventos.', aliases: ['descricao'], width: 50, multiline: true, max: 10000 },
  { key: 'category', header: 'Categoria', required: true, format: 'Escolha na lista. Categoria nova aparece na prévia para você autorizar.', example: 'Descartáveis', aliases: [], width: 24, max: 80 },
  { key: 'subcategory', header: 'Subcategoria', required: false, format: 'Opcional. Fica dentro da categoria.', example: 'Copos', aliases: [], width: 22, max: 80 },
  { key: 'price', header: 'Preço de venda', required: true, format: 'Em reais, por unidade de venda. Ex.: 12,50', example: '12,50', aliases: ['preco', 'preco venda', 'valor de venda'], width: 16, max: 30 },
  { key: 'unit', header: 'Unidade de venda', required: true, format: 'Escolha na lista (UN, PCT, CX...).', example: 'PCT - Pacote', aliases: ['unidade'], width: 20, max: 40 },
  { key: 'status', header: 'Status', required: true, format: 'Ativo ou Inativo.', example: 'Ativo', aliases: ['situacao', 'ativo/inativo'], width: 12, max: 20 },
  { key: 'sku', header: 'SKU', required: false, format: 'Opcional. Em branco, o sistema gera (ex.: COP-DES-300ML).', example: '', aliases: ['codigo interno', 'codigo'], width: 20, max: 40 },
  { key: 'brand', header: 'Marca', required: false, format: 'Texto, até 80 caracteres.', example: '', aliases: ['fabricante'], width: 18, max: 80 },
  { key: 'ean', header: 'EAN/GTIN', required: false, format: 'Código de barras com 8, 12, 13 ou 14 dígitos.', example: '', aliases: ['ean', 'gtin', 'codigo de barras', 'ean/gtin/codigo de barras'], width: 18, max: 20 },
  { key: 'cost', header: 'Custo', required: false, format: 'Em reais, por unidade de venda. Só é gravado junto com o estoque.', example: '8,20', aliases: ['custo unitario', 'preco de custo'], width: 12, max: 30 },
  { key: 'stock', header: 'Quantidade em estoque', required: false, format: 'Na unidade de venda. Em branco: o estoque não é lançado.', example: '40', aliases: ['estoque', 'quantidade', 'estoque atual'], width: 14, max: 30 },
  { key: 'minStock', header: 'Estoque mínimo', required: false, format: 'Na unidade de venda.', example: '10', aliases: ['estoque min'], width: 14, max: 30 },
  { key: 'weight', header: 'Peso (g)', required: false, format: 'Gramas da unidade de venda, número inteiro.', example: '350', aliases: ['peso', 'peso g', 'peso em gramas'], width: 10, max: 30 },
  { key: 'length', header: 'Comprimento (cm)', required: false, format: 'Centímetros, da embalagem de venda.', example: '30', aliases: ['comprimento'], width: 12, max: 30 },
  { key: 'width', header: 'Largura (cm)', required: false, format: 'Centímetros.', example: '20', aliases: ['largura'], width: 12, max: 30 },
  { key: 'height', header: 'Altura (cm)', required: false, format: 'Centímetros.', example: '15', aliases: ['altura'], width: 12, max: 30 },
  { key: 'material', header: 'Material', required: false, format: 'Vai para a ficha técnica.', example: 'Polipropileno (PP)', aliases: [], width: 16, max: 200 },
  { key: 'color', header: 'Cor', required: false, format: 'Vai para a ficha técnica.', example: 'Transparente', aliases: [], width: 14, max: 200 },
  { key: 'capacity', header: 'Capacidade', required: false, format: 'Vai para a ficha técnica. Ex.: 300 ml', example: '300 ml', aliases: [], width: 12, max: 200 },
  { key: 'unitsPerPack', header: 'Unidades por pacote', required: false, format: 'Quantas peças vêm em cada unidade de venda. Número inteiro.', example: '50', aliases: ['unidades por embalagem', 'qtd por pacote', 'quantidade por pacote'], width: 14, max: 30 },
  { key: 'applications', header: 'Aplicações e indicações de uso', required: false, format: 'Vai para a ficha técnica, até 200 caracteres.', example: 'Bebidas frias e quentes até 70 °C.', aliases: ['aplicacoes', 'indicacoes de uso', 'aplicacoes e indicacoes'], width: 36, max: 200 },
];

/** Colunas que planilhas costumam trazer mas que o cadastro nao tem onde guardar: ignoradas com aviso. */
const UNSUPPORTED_HEADERS: Record<string, string> = {
  'preco promocional': 'Preço promocional',
  'palavras-chave': 'Palavras-chave',
  'palavras chave': 'Palavras-chave',
  'observacoes internas': 'Observações internas',
  observacoes: 'Observações',
  imagem: 'Imagem',
  imagens: 'Imagens',
  foto: 'Foto',
};

export const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));
const REQUIRED = COLUMNS.filter((c) => c.required).map((c) => c.key);

/** Texto para comparar: sem acento, minusculo, espacos simples. */
export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const headerNorm = (s: string) => norm(s.replace(/\*/g, '').replace(/\([^)]*\)/g, ''));

const HEADER_MAP = new Map<string, FieldKey>();
for (const c of COLUMNS) for (const h of [c.header, ...c.aliases]) HEADER_MAP.set(headerNorm(h), c.key);

// ---------------------------------------------------------------------------------------------
// Conferencia do arquivo antes do parser

type ZipEntry = { name: string; size: number };

/** Le o diretorio central do ZIP sem descompactar: confere assinatura, quantidade e tamanho total. */
export function inspectZip(buf: Buffer): ZipEntry[] {
  const corrupt = () => new AppError(422, 'INVALID_FILE', 'O arquivo não é uma planilha .xlsx válida. Salve no Excel como "Pasta de Trabalho do Excel (.xlsx)" e envie de novo.');
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw corrupt();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > buf.length) throw corrupt();
  if (count > MAX_ZIP_ENTRIES) throw new AppError(422, 'INVALID_FILE', 'O arquivo tem partes demais para uma planilha de produtos.');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw corrupt();
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (size === 0xffffffff) throw corrupt();
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, size });
    total += size;
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (total > MAX_UNCOMPRESSED) throw new AppError(422, 'INVALID_FILE', 'O conteúdo descompactado da planilha é grande demais.');
  const names = entries.map((e) => e.name);
  if (!names.includes('[Content_Types].xml') || !names.some((n) => n === 'xl/workbook.xml')) throw corrupt();
  for (const n of names) {
    if (n.includes('..') || n.startsWith('/') || n.includes('\\')) throw corrupt();
    if (/vbaProject\.bin$/i.test(n) || /^xl\/activeX\//i.test(n)) throw new AppError(422, 'MACRO_NOT_ALLOWED', 'A planilha contém macros ou controles ActiveX. Salve como .xlsx comum (sem macros) e envie de novo.');
    if (/^xl\/embeddings\//i.test(n) || /\.(exe|dll|bat|cmd|com|scr|ps1|vbs|js|jar|msi)$/i.test(n)) throw new AppError(422, 'EMBEDDED_NOT_ALLOWED', 'A planilha contém arquivos ou objetos incorporados. Envie só os dados, sem objetos anexados.');
    if (/^xl\/externalLinks\//i.test(n)) throw new AppError(422, 'EXTERNAL_LINKS', 'A planilha tem vínculos com outros arquivos. Copie e cole como valores antes de enviar.');
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Leitura das celulas

/** Remove controle, marcacao e espacos sobrando. Descricao mantem as quebras de linha. */
export function sanitizeText(value: string, multiline = false) {
  let s = value.normalize('NFC').replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
  s = s.replace(/<\/?[a-z!?][^>]*>/gi, ' ');
  if (multiline) {
    s = s
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Texto que o Excel interpretaria como formula ao reabrir um relatorio. */
const looksLikeFormula = (s: string) => /^[=+@]/.test(s) || /^-\s*[=+@]/.test(s);

type CellRead = { text: string; formula: boolean };

function cellRead(value: ExcelJS.CellValue): CellRead {
  if (value === null || value === undefined) return { text: '', formula: false };
  if (typeof value === 'number') return { text: Number.isFinite(value) ? String(value).replace('.', ',') : '', formula: false };
  if (typeof value === 'boolean') return { text: value ? 'Sim' : 'Não', formula: false };
  if (typeof value === 'string') return { text: value, formula: false };
  if (value instanceof Date) return { text: value.toISOString().slice(0, 10), formula: false };
  const v = value as unknown as Record<string, unknown>;
  // Formula (simples, compartilhada ou matricial) e celula com erro: nada e calculado nem aproveitado.
  if ('formula' in v || 'sharedFormula' in v || 'error' in v) return { text: '', formula: true };
  if (Array.isArray(v.richText)) return { text: (v.richText as { text: string }[]).map((t) => t.text).join(''), formula: false };
  if ('text' in v) {
    const t = v.text as unknown;
    if (typeof t === 'string') return { text: t, formula: false };
    if (t && typeof t === 'object' && Array.isArray((t as { richText?: unknown }).richText)) return { text: ((t as { richText: { text: string }[] }).richText).map((x) => x.text).join(''), formula: false };
  }
  return { text: '', formula: false };
}

export type RawRow = { rowNumber: number; raw: Partial<Record<FieldKey, string>>; formulaFields: FieldKey[] };

export type ParsedFile = { rows: RawRow[]; warnings: string[] };

/** Le a aba de produtos. Recusa o arquivo se faltar coluna obrigatoria ou se for grande demais. */
export async function readProductSheet(buf: Buffer): Promise<ParsedFile> {
  inspectZip(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new AppError(422, 'INVALID_FILE', 'Não foi possível ler a planilha: o arquivo está corrompido ou não é .xlsx.');
  }
  const sheets = wb.worksheets.filter((w) => !['instrucoes', 'listas'].includes(norm(w.name)));
  const ws = wb.worksheets.find((w) => norm(w.name) === 'produtos') ?? sheets[0];
  if (!ws) throw new AppError(422, 'NO_SHEET', `A planilha não tem a aba "${DATA_SHEET}".`);

  const warnings: string[] = [];
  const columns = new Map<number, FieldKey>();
  const seen = new Set<FieldKey>();
  const header = ws.getRow(1);
  const lastCol = Math.min(ws.columnCount, 80);
  for (let c = 1; c <= lastCol; c++) {
    const read = cellRead(header.getCell(c).value);
    const text = sanitizeText(read.text);
    if (!text) continue;
    const h = headerNorm(text);
    const key = HEADER_MAP.get(h);
    if (key) {
      if (seen.has(key)) throw new AppError(422, 'DUPLICATE_COLUMN', `A coluna "${COLUMN_BY_KEY.get(key)!.header}" aparece mais de uma vez.`);
      seen.add(key);
      columns.set(c, key);
    } else if (UNSUPPORTED_HEADERS[h]) {
      warnings.push(`A coluna "${text.slice(0, 60)}" foi ignorada: o cadastro de produtos não tem esse campo.`);
    } else {
      warnings.push(`A coluna "${text.slice(0, 60)}" não faz parte do modelo e foi ignorada.`);
    }
  }
  const missing = REQUIRED.filter((k) => !seen.has(k));
  if (missing.length) {
    const names = missing.map((k) => COLUMN_BY_KEY.get(k)!.header);
    throw new AppError(422, 'MISSING_COLUMNS', `Faltam colunas obrigatórias: ${names.join(', ')}. Use o modelo oficial.`, { missing: names });
  }

  const rows: RawRow[] = [];
  const last = ws.actualRowCount ? ws.rowCount : 1;
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    const raw: Partial<Record<FieldKey, string>> = {};
    const formulaFields: FieldKey[] = [];
    let any = false;
    for (const [c, key] of columns) {
      const read = cellRead(row.getCell(c).value);
      const col = COLUMN_BY_KEY.get(key)!;
      let text = sanitizeText(read.text, col.multiline).slice(0, col.max + 1);
      let formula = read.formula;
      if (!formula && looksLikeFormula(text)) {
        formula = true;
        text = '';
      }
      if (formula) {
        formulaFields.push(key);
        any = true;
      }
      if (text) {
        raw[key] = text;
        any = true;
      }
    }
    if (!any) continue;
    // Linha 2 do modelo: orientacao, nunca vira produto.
    if (r === 2 && norm(raw.name ?? '').startsWith('exemplo')) continue;
    rows.push({ rowNumber: r, raw, formulaFields });
    if (rows.length > MAX_ROWS) throw new AppError(422, 'TOO_MANY_ROWS', `No máximo ${MAX_ROWS} produtos por arquivo. Divida a planilha em partes.`);
  }
  if (!rows.length) throw new AppError(422, 'EMPTY_SHEET', 'A planilha não tem produtos a partir da linha 3.');
  return { rows, warnings };
}

// ---------------------------------------------------------------------------------------------
// Conversao dos valores

/** Reais em centavos. Aceita 12,50 | 12.50 | R$ 1.234,56 | 1234. `decimals` limita as casas. */
export function parseMoney(input: string, decimals = 2): number | null {
  let t = input.replace(/R\$|\s/gi, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d+,\d+$/.test(t)) t = t.replace(',', '.');
  else if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [int, frac = ''] = t.split('.');
  if (frac.length > decimals || int!.length > 9) return null;
  // Centavos com ate (decimals - 2) casas: custo de um copo pode ser R$ 0,0437 (4,37 centavos).
  const cents = Number(`${int}${frac.padEnd(2, '0').slice(0, 2)}.${frac.slice(2) || '0'}`);
  return Number.isFinite(cents) ? cents : null;
}

/** Quantidade como texto com ponto decimal (ate 3 casas). "1.000" com 3 digitos apos o ponto vale mil. */
export function parseQty(input: string): string | null {
  let t = input.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,3})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(',', '.');
  if (!/^\d{1,11}(\.\d{1,3})?$/.test(t)) return null;
  return t.replace(/^0+(?=\d)/, '');
}

const isFraction = (v: string) => /\.\d*[1-9]/.test(v);

// ---------------------------------------------------------------------------------------------
// Nomes semelhantes

const NAME_STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'para', 'p', 'com', 'c', 'e', 'em', 'a', 'o', 'as', 'os', 'na', 'no', 'un', 'kit']);
/** Sinonimos frequentes em embalagens: escrever um ou outro nao torna o produto diferente. */
const SYNONYMS: Record<string, string> = { cristal: 'transparente', transp: 'transparente', incolor: 'transparente', desc: 'descartavel', descart: 'descartavel', pct: 'pacote', cx: 'caixa', emb: 'embalagem' };
const MEASURE_ALIASES: Record<string, string> = { lt: 'l', litro: 'l', litros: 'l', gr: 'g', grs: 'g', gramas: 'g', grama: 'g', und: 'un', unid: 'un', unidades: 'un', mililitros: 'ml', micras: 'mic' };

const singular = (w: string) => {
  if (w.length <= 3) return w;
  if (w.endsWith('eis')) return `${w.slice(0, -3)}el`;
  if (w.endsWith('oes') || w.endsWith('aes')) return `${w.slice(0, -3)}ao`;
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};

export type NameKey = { words: Set<string>; measures: Set<string>; exact: string };

/** Palavras e medidas do nome. "300 ML" e "300ml" viram a mesma medida; "Nº 4" vira n4. */
export function nameKey(name: string): NameKey {
  let s = name.toLowerCase().replace(/\bn\s*\.?\s*[º°ªo]\s*\.?\s*(\d+)/g, ' n$1 ');
  s = norm(s).replace(/(\d),(\d)/g, '$1.$2').replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1x');
  s = s.replace(/(\d(?:[\dx.]*\d)?)\s*(ml|lt|litros?|l|kg|mg|gr|grs|gramas?|g|cm|mm|m|und|unid|unidades|un|mililitros|micras|mic)\b/g, (_m, n: string, u: string) => ` ${n}${MEASURE_ALIASES[u] ?? u} `);
  const words = new Set<string>();
  const measures = new Set<string>();
  for (const t of s.split(/[^a-z0-9.]+/).map((x) => x.replace(/^\.+|\.+$/g, '')).filter(Boolean)) {
    if (/\d/.test(t)) measures.add(t);
    else if (!NAME_STOPWORDS.has(t)) {
      const w = singular(t);
      words.add(SYNONYMS[w] ?? w);
    }
  }
  return { words, measures, exact: [...words].sort().join(' ') + '|' + [...measures].sort().join(' ') };
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Semelhanca de 0 a 1 entre dois nomes. Medidas diferentes (300ml x 200ml, N4 x N5) nunca sao duplicados.
 * Uma medida de um lado so, sem a do outro, ainda pode ser o mesmo produto escrito de forma incompleta.
 */
export function nameSimilarity(a: NameKey, b: NameKey): number {
  if (a.measures.size && b.measures.size && !sameSet(a.measures, b.measures)) return 0;
  if (a.exact === b.exact) return 1;
  const all = new Set([...a.words, ...b.words]);
  if (!all.size) return 0;
  let common = 0;
  for (const w of a.words) if (b.words.has(w)) common++;
  return common / all.size;
}

export const SIMILARITY_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------------------------
// Analise das linhas

export type Issue = { field?: FieldKey; level: 'missing' | 'error' | 'warning'; message: string };
export type Match = { kind: 'sku' | 'ean' | 'name'; productId?: string; row?: number; name: string; sku?: string | null; score?: number; message: string };
export type CategoryDecision = { action: 'map'; categoryId: string } | { action: 'create' };
export type RowStatus = 'new' | 'existing' | 'duplicate' | 'error' | 'incomplete' | 'category';

export type RowData = {
  name: string;
  description: string;
  categoryId: string | null;
  categoryKey: string;
  categoryPath: string[];
  categoryCreate: boolean;
  priceCents: number;
  unit: string;
  packLabel: string;
  status: 'active' | 'inactive';
  sku: string | null;
  brand: string | null;
  ean: string | null;
  costCents: number | null;
  stockQty: string | null;
  minStock: string;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  specs: { label: string; value: string }[];
};

export type AnalyzedRow = {
  rowNumber: number;
  data: RowData | null;
  status: RowStatus;
  issues: Issue[];
  matches: Match[];
  categoryKey: string | null;
  sku: string | null;
  skuGenerated: boolean;
};

export type CategoryRow = { id: string; parent_id: string | null; name: string };

export type AnalysisContext = {
  units: Map<string, { name: string; allowsFraction: boolean }>;
  categories: CategoryRow[];
  decisions: Record<string, CategoryDecision>;
  existingSkus: Map<string, { productId: string; name: string }>;
  existingBarcodes: Map<string, { productId: string; name: string; sku: string | null }>;
  existingProducts: { id: string; name: string; sku: string | null }[];
};

export type PendingCategory = { key: string; category: string; subcategory: string | null; parentId: string | null; rows: number; decision: CategoryDecision | null };

export type Totals = { rows: number; new: number; existing: number; duplicate: number; error: number; incomplete: number; category: number; approved: number; skipped: number };

const UNIT_WORDS: Record<string, string> = { unidade: 'UN', unid: 'UN', und: 'UN', pacote: 'PCT', pct: 'PCT', pc: 'PCT', caixa: 'CX', fardo: 'FD', duzia: 'DZ', conjunto: 'CJ', jogo: 'CJ', kit: 'KIT', par: 'PAR', rolo: 'RL', folha: 'FL', quilo: 'KG', quilograma: 'KG', kg: 'KG', grama: 'G', litro: 'L', mililitro: 'ML', metro: 'M' };

function resolveUnit(input: string, units: AnalysisContext['units']): string | null {
  const code = input.split(/\s+[-–—]\s+/)[0]!.trim().toUpperCase();
  if (units.has(code)) return code;
  const n = norm(input);
  for (const [c, u] of units) if (norm(u.name) === n || norm(u.name) === singular(n)) return c;
  const word = UNIT_WORDS[singular(n)] ?? UNIT_WORDS[n];
  return word && units.has(word) ? word : null;
}

function resolveStatus(input: string): 'active' | 'inactive' | null {
  const n = norm(input);
  if (['ativo', 'ativa', 'active', 'sim', 's'].includes(n)) return 'active';
  if (['inativo', 'inativa', 'inactive', 'nao', 'n'].includes(n)) return 'inactive';
  return null;
}

export const categoryKey = (category: string, sub: string | null) => (sub ? `${norm(category)} > ${norm(sub)}` : norm(category));

/** Categoria existente pelo nome, sem diferenca de acento, maiusculas ou espacos. */
function findCategory(ctx: AnalysisContext, category: string, sub: string | null): { id: string | null; parentId: string | null } {
  const roots = ctx.categories.filter((c) => !c.parent_id && norm(c.name) === norm(category));
  let parent = roots[0];
  if (!parent && !sub) {
    // Nome de subcategoria informado como categoria: so vale se for unico na arvore.
    const any = ctx.categories.filter((c) => norm(c.name) === norm(category));
    if (any.length === 1) return { id: any[0]!.id, parentId: any[0]!.parent_id };
  }
  if (!parent) return { id: null, parentId: null };
  if (!sub) return { id: parent.id, parentId: null };
  const child = ctx.categories.find((c) => c.parent_id === parent!.id && norm(c.name) === norm(sub));
  return { id: child?.id ?? null, parentId: parent.id };
}

type RowInput = RawRow & { decision: 'approve' | 'skip' | null };

/** Converte e confere uma linha. Nao consulta o banco: tudo vem do contexto. */
function parseRow(row: RowInput, ctx: AnalysisContext): { data: RowData | null; issues: Issue[]; pending: PendingCategory | null } {
  const issues: Issue[] = [];
  const v = (k: FieldKey) => row.raw[k]?.trim() ?? '';
  const err = (field: FieldKey, message: string) => issues.push({ field, level: 'error', message });
  for (const f of row.formulaFields) issues.push({ field: f, level: 'error', message: `${COLUMN_BY_KEY.get(f)!.header}: a célula tinha fórmula ou erro e foi descartada. Digite o valor.` });
  for (const k of REQUIRED) if (!v(k) && !row.formulaFields.includes(k)) issues.push({ field: k, level: 'missing', message: `${COLUMN_BY_KEY.get(k)!.header} é obrigatório.` });
  for (const c of COLUMNS) if (v(c.key).length > c.max) err(c.key, `${c.header}: no máximo ${c.max} caracteres.`);

  const name = v('name');
  if (name && name.length < 2) err('name', 'Nome do produto: no mínimo 2 caracteres.');
  const unit = v('unit') ? resolveUnit(v('unit'), ctx.units) : null;
  if (v('unit') && !unit) err('unit', `Unidade "${v('unit')}" não existe. Use uma da lista (UN, PCT, CX...).`);
  const fraction = unit ? ctx.units.get(unit)!.allowsFraction : false;

  const priceCents = v('price') ? parseMoney(v('price')) : null;
  if (v('price') && (priceCents === null || !Number.isInteger(priceCents))) err('price', `Preço de venda inválido: "${v('price')}". Use reais com até 2 casas, ex.: 12,50.`);
  else if (priceCents !== null && (priceCents <= 0 || priceCents > 100_000_000)) err('price', 'Preço de venda deve ser maior que zero e até R$ 1.000.000,00.');

  const status = v('status') ? resolveStatus(v('status')) : null;
  if (v('status') && !status) err('status', `Status "${v('status')}" inválido. Use Ativo ou Inativo.`);

  let sku: string | null = null;
  if (v('sku')) {
    sku = v('sku').toUpperCase();
    if (!SKU_PATTERN.test(sku)) err('sku', 'SKU: 2 a 40 caracteres, letras, números, ponto, hífen ou sublinhado. Deixe em branco para o sistema gerar.');
  }
  let ean: string | null = null;
  if (v('ean')) {
    ean = v('ean').replace(/\s/g, '');
    if (!isValidGtin(ean)) err('ean', `EAN/GTIN inválido: "${v('ean')}". Confira os dígitos (8, 12, 13 ou 14, com dígito verificador).`);
  }

  const qtyField = (k: FieldKey, label: string) => {
    if (!v(k)) return null;
    const q = parseQty(v(k));
    if (q === null) return err(k, `${label} inválido: "${v(k)}".`), null;
    if (!fraction && isFraction(q)) return err(k, `${label}: a unidade ${unit ?? ''} não aceita fração.`), null;
    return q;
  };
  let stockQty = qtyField('stock', 'Quantidade em estoque');
  const minStock = qtyField('minStock', 'Estoque mínimo') ?? '0';
  let costCents: number | null = null;
  if (v('cost')) {
    costCents = parseMoney(v('cost'), 4);
    if (costCents === null || costCents <= 0) {
      err('cost', `Custo inválido: "${v('cost')}". Use reais, ex.: 8,20.`);
      costCents = null;
    } else if (!stockQty || Number(stockQty) === 0) {
      issues.push({ field: 'cost', level: 'warning', message: 'Custo sem quantidade em estoque não é gravado: o custo entra junto com a entrada de estoque.' });
      costCents = null;
    }
  }
  if (stockQty && Number(stockQty) === 0) stockQty = null;

  const intField = (k: FieldKey, label: string, max: number) => {
    if (!v(k)) return null;
    const q = parseQty(v(k));
    if (q === null || isFraction(q) || Number(q) <= 0 || Number(q) > max) return err(k, `${label} inválido: "${v(k)}". Use um número inteiro maior que zero.`), null;
    return Number(q);
  };
  const cmField = (k: FieldKey, label: string) => {
    if (!v(k)) return null;
    const q = parseQty(v(k));
    const mm = q === null ? NaN : Math.round(Number(q) * 10);
    if (!(mm >= 1 && mm <= 10_000)) return err(k, `${label} inválido: "${v(k)}". Use centímetros, até 1.000 cm.`), null;
    return mm;
  };
  const weightG = intField('weight', 'Peso', 1_000_000);
  const lengthMm = cmField('length', 'Comprimento');
  const widthMm = cmField('width', 'Largura');
  const heightMm = cmField('height', 'Altura');
  const unitsPerPack = intField('unitsPerPack', 'Unidades por pacote', 1_000_000);

  const specs: { label: string; value: string }[] = [];
  if (v('material')) specs.push({ label: 'Material', value: v('material') });
  if (v('color')) specs.push({ label: 'Cor', value: v('color') });
  if (v('capacity')) specs.push({ label: 'Capacidade', value: v('capacity') });
  if (unitsPerPack) specs.push({ label: 'Unidades por embalagem', value: String(unitsPerPack) });
  if (v('applications')) specs.push({ label: 'Aplicações e indicações de uso', value: v('applications') });

  // Categoria
  const category = v('category');
  const sub = v('subcategory') || null;
  let categoryId: string | null = null;
  let create = false;
  let pending: PendingCategory | null = null;
  const key = category ? categoryKey(category, sub) : '';
  if (category && (category.length < 2 || (sub && sub.length < 2))) err('category', 'Categoria e subcategoria: no mínimo 2 caracteres.');
  else if (category) {
    const found = findCategory(ctx, category, sub);
    const decision = ctx.decisions[key];
    if (found.id) categoryId = found.id;
    else if (decision?.action === 'map' && ctx.categories.some((c) => c.id === decision.categoryId)) categoryId = decision.categoryId;
    else if (decision?.action === 'create') create = true;
    else pending = { key, category, subcategory: sub, parentId: found.parentId, rows: 1, decision: decision ?? null };
  }

  const unitName = unit ? ctx.units.get(unit)!.name : '';
  const packLabel = (unitsPerPack && unitsPerPack > 1 ? `${unitName} com ${unitsPerPack}` : unitName).slice(0, 60);
  const blocking = issues.some((i) => i.level !== 'warning');
  const data: RowData | null = blocking
    ? null
    : {
        name,
        description: v('description'),
        categoryId,
        categoryKey: key,
        categoryPath: sub ? [category, sub] : [category],
        categoryCreate: create,
        priceCents: priceCents!,
        unit: unit!,
        packLabel,
        status: status!,
        sku,
        brand: v('brand') || null,
        ean,
        costCents,
        stockQty,
        minStock,
        weightG,
        lengthMm,
        widthMm,
        heightMm,
        specs,
      };
  return { data, issues, pending };
}

/**
 * Classifica todas as linhas juntas: precisa ver a planilha inteira para achar duplicados entre linhas
 * e para reservar os SKUs gerados sem colisao. Deterministico: mesma entrada, mesmo resultado.
 */
export function analyzeRows(rows: RowInput[], ctx: AnalysisContext): { rows: AnalyzedRow[]; totals: Totals; pendingCategories: PendingCategory[] } {
  const out: AnalyzedRow[] = [];
  const pendingMap = new Map<string, PendingCategory>();
  const sheetSkus = new Map<string, number>();
  const sheetEans = new Map<string, number>();
  // Indice de palavras para comparar nomes so com candidatos que dividem alguma palavra.
  const index = new Map<string, number[]>();
  const keys: { key: NameKey; productId?: string; row?: number; name: string; sku: string | null }[] = [];
  const addKey = (k: (typeof keys)[number]) => {
    const i = keys.push(k) - 1;
    for (const w of k.key.words) index.set(w, [...(index.get(w) ?? []), i]);
  };
  for (const p of ctx.existingProducts) addKey({ key: nameKey(p.name), productId: p.id, name: p.name, sku: p.sku });

  const informed = new Set<string>();
  for (const r of rows) if (r.raw.sku) informed.add(r.raw.sku.trim().toUpperCase());
  const taken = new Set<string>([...ctx.existingSkus.keys(), ...informed]);

  for (const row of rows) {
    const { data, issues, pending } = parseRow(row, ctx);
    const matches: Match[] = [];
    let status: RowStatus;
    if (issues.some((i) => i.level === 'missing')) status = 'incomplete';
    else if (issues.some((i) => i.level === 'error')) status = 'error';
    else status = 'new';

    if (data) {
      if (data.sku) {
        const hit = ctx.existingSkus.get(data.sku.toUpperCase());
        if (hit) matches.push({ kind: 'sku', productId: hit.productId, name: hit.name, sku: data.sku, message: `SKU ${data.sku} já cadastrado em "${hit.name}".` });
        const before = sheetSkus.get(data.sku.toUpperCase());
        if (before) issues.push({ field: 'sku', level: 'error', message: `SKU repetido na planilha (linha ${before}).` });
        else sheetSkus.set(data.sku.toUpperCase(), row.rowNumber);
      }
      if (data.ean) {
        const hit = ctx.existingBarcodes.get(data.ean);
        if (hit) matches.push({ kind: 'ean', productId: hit.productId, name: hit.name, sku: hit.sku, message: `EAN ${data.ean} já cadastrado em "${hit.name}".` });
        const before = sheetEans.get(data.ean);
        if (before) issues.push({ field: 'ean', level: 'error', message: `EAN repetido na planilha (linha ${before}).` });
        else sheetEans.set(data.ean, row.rowNumber);
      }
      if (issues.some((i) => i.level === 'error')) status = 'error';
      else if (matches.length) status = 'existing';
    }

    let key: NameKey | null = null;
    if (data && status === 'new') {
      key = nameKey(data.name);
      const candidates = new Set<number>();
      for (const w of key.words) for (const i of index.get(w) ?? []) candidates.add(i);
      const similar = [...candidates]
        .map((i) => ({ k: keys[i]!, score: nameSimilarity(key!, keys[i]!.key) }))
        .filter((x) => x.score >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score || (a.k.row ?? 0) - (b.k.row ?? 0))
        .slice(0, 3);
      for (const s of similar) {
        const where = s.k.row ? `na linha ${s.k.row} desta planilha` : 'no catálogo';
        matches.push({
          kind: 'name',
          productId: s.k.productId,
          row: s.k.row,
          name: s.k.name,
          sku: s.k.sku,
          score: Math.round(s.score * 100) / 100,
          message: s.score === 1 ? `Nome igual a "${s.k.name}" ${where}.` : `Nome parecido com "${s.k.name}" ${where}.`,
        });
      }
      if (similar.length && row.decision !== 'approve') status = 'duplicate';
    }
    if (status === 'new' && pending) {
      status = 'category';
      issues.push({ field: 'category', level: 'warning', message: `Categoria "${pending.subcategory ? `${pending.category} > ${pending.subcategory}` : pending.category}" não existe. Escolha uma existente ou autorize criar.` });
    }
    if (pending && data) {
      const p = pendingMap.get(pending.key);
      if (p) p.rows++;
      else pendingMap.set(pending.key, pending);
    }

    // SKU: o informado, ou o gerado do nome (so para quem pode ser cadastrado).
    let sku: string | null = data?.sku ?? null;
    let skuGenerated = false;
    if (data && !data.sku && ['new', 'duplicate', 'category'].includes(status)) {
      sku = allocateSku(skuBase(data.name), taken);
      taken.add(sku.toUpperCase());
      skuGenerated = true;
    }
    if (data && key && status !== 'existing') addKey({ key, row: row.rowNumber, name: data.name, sku });
    out.push({ rowNumber: row.rowNumber, data, status, issues, matches, categoryKey: data?.categoryKey || null, sku, skuGenerated });
  }

  const totals: Totals = { rows: out.length, new: 0, existing: 0, duplicate: 0, error: 0, incomplete: 0, category: 0, approved: 0, skipped: 0 };
  for (const r of out) totals[r.status]++;
  for (const [i, r] of rows.entries()) {
    const a = out[i]!;
    if (r.decision === 'approve' && a.matches.some((m) => m.kind === 'name') && a.status !== 'duplicate') totals.approved++;
    if (r.decision === 'skip' && a.status === 'duplicate') totals.skipped++;
  }
  return { rows: out, totals, pendingCategories: [...pendingMap.values()] };
}

// ---------------------------------------------------------------------------------------------
// Modelo oficial e relatorio

const XLSX_HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E3D' } };
const XLSX_REQUIRED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9C3D10' } };
const XLSX_EXAMPLE_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F0E8' } };
const TEMPLATE_ROWS = MAX_ROWS + 2;

/** Celula de texto do relatorio: nunca comeca com sinal que o Excel leria como formula. */
const safeCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return looksLikeFormula(s) ? `'${s}` : s;
};

export async function buildTemplate(opts: { categories: CategoryRow[]; units: { code: string; name: string; allows_fraction: boolean }[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Painel da loja';
  wb.created = new Date(0);
  const ws = wb.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 2, xSplit: 1 }] });
  const help = wb.addWorksheet('Instruções');
  const lists = wb.addWorksheet('Listas', { state: 'hidden' });

  ws.columns = COLUMNS.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 30;
  COLUMNS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = c.required ? XLSX_REQUIRED_FILL : XLSX_HEADER_FILL;
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.note = `${c.required ? 'Obrigatório. ' : ''}${c.format}`;
  });
  const example = ws.getRow(2);
  COLUMNS.forEach((c, i) => {
    const cell = example.getCell(i + 1);
    cell.value = c.example || (c.key === 'sku' ? '(em branco: gerado)' : '');
    cell.font = { italic: true, color: { argb: 'FF6B6B6B' } };
    cell.fill = XLSX_EXAMPLE_FILL;
  });
  // SKU e EAN como texto: o Excel nao corta zeros a esquerda nem usa notacao cientifica.
  for (const key of ['sku', 'ean'] as FieldKey[]) ws.getColumn(key).numFmt = '@';

  const roots = opts.categories.filter((c) => !c.parent_id).map((c) => c.name).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const subs = [...new Set(opts.categories.filter((c) => c.parent_id).map((c) => c.name))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const unitItems = opts.units.map((u) => `${u.code} - ${u.name}`);
  lists.getCell('A1').value = 'Categorias';
  lists.getCell('B1').value = 'Subcategorias';
  lists.getCell('C1').value = 'Unidades';
  lists.getCell('D1').value = 'Status';
  roots.forEach((n, i) => (lists.getCell(`A${i + 2}`).value = n));
  subs.forEach((n, i) => (lists.getCell(`B${i + 2}`).value = n));
  unitItems.forEach((n, i) => (lists.getCell(`C${i + 2}`).value = n));
  ['Ativo', 'Inativo'].forEach((n, i) => (lists.getCell(`D${i + 2}`).value = n));

  const colLetter = (key: FieldKey) => ws.getColumn(key).letter;
  const range = (key: FieldKey) => `${colLetter(key)}3:${colLetter(key)}${TEMPLATE_ROWS}`;
  const dv = (ws as unknown as { dataValidations: { add: (ref: string, v: ExcelJS.DataValidation) => void } }).dataValidations;
  // Categoria nova e permitida (vai para a previa): a lista sugere, mas so avisa.
  if (roots.length) dv.add(range('category'), { type: 'list', allowBlank: true, formulae: [`Listas!$A$2:$A$${roots.length + 1}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Categoria nova', error: 'Esta categoria não existe. Na prévia você escolhe uma existente ou autoriza criar.' });
  if (subs.length) dv.add(range('subcategory'), { type: 'list', allowBlank: true, formulae: [`Listas!$B$2:$B$${subs.length + 1}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Subcategoria nova', error: 'Esta subcategoria não existe. Na prévia você decide.' });
  dv.add(range('unit'), { type: 'list', allowBlank: false, formulae: [`Listas!$C$2:$C$${unitItems.length + 1}`], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Unidade', error: 'Escolha uma unidade da lista.' });
  dv.add(range('status'), { type: 'list', allowBlank: false, formulae: ['Listas!$D$2:$D$3'], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Status', error: 'Use Ativo ou Inativo.' });

  help.columns = [{ width: 32 }, { width: 14 }, { width: 90 }];
  const title = help.addRow(['Como preencher a planilha de produtos']);
  title.font = { bold: true, size: 14 };
  for (const line of [
    'Preencha a aba "Produtos" a partir da linha 3. A linha 2 é só um exemplo e é ignorada enquanto o nome começar com "Exemplo:".',
    'Um produto por linha. Nada é cadastrado ao enviar: o painel mostra a prévia e só cadastra depois que você confirmar.',
    'Não use fórmulas: células com fórmula são descartadas. Copie e cole como valores.',
    'SKU em branco: o sistema gera a partir do nome (ex.: Copo Descartável 300ml → COP-DES-300ML). Se já existir, recebe -02, -03...',
    'SKU ou EAN que já existem no catálogo: a linha é ignorada (o produto existente nunca é alterado).',
    'Nome parecido com um produto existente vai para conferência. Tamanhos ou capacidades diferentes (200ml x 300ml) não contam como duplicado.',
    'Categoria que não existe aparece na prévia: você escolhe uma existente ou autoriza criar.',
    'Preço, custo, estoque, estoque mínimo e peso valem para a unidade de venda escolhida (ex.: o pacote).',
    'Estoque só é lançado quando a quantidade for informada; o custo entra junto com essa entrada.',
    'Imagens não vão na planilha. Depois da importação, envie as fotos pelo painel com o nome do arquivo igual ao SKU (ex.: COP-DES-300ML.jpg).',
    'Preço promocional, palavras-chave e observações internas não existem no cadastro atual e por isso não fazem parte do modelo.',
  ])
    help.addRow([line]).getCell(1).alignment = { wrapText: false };
  help.addRow([]);
  const colsHead = help.addRow(['Coluna', 'Obrigatória', 'Formato']);
  colsHead.font = { bold: true };
  for (const c of COLUMNS) help.addRow([c.header, c.required ? 'Sim' : 'Não', c.format]);
  help.addRow([]);
  help.addRow(['Unidades de venda']).font = { bold: true };
  for (const u of opts.units) help.addRow([`${u.code} - ${u.name}`, u.allows_fraction ? 'Aceita fração' : 'Só inteiros']);
  help.addRow([]);
  help.addRow(['Categorias cadastradas']).font = { bold: true };
  if (!opts.categories.length) help.addRow(['(nenhuma categoria cadastrada ainda)']);
  for (const r of opts.categories.filter((c) => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
    help.addRow([r.name]);
    for (const s of opts.categories.filter((c) => c.parent_id === r.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) help.addRow([`   ${r.name} > ${s.name}`]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type ReportRow = { row_number: number; name: string | null; sku: string | null; ean: string | null; category: string | null; status: string; result: string | null; reason: string | null; product_id: string | null; has_image: boolean };

const STATUS_LABEL: Record<string, string> = { new: 'Novo', existing: 'Já existe', duplicate: 'Possível duplicado', error: 'Com erro', incomplete: 'Incompleto', category: 'Categoria pendente' };
const RESULT_LABEL: Record<string, string> = { pending: 'Na fila', imported: 'Cadastrado', skipped: 'Ignorado', failed: 'Não cadastrado' };

export async function buildReport(meta: { fileName: string; createdAt: string; userName: string; status: string; totals: Record<string, number> }, rows: ReportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(0);
  const ws = wb.addWorksheet('Resultado', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Linha', key: 'row', width: 8 },
    { header: 'Produto', key: 'name', width: 44 },
    { header: 'SKU', key: 'sku', width: 22 },
    { header: 'EAN/GTIN', key: 'ean', width: 16 },
    { header: 'Categoria', key: 'category', width: 28 },
    { header: 'Análise', key: 'status', width: 20 },
    { header: 'Resultado', key: 'result', width: 16 },
    { header: 'Motivo', key: 'reason', width: 70 },
    { header: 'Imagem', key: 'image', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      row: r.row_number,
      name: safeCell(r.name),
      sku: safeCell(r.sku),
      ean: safeCell(r.ean),
      category: safeCell(r.category),
      status: STATUS_LABEL[r.status] ?? r.status,
      result: r.result ? (RESULT_LABEL[r.result] ?? r.result) : 'Não confirmado',
      reason: safeCell(r.reason),
      image: r.result === 'imported' ? (r.has_image ? 'Com imagem' : 'Sem imagem') : '',
    });
  }
  const summary = wb.addWorksheet('Resumo');
  summary.columns = [{ width: 28 }, { width: 50 }];
  summary.addRow(['Arquivo', safeCell(meta.fileName)]);
  summary.addRow(['Enviado em', meta.createdAt]);
  summary.addRow(['Usuário', safeCell(meta.userName)]);
  summary.addRow(['Situação', meta.status]);
  for (const [k, v] of Object.entries(meta.totals)) summary.addRow([k, v]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
