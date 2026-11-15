// SKU automatico (docs/14-importacao-produtos.md, secao "SKU automatico").
// Gerado uma unica vez, no backend, a partir do nome: sem acento, maiusculo, legivel e deterministico.
// Depois de gravado e permanente: mudar o nome do produto nao gera outro SKU.
// A unicidade final e da restricao product_variants_sku_key (citext UNIQUE).

/** Palavras que nao entram no SKU. */
const STOPWORDS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'PARA', 'P', 'COM', 'C', 'E', 'EM', 'A', 'O', 'AS', 'OS', 'NA', 'NO', 'NAS', 'NOS', 'POR', 'SEM', 'UM', 'UMA']);

/** Abreviacoes fixas. O resto vira as 3 primeiras letras. */
const ABBREVIATIONS: Record<string, string> = {
  CAIXA: 'CX',
  CAIXAS: 'CX',
  BOLO: 'BOLO',
  BOLOS: 'BOLO',
  DOCE: 'DOCE',
  DOCES: 'DOCE',
};

/** Unidades de medida que se juntam ao numero: "300 ml" vira 300ML. */
const MEASURE_UNITS = ['ML', 'LT', 'L', 'KG', 'MG', 'GR', 'G', 'CM', 'MM', 'M', 'UN', 'UND', 'UNID', 'UNIDADES', 'FL', 'FLS', 'PCS', 'PC', 'MICRAS', 'MIC'];
const UNIT_ALIASES: Record<string, string> = { LT: 'L', GR: 'G', UND: 'UN', UNID: 'UN', UNIDADES: 'UN', FLS: 'FL', PCS: 'PC', MICRAS: 'MIC' };

export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
/** Base curta o bastante para caber o sufixo "-NNN" no limite de 40 caracteres. */
const MAX_BASE = 34;
const MAX_WORDS = 3;
const MAX_MEASURES = 3;

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Tokens do nome: palavras e medidas (numero com unidade, Nº, dimensoes). */
export function skuTokens(name: string): { text: string; measure: boolean }[] {
  let s = name.toUpperCase();
  // Numero de forma/caixa: Nº 4, N° 4, N.º 4, No. 4, Nr 4 -> N4. Feito antes de tirar os acentos (º viraria "o").
  s = s.replace(/\bN\s*\.?\s*[º°ªO]\s*\.?\s*(\d+)/g, ' N$1 ').replace(/\bNR\.?\s*(\d+)/g, ' N$1 ').replace(/[º°ª]/g, ' ');
  s = stripAccents(s);
  // Decimal com virgula vira ponto: 1,5 L -> 1.5L.
  s = s.replace(/(\d),(\d)/g, '$1.$2');
  // Dimensoes: 10 x 15 x 5 cm -> 10X15X5CM.
  s = s.replace(/(\d)\s*[X×*]\s*(?=\d)/g, '$1X');
  const unitRe = new RegExp(`(\\d(?:[\\dX.]*\\d)?)\\s*(${MEASURE_UNITS.join('|')})\\b`, 'g');
  s = s.replace(unitRe, (_m, num: string, unit: string) => ` ${num}${UNIT_ALIASES[unit] ?? unit} `);
  const tokens = s.split(/[^A-Z0-9.]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter(Boolean);
  return tokens.map((t) => ({ text: t.replace(/\.(?!\d)/g, ''), measure: /\d/.test(t) })).filter((t) => t.text);
}

/**
 * Base do SKU: ate 3 palavras abreviadas (3 letras ou abreviacao fixa) e ate 3 medidas inteiras,
 * na ordem do nome. Ex.: "Copo Descartavel 300ml" -> COP-DES-300ML; "Caixa para Bolo Nº 4" -> CX-BOLO-N4.
 */
export function skuBase(name: string): string {
  const parts: string[] = [];
  let words = 0;
  let measures = 0;
  for (const t of skuTokens(name)) {
    if (t.measure) {
      if (measures >= MAX_MEASURES) continue;
      measures++;
      parts.push(t.text.slice(0, 14));
      continue;
    }
    if (STOPWORDS.has(t.text) || words >= MAX_WORDS) continue;
    words++;
    parts.push(ABBREVIATIONS[t.text] ?? t.text.slice(0, 3));
  }
  let base = '';
  for (const p of parts) {
    const next = base ? `${base}-${p}` : p;
    if (next.length > MAX_BASE) break;
    base = next;
  }
  // Nome so com simbolos ou curto demais: base generica, ainda deterministica.
  if (base.length < 2) base = base ? `${base}-PROD` : 'PROD';
  return base;
}

/** Primeiro SKU livre: a base, depois base-02, base-03... `taken` deve estar em maiusculas. */
export function allocateSku(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toUpperCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${String(i).padStart(2, '0')}`;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
  throw new Error(`sem SKU livre para ${base}`);
}

/** SKUs do banco que comecam pela base (para achar o proximo sufixo livre). */
export async function takenWithBase(db: { query: (sql: string, params: unknown[]) => Promise<{ rows: { sku: string }[] }> }, base: string) {
  const { rows } = await db.query(`SELECT upper(sku::text) AS sku FROM product_variants WHERE upper(sku::text) = $1 OR upper(sku::text) LIKE $2`, [
    base.toUpperCase(),
    `${base.toUpperCase().replace(/[\\%_]/g, '\\$&')}-%`,
  ]);
  return new Set(rows.map((r) => r.sku));
}
