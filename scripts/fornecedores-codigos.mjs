#!/usr/bin/env node
// SGLog Fase 2: relatorio dos codigos do fornecedor (supplier_sku) antes da 0021. SO LEITURA.
// Uso: node scripts/fornecedores-codigos.mjs [--json]
// Conecta com o papel da aplicacao (loja_app), numa transacao READ ONLY, no banco de DB_NAME do .env.
// Funciona antes e depois da 0021 (usa so colunas que ja existiam). Nao corrige nada: a NF-e de compra casa o item
// pelo codigo EXATO do fornecedor, entao toda correcao e decisao de quem conhece o fornecedor (docs/18-sglog-fase2.md).
//
// O que lista:
//   A. duplicados exatos no mesmo fornecedor            -> bloqueiam a 0021 (indice unico)
//   B. vazios ou com espaco no inicio/fim               -> bloqueiam a 0021 (CHECK novo)
//   C. iguais exceto maiusculas/espacos no mesmo fornecedor -> so aviso
//   D. impacto nas NF-e de compra ja importadas: quantas notas do fornecedor trazem cada codigo de A/B/C
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim();
  }
}
const asJson = process.argv.includes('--json');
const client = new pg.Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.APP_DB_USER, password: env.APP_DB_PASSWORD, database: env.DB_NAME });

await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  const offerCols = `sp.id AS offer_id, sp.supplier_id, s.name AS supplier_name, s.document AS supplier_document, sp.supplier_sku,
    sp.active, v.sku AS variant_sku, k.label AS packaging_label`;
  const from = `FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN packagings k ON k.id = sp.packaging_id
    JOIN product_variants v ON v.id = k.variant_id`;

  const duplicates = await q(`SELECT ${offerCols} ${from}
    WHERE sp.supplier_sku IS NOT NULL AND (sp.supplier_id, sp.supplier_sku) IN (
      SELECT supplier_id, supplier_sku FROM supplier_products WHERE supplier_sku IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1)
    ORDER BY s.name, sp.supplier_sku, v.sku`);
  const blankOrSpaced = await q(`SELECT ${offerCols} ${from}
    WHERE sp.supplier_sku IS NOT NULL AND (btrim(sp.supplier_sku) = '' OR sp.supplier_sku <> btrim(sp.supplier_sku))
    ORDER BY s.name, v.sku`);
  const caseVariants = await q(`SELECT ${offerCols} ${from}
    WHERE sp.supplier_sku IS NOT NULL AND (sp.supplier_id, lower(btrim(sp.supplier_sku))) IN (
      SELECT supplier_id, lower(btrim(supplier_sku)) FROM supplier_products WHERE supplier_sku IS NOT NULL AND btrim(supplier_sku) <> ''
      GROUP BY 1, 2 HAVING count(DISTINCT supplier_sku) > 1)
    ORDER BY s.name, lower(sp.supplier_sku), v.sku`);

  // Impacto nas notas de compra: notas do mesmo fornecedor (vinculo ou CNPJ) com item de codigo igual (exato) ou
  // equivalente (sem espacos e sem diferenca de maiusculas).
  const impact = async (rows) => {
    for (const r of rows) {
      const n = (
        await q(
          `SELECT count(*) FILTER (WHERE exact) ::int AS exact, count(*) FILTER (WHERE loose AND NOT exact)::int AS loose FROM (
             SELECT bool_or(it->>'code' = $3) AS exact, bool_or(lower(btrim(it->>'code')) = lower(btrim($3))) AS loose
             FROM purchase_invoices i, jsonb_array_elements(i.items) it
             WHERE i.supplier_id = $1 OR ($2::text IS NOT NULL AND i.supplier_document = $2) GROUP BY i.id) x`,
          [r.supplier_id, r.supplier_document, r.supplier_sku],
        )
      )[0];
      r.invoices_exact = n.exact;
      r.invoices_equivalent = n.loose;
    }
    return rows;
  };
  const report = {
    database: env.DB_NAME,
    generated_at: new Date().toISOString(),
    totals: (await q(`SELECT count(*)::int AS offers, count(supplier_sku)::int AS with_code, (SELECT count(*)::int FROM purchase_invoices) AS invoices FROM supplier_products`))[0],
    blocking: { duplicates: await impact(duplicates), blank_or_spaced: await impact(blankOrSpaced) },
    warnings: { case_or_space_variants: await impact(caseVariants) },
  };
  await client.query('ROLLBACK');

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const t = report.totals;
    console.log(`Banco ${report.database}: ${t.offers} oferta(s), ${t.with_code} com codigo do fornecedor, ${t.invoices} NF-e de compra importada(s).`);
    const show = (title, rows, fix) => {
      console.log(`\n${title}: ${rows.length}`);
      for (const r of rows) {
        console.log(`  ${r.supplier_name} | codigo "${r.supplier_sku}" | ${r.variant_sku} ${r.packaging_label} | oferta ${r.offer_id}${r.active ? '' : ' (inativa)'}` +
          ` | NF-e com o codigo: ${r.invoices_exact} exato, ${r.invoices_equivalent} equivalente`);
      }
      if (rows.length) console.log(`  Correcao: ${fix}`);
    };
    show('A. Duplicados no mesmo fornecedor (BLOQUEIA a 0021)', report.blocking.duplicates,
      'deixar o codigo so na oferta que o fornecedor usa na NF-e (confira a coluna "exato"); nas demais, o codigo certo ou vazio (nulo).');
    show('B. Vazios ou com espaco nas pontas (BLOQUEIA a 0021)', report.blocking.blank_or_spaced,
      'vazio -> nulo; com espaco -> o codigo como aparece na NF-e do fornecedor.');
    show('C. Iguais exceto maiusculas ou espacos (so aviso)', report.warnings.case_or_space_variants,
      'conferir com a NF-e qual grafia o fornecedor usa; a 0021 nao bloqueia.');
    const blocking = report.blocking.duplicates.length + report.blocking.blank_or_spaced.length;
    console.log(blocking ? `\nResultado: ${blocking} oferta(s) a corrigir antes da 0021. Nada foi alterado.` : '\nResultado: nenhum conflito; a 0021 pode seguir. Nada foi alterado.');
  }
} finally {
  await client.end();
}
