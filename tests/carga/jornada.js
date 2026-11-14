// Teste de carga da loja (k6): jornada de um cliente real, com pausas de leitura.
//
// Nao cria pedido, pagamento nem movimento de estoque: o checkout e enviado com um total esperado
// propositalmente diferente, e a API recusa (409 PRICE_CHANGED) dentro da transacao, antes de reservar.
// Sem provedor de pagamento configurado a API responde 503 PAYMENT_UNAVAILABLE: tambem conta como esperado.
// O carrinho criado fica no banco ate expirar (como o de qualquer visitante).
//
// Uso (ver tests/carga/README.md):
//   k6 run -e BASE_URL=http://127.0.0.1:3011 -e CENARIO=medio tests/carga/jornada.js
//
// Variaveis:
//   BASE_URL      endereco da loja (o Next; ele repassa /api para a API)
//   CENARIO       fumaca | inicial | baixo | medio | elevado | avancado | rampa | pico | estresse | resistencia
//   SIMULAR_IPS=1 cada usuario manda um X-Forwarded-For proprio (so em teste local com TRUST_PROXY=1;
//                 no servidor o nginx sobrescreve o cabecalho e todos aparecem com o IP de quem roda o k6)
//   INSECURE=1    aceita certificado nao confiavel (acesso provisorio por IP)
//   PAUSA=0       sem pausas de leitura (mede vazao bruta; nao representa usuarios reais)
import { check, group, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:3011').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const ORIGIN = __ENV.ORIGIN || BASE;
const THINK = __ENV.PAUSA === '0' ? 0 : 1;

// Limites de seguranca: se a loja degradar, o k6 para sozinho (abortOnFail).
const guard = {
  http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '20s' }],
  'http_req_duration{tipo:pagina}': [{ threshold: 'p(95)<4000', abortOnFail: true, delayAbortEval: '30s' }],
  'http_req_duration{tipo:api}': ['p(95)<1500'],
  checks: ['rate>0.97'],
};

const fixed = (vus, duration) => ({ executor: 'constant-vus', vus, duration });
const SCENARIOS = {
  fumaca: fixed(1, '30s'),
  inicial: fixed(10, '2m'),
  baixo: fixed(25, '2m'),
  medio: fixed(50, '3m'),
  elevado: fixed(100, '3m'),
  avancado: fixed(200, '3m'),
  // Rampa: sobe aos poucos, segura e desce.
  rampa: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '1m', target: 50 }, { duration: '2m', target: 100 }, { duration: '2m', target: 100 }, { duration: '1m', target: 0 }] },
  // Pico: de 10 para 200 em 10 s (campanha, link compartilhado).
  pico: { executor: 'ramping-vus', startVUs: 10, stages: [{ duration: '30s', target: 10 }, { duration: '10s', target: 200 }, { duration: '1m', target: 200 }, { duration: '10s', target: 10 }, { duration: '30s', target: 10 }] },
  // Estresse: degraus de 100 ate 800; os limites de seguranca interrompem quando degradar.
  estresse: {
    executor: 'ramping-vus',
    startVUs: 50,
    stages: [100, 200, 300, 400, 500, 600, 800].flatMap((t) => [{ duration: '30s', target: t }, { duration: '1m', target: t }]),
  },
  // Resistencia: carga moderada por tempo prolongado (vazamento de memoria, conexoes, disco).
  resistencia: fixed(Number(__ENV.VUS || 50), __ENV.DURACAO || '30m'),
};
const cenario = __ENV.CENARIO || 'fumaca';
if (!SCENARIOS[cenario]) throw new Error(`CENARIO desconhecido: ${cenario}`);

export const options = {
  scenarios: { [cenario]: SCENARIOS[cenario] },
  thresholds: guard,
  insecureSkipTLSVerify: __ENV.INSECURE === '1',
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
};

const checkoutOutcome = new Counter('checkout_recusado_sem_criar');
const journeyTime = new Trend('jornada_completa', true);

