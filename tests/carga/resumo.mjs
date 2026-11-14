// Tabela dos resumos do k6 (--summary-export <cenario>.json) de uma pasta.
// Uso: node tests/carga/resumo.mjs <pasta>
import { readFileSync, existsSync } from 'node:fs';
const dir = process.argv[2];
const order = ['inicial', 'baixo', 'medio', 'elevado', 'avancado', 'rampa', 'pico', 'estresse', 'resistencia', 'vazao'];
const f = (v) => (v === undefined ? '-' : v < 10 ? v.toFixed(1) : Math.round(v));
console.log('cenario     VUs  req/s  falhas  pag_med pag_p95 pag_p99 | api_med api_p95 api_p99 | checks');
for (const c of order) {
  const p = `${dir}/${c}.json`;
  if (!existsSync(p)) continue;
  const m = JSON.parse(readFileSync(p, 'utf8')).metrics;
  const pg = m['http_req_duration{tipo:pagina}'] ?? {};
  const ap = m['http_req_duration{tipo:api}'] ?? {};
  console.log(`${c.padEnd(10)} ${String(m.vus_max?.max ?? m.vus_max?.value).padStart(4)} ${f(m.http_reqs.rate).toString().padStart(6)} ${((m.http_req_failed.value ?? m.http_req_failed.rate) * 100).toFixed(2).padStart(6)}%  ${String(f(pg.med)).padStart(6)} ${String(f(pg['p(95)'])).padStart(7)} ${String(f(pg['p(99)'])).padStart(7)} | ${String(f(ap.med)).padStart(6)} ${String(f(ap['p(95)'])).padStart(7)} ${String(f(ap['p(99)'])).padStart(7)} | ${((m.checks.value ?? m.checks.rate) * 100).toFixed(2)}%`);
}