// Uma vez so: categorias, produtos e embalagens a usar.
export function setup() {
  const cats = http.get(`${API}/public/catalog/categories`).json('categories') || [];
  const list = http.get(`${API}/public/catalog/products?pageSize=60`).json('products') || [];
  if (!list.length) throw new Error('Catalogo vazio: rode o teste com dados (ex.: demo:seed).');
  const products = [];
  for (const p of list.slice(0, 40)) {
    const d = http.get(`${API}/public/catalog/products/${p.slug}`).json('product');
    const packs = (d?.variants || []).flatMap((v) => v.packagings.filter((k) => k.in_stock || d.availability_mode === 'made_to_order').map((k) => k.id));
    if (packs.length) products.push({ slug: p.slug, packs });
  }
  const terms = ['forminha', 'caixa', 'vela', 'copo', 'fita', 'bolo', 'saco', 'bandeja', 'tampa', 'papel'];
  return { categories: cats.filter((c) => c.product_count > 0).map((c) => c.slug), products, terms };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pause = (min, max) => THINK && sleep(min + Math.random() * (max - min));

function headers(extra = {}) {
  const h = { Origin: ORIGIN, ...extra };
  if (__ENV.SIMULAR_IPS === '1') {
    // Cada iteracao e um cliente novo (IP proprio): os limites por IP valem por cliente, como na vida real.
    const id = exec.scenario.iterationInTest + 1;
    h['X-Forwarded-For'] = `10.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}`;
  }
  return h;
}
const page = (url, name) => http.get(url, { headers: headers(), tags: { tipo: 'pagina', name } });
const api = (method, url, body, name, expected) =>
  http.request(method, url, body === undefined ? null : JSON.stringify(body), {
    headers: headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    tags: { tipo: 'api', name },
    ...(expected ? { responseCallback: http.expectedStatuses(...expected) } : {}),
  });

export default function (data) {
  // Cliente novo a cada iteracao: carrinho vazio, sem cookies da anterior.
  http.cookieJar().clear(BASE);
  const t0 = Date.now();
  group('vitrine', () => {
    check(page(`${BASE}/`, 'inicio'), { 'inicio 200': (r) => r.status === 200 });
    pause(1, 3);
    if (data.categories.length) {
      check(page(`${BASE}/c/${pick(data.categories)}`, 'categoria'), { 'categoria 200': (r) => r.status === 200 });
      pause(1, 3);
    }
    check(page(`${BASE}/busca?q=${pick(data.terms)}`, 'busca'), { 'busca 200': (r) => r.status === 200 });
    pause(1, 3);
  });

  const prod = pick(data.products);
  group('produto', () => {
    check(page(`${BASE}/p/${prod.slug}`, 'produto'), { 'produto 200': (r) => r.status === 200 });
    // Trocar embalagem e quantidade acontece no navegador, sem rede; a disponibilidade vem da API.
    check(api('GET', `${API}/public/catalog/products/${prod.slug}`, undefined, 'disponibilidade'), { 'disponibilidade 200': (r) => r.status === 200 });
    pause(2, 5);
  });

  group('carrinho', () => {
    const pack = pick(prod.packs);
    const add = api('POST', `${API}/public/cart/items`, { packagingId: pack, packs: 1 + Math.floor(Math.random() * 3) }, 'carrinho_adicionar');
    check(add, { 'adicionar 200': (r) => r.status === 200 });
    pause(1, 2);
    const upd = api('PUT', `${API}/public/cart/items/${pack}`, { packs: 2 + Math.floor(Math.random() * 4) }, 'carrinho_atualizar');
    check(upd, { 'atualizar 200': (r) => r.status === 200 });
    check(api('GET', `${API}/public/cart`, undefined, 'carrinho_ver'), { 'carrinho 200': (r) => r.status === 200 });
    pause(1, 3);
  });

  group('checkout', () => {
    const q = api('GET', `${API}/public/shipping/quote?cep=89460000`, undefined, 'frete');
    check(q, { 'frete 200': (r) => r.status === 200 });
    const option = q.status === 200 ? (q.json('options') || [])[0] : null;
    if (!option) return;
    const body = {
      requestKey: `carga-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Date.now()}`,
      buyer: { kind: 'pf', name: 'Cliente Teste de Carga', email: 'carga@teste.invalid', phone: '47900000000', document: '529.982.247-25' },
      shippingOptionId: option.id,
      paymentMethod: 'pix',
      // Total errado de proposito: a API confere tudo e recusa sem criar o pedido.
      expectedTotalCents: 1,
      ...(option.kind === 'delivery' ? { address: { cep: '89460000', street: 'Rua Teste', number: '1', district: 'Centro', city: 'Canoinhas', uf: 'SC' } } : {}),
    };
    const r = api('POST', `${API}/public/checkout`, body, 'checkout', [409, 503]);
    const expected = r.status === 409 || (r.status === 503 && /PAYMENT/.test(r.body || ''));
    check(r, { 'checkout recusado sem criar pedido': () => expected });
    if (expected) checkoutOutcome.add(1);
    else console.warn(`checkout inesperado: ${r.status} ${(r.body || '').slice(0, 160)}`);
  });
  journeyTime.add(Date.now() - t0);
  pause(2, 6);
}
