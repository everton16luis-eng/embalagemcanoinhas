// Dados de demonstracao e reversao (docs/DEMONSTRACAO.md).
//
//   npm run demo:seed -- --confirmar DEMO            popula o banco vazio com uma loja ficticia (6 meses de historico)
//   npm run demo:reset -- --confirmar APAGAR-TUDO    apaga TUDO o que foi cadastrado; ficam so os proprietarios
//
// Conecta como dono das tabelas (loja_owner), como as migrations. O seed grava direto no banco com datas no passado,
// simulando o estoque em ordem de data: cada saldo bate com o livro de movimentos.
// Nada aqui inventa dado fiscal ou da empresa: empresa, certificado, regras fiscais e NF-e ficam vazios.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { slugify } from '../lib/br.js';
import { sha256 } from '../lib/crypto.js';
import { unitPrice, type Tier } from '../lib/pricing.js';
import { hashPassword } from '../modules/auth.js';
import { publicToken } from '../modules/orders.js';
import { quoteToken } from '../modules/quotes.js';

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const [command, ...args] = process.argv.slice(2);
const confirm = args[args.indexOf('--confirmar') + 1];

const db = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_OWNER_USER,
  password: process.env.DB_OWNER_PASSWORD,
  database: process.env.DB_NAME,
});

// ---------------------------------------------------------------- utilitarios

let seed = 20261113;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const chance = (p: number) => rnd() < p;
const weighted = <T>(items: readonly T[], w: (x: T) => number): T => {
  const total = items.reduce((s, x) => s + w(x), 0);
  let r = rnd() * total;
  for (const x of items) if ((r -= w(x)) <= 0) return x;
  return items[items.length - 1]!;
};
const round10 = (c: number) => Math.max(10, Math.round(c / 10) * 10);
const r4 = (x: number) => Math.round(x * 10000) / 10000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const START = NOW - 185 * DAY;
const at = (t: number) => new Date(Math.min(t, NOW - MIN));
/** Horario comercial (8h-20h, horario de Brasilia) do dia de t. */
const businessHour = (t: number) => {
  const d = new Date(t - 3 * HOUR);
  d.setUTCHours(int(8, 19), int(0, 59), int(0, 59), 0);
  // Hoje, num horario que ainda nao chegou: puxa para as ultimas horas.
  return Math.min(d.getTime() + 3 * HOUR, NOW - int(5, 180) * MIN);
};
const dateOnly = (t: number) => new Date(t - 3 * HOUR).toISOString().slice(0, 10);

async function insertRows(table: string, cols: string[], rows: unknown[][]) {
  const chunk = Math.max(1, Math.floor(20_000 / cols.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const params: unknown[] = [];
    const values = rows.slice(i, i + chunk).map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`);
    await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values.join(', ')}`, params);
  }
}

const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);

// ---------------------------------------------------------------- catalogo ficticio

const CATEGORIES: { name: string; children: string[] }[] = [
  { name: 'Embalagens para doces', children: ['Forminhas', 'Caixas para doces', 'Potes e saquinhos'] },
  { name: 'Bolos e tortas', children: ['Caixas para bolo', 'Bases e cake boards', 'Fitas e laços'] },
  { name: 'Descartáveis', children: ['Copos descartáveis', 'Pratos e talheres', 'Guardanapos'] },
  { name: 'Confeitaria', children: ['Bicos de confeitar', 'Sacos de confeitar', 'Espátulas e utensílios', 'Formas e assadeiras'] },
  { name: 'Festas', children: ['Velas', 'Toppers e decoração'] },
  { name: 'Delivery', children: ['Marmitex', 'Sacolas kraft'] },
];

type PackDef = [label: string, unit: string, qty: number];
type Family = {
  code: string;
  cat: string;
  name: (s: string) => string;
  sizes: string[];
  attr?: [string, string[]];
  unit?: string;
  packs: PackDef[];
  purchase: PackDef;
  /** Preco por unidade base, em centavos, para o tamanho i. */
  u: (i: number) => number;
  material: string;
  weight: (i: number) => number;
  dims: (i: number) => [number, number, number];
  mto?: [prob: number, days: number];
};

const COLORS = ['Branca', 'Marrom', 'Rosa', 'Azul', 'Vermelha'];
const FAMILIES: Family[] = [
  { code: 'FRM', cat: 'Forminhas', name: (s) => `Forminha de papel nº ${s}`, sizes: ['3', '4', '5', '6'], attr: ['Cor', COLORS], packs: [['Pacote com 100', 'PCT', 100], ['Caixa com 1.000', 'CX', 1000]], purchase: ['Caixa do fornecedor com 5.000', 'CX', 5000], u: (i) => 3.9 + 0.6 * i, material: 'Papel', weight: () => 1, dims: () => [30, 30, 20] },
  { code: 'FRL', cat: 'Forminhas', name: (s) => `Forminha laminada nº ${s}`, sizes: ['4', '5'], attr: ['Cor', ['Dourada', 'Prata', 'Rosé']], packs: [['Pacote com 100', 'PCT', 100], ['Caixa com 1.000', 'CX', 1000]], purchase: ['Caixa do fornecedor com 2.000', 'CX', 2000], u: (i) => 8.5 + i, material: 'Papel laminado', weight: () => 1, dims: () => [32, 32, 22] },
  { code: 'CXD', cat: 'Caixas para doces', name: (s) => `Caixa para doces ${s} cavidades`, sizes: ['4', '6', '9', '12', '16', '20', '25', '30'], attr: ['Cor', ['Branca', 'Kraft']], packs: [['Unidade', 'UN', 1], ['Pacote com 10', 'PCT', 10], ['Pacote com 50', 'PCT', 50]], purchase: ['Fardo com 200', 'FD', 200], u: (i) => 90 + 25 * i, material: 'Papel cartão', weight: (i) => 20 + 6 * i, dims: (i) => [80 + 20 * i, 80 + 15 * i, 40] },
  { code: 'POT', cat: 'Potes e saquinhos', name: (s) => `Pote redondo com tampa ${s} ml`, sizes: ['50', '100', '150', '250', '350', '500', '750', '1000'], packs: [['Pacote com 25', 'PCT', 25], ['Caixa com 500', 'CX', 500]], purchase: ['Caixa com 500', 'CX', 500], u: (i) => 18 + 6 * i, material: 'Plástico PP', weight: (i) => 4 + 3 * i, dims: (i) => [60 + 10 * i, 60 + 10 * i, 40 + 8 * i] },
  { code: 'SKL', cat: 'Potes e saquinhos', name: (s) => `Saquinho celofane ${s} cm`, sizes: ['10 x 15', '11 x 19', '15 x 22', '20 x 29'], packs: [['Pacote com 100', 'PCT', 100]], purchase: ['Pacote com 1.000', 'PCT', 1000], u: (i) => 6 + 2.5 * i, material: 'Polipropileno (celofane)', weight: () => 1, dims: (i) => [100 + 30 * i, 150 + 40 * i, 1] },
  { code: 'CXB', cat: 'Caixas para bolo', name: (s) => `Caixa para bolo ${s} cm`, sizes: ['15', '20', '25', '30', '35'], attr: ['Cor', ['Branca', 'Kraft']], packs: [['Unidade', 'UN', 1], ['Pacote com 10', 'PCT', 10]], purchase: ['Fardo com 50', 'FD', 50], u: (i) => 250 + 90 * i, material: 'Papel cartão', weight: (i) => 60 + 30 * i, dims: (i) => [150 + 50 * i, 150 + 50 * i, 100 + 10 * i] },
  { code: 'CKB', cat: 'Bases e cake boards', name: (s) => `Cake board redondo ${s} cm`, sizes: ['15', '20', '25', '30', '35', '40'], attr: ['Cor', ['Dourado', 'Prata']], packs: [['Unidade', 'UN', 1], ['Pacote com 10', 'PCT', 10]], purchase: ['Pacote com 100', 'PCT', 100], u: (i) => 120 + 60 * i, material: 'Papelão laminado', weight: (i) => 40 + 25 * i, dims: (i) => [150 + 50 * i, 150 + 50 * i, 3] },
  { code: 'FTA', cat: 'Fitas e laços', name: (s) => `Fita de cetim ${s} mm`, sizes: ['7', '10', '15', '22', '38'], attr: ['Cor', ['Branca', 'Vermelha', 'Rosa', 'Azul', 'Dourada']], unit: 'RL', packs: [['Rolo de 10 m', 'RL', 1], ['Pacote com 10 rolos', 'PCT', 10]], purchase: ['Pacote com 50 rolos', 'PCT', 50], u: (i) => 290 + 110 * i, material: 'Cetim', weight: (i) => 15 + 8 * i, dims: () => [60, 60, 20] },
  { code: 'CPO', cat: 'Copos descartáveis', name: (s) => `Copo descartável ${s} ml`, sizes: ['50', '80', '180', '200', '300', '400', '500'], attr: ['Cor', ['Transparente', 'Branco']], packs: [['Pacote com 100', 'PCT', 100], ['Caixa com 2.500', 'CX', 2500]], purchase: ['Caixa com 2.500', 'CX', 2500], u: (i) => 4 + 1.4 * i, material: 'Plástico PP', weight: (i) => 1 + i, dims: (i) => [50 + 6 * i, 50 + 6 * i, 40 + 12 * i] },
  { code: 'PRT', cat: 'Pratos e talheres', name: (s) => `Prato descartável ${s} cm`, sizes: ['15', '18', '21', '26'], packs: [['Pacote com 10', 'PCT', 10], ['Caixa com 500', 'CX', 500]], purchase: ['Caixa com 500', 'CX', 500], u: (i) => 9 + 4 * i, material: 'Plástico PS', weight: (i) => 4 + 2 * i, dims: (i) => [150 + 30 * i, 150 + 30 * i, 15] },
  { code: 'TLH', cat: 'Pratos e talheres', name: (s) => `Talher descartável: ${s}`, sizes: ['colher de sobremesa', 'garfo de sobremesa', 'colher de refeição', 'garfo de refeição', 'faca de refeição'], attr: ['Cor', ['Branco', 'Cristal']], packs: [['Pacote com 50', 'PCT', 50], ['Caixa com 1.000', 'CX', 1000]], purchase: ['Caixa com 2.000', 'CX', 2000], u: (i) => 5 + 0.8 * i, material: 'Plástico PS', weight: () => 2, dims: () => [150, 30, 10] },
  { code: 'GDN', cat: 'Guardanapos', name: (s) => `Guardanapo de papel ${s} cm`, sizes: ['20 x 23', '22 x 23', '30 x 30'], attr: ['Cor', ['Branco', 'Colorido']], packs: [['Pacote com 50', 'PCT', 50], ['Fardo com 2.000', 'FD', 2000]], purchase: ['Fardo com 4.000', 'FD', 4000], u: (i) => 1.6 + 0.6 * i, material: 'Papel', weight: () => 1, dims: () => [110, 110, 2] },
  { code: 'BIC', cat: 'Bicos de confeitar', name: (s) => `Bico de confeitar ${s}`, sizes: ['1M', '2D', '21', '32', '104', '352', '1A', '6B', '4B', '199'], packs: [['Unidade', 'UN', 1]], purchase: ['Caixa com 12', 'CX', 12], u: (i) => 990 + (i % 4) * 250, material: 'Aço inox', weight: () => 12, dims: () => [30, 30, 50], mto: [0.3, 10] },
  { code: 'SCF', cat: 'Sacos de confeitar', name: (s) => `Saco de confeitar descartável ${s} cm`, sizes: ['30', '40', '50'], packs: [['Rolo com 50', 'RL', 50], ['Caixa com 500', 'CX', 500]], purchase: ['Caixa com 1.000', 'CX', 1000], u: (i) => 22 + 6 * i, material: 'Plástico PE', weight: () => 4, dims: (i) => [300 + 100 * i, 200, 1] },
  { code: 'ESP', cat: 'Espátulas e utensílios', name: (s) => `Espátula de confeitar ${s} cm`, sizes: ['20', '25', '30'], attr: ['Modelo', ['Reta', 'Angular']], packs: [['Unidade', 'UN', 1]], purchase: ['Caixa com 12', 'CX', 12], u: (i) => 1890 + 500 * i, material: 'Aço inox e plástico', weight: (i) => 60 + 15 * i, dims: (i) => [300 + 50 * i, 40, 20] },
  { code: 'FAL', cat: 'Formas e assadeiras', name: (s) => `Forma de alumínio redonda ${s} cm`, sizes: ['15', '20', '25', '30'], packs: [['Unidade', 'UN', 1]], purchase: ['Caixa com 12', 'CX', 12], u: (i) => 1490 + 600 * i, material: 'Alumínio', weight: (i) => 150 + 60 * i, dims: (i) => [150 + 50 * i, 150 + 50 * i, 80] },
  { code: 'VLN', cat: 'Velas', name: (s) => `Vela de aniversário número ${s}`, sizes: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], attr: ['Cor', ['Dourada', 'Prata', 'Rosa', 'Azul']], packs: [['Unidade', 'UN', 1], ['Caixa com 12', 'CX', 12]], purchase: ['Caixa com 48', 'CX', 48], u: () => 450, material: 'Parafina e pavio', weight: () => 20, dims: () => [60, 40, 90] },
  { code: 'VLP', cat: 'Velas', name: (s) => `Vela palito ${s}`, sizes: ['colorida', 'dourada'], packs: [['Pacote com 24', 'PCT', 24]], purchase: ['Caixa com 480', 'CX', 480], u: (i) => 25 + 10 * i, material: 'Parafina e pavio', weight: () => 2, dims: () => [70, 5, 5] },
  { code: 'TOP', cat: 'Toppers e decoração', name: (s) => `Topper de bolo ${s}`, sizes: ['Feliz Aniversário', 'Parabéns'], attr: ['Cor', ['Dourado', 'Prata', 'Rosa']], packs: [['Unidade', 'UN', 1]], purchase: ['Pacote com 20', 'PCT', 20], u: () => 690, material: 'Acrílico espelhado', weight: () => 15, dims: () => [150, 120, 3], mto: [0.5, 7] },
  { code: 'MXA', cat: 'Marmitex', name: (s) => `Marmitex de alumínio nº ${s} com tampa`, sizes: ['6', '7', '8', '9'], packs: [['Pacote com 10', 'PCT', 10], ['Caixa com 100', 'CX', 100]], purchase: ['Caixa com 100', 'CX', 100], u: (i) => 65 + 15 * i, material: 'Alumínio e papel', weight: (i) => 12 + 3 * i, dims: (i) => [150 + 15 * i, 110 + 10 * i, 40] },
  { code: 'SCK', cat: 'Sacolas kraft', name: (s) => `Sacola kraft com alça tamanho ${s}`, sizes: ['P', 'M', 'G'], packs: [['Unidade', 'UN', 1], ['Pacote com 10', 'PCT', 10], ['Pacote com 50', 'PCT', 50]], purchase: ['Fardo com 250', 'FD', 250], u: (i) => 85 + 35 * i, material: 'Papel kraft', weight: (i) => 30 + 15 * i, dims: (i) => [180 + 60 * i, 100 + 20 * i, 220 + 60 * i] },
];

const SUPPLIERS = [
  { name: 'Distribuidora Exemplo Alfa (demonstração)', city: 'Joinville', uf: 'SC', lead: 4, terms: '28 dias no boleto', fams: ['FRM', 'FRL', 'SKL', 'GDN'] },
  { name: 'Papelaria Atacado Exemplo Beta (demonstração)', city: 'Curitiba', uf: 'PR', lead: 6, terms: '30/60 dias', fams: ['CXD', 'CXB', 'CKB', 'SCK', 'GDN'] },
  { name: 'Plásticos Exemplo Gama (demonstração)', city: 'Blumenau', uf: 'SC', lead: 5, terms: '21 dias', fams: ['POT', 'CPO', 'PRT', 'TLH', 'SCF'] },
  { name: 'Utensílios Exemplo Delta (demonstração)', city: 'São Paulo', uf: 'SP', lead: 10, terms: 'À vista com 3% de desconto', fams: ['BIC', 'ESP', 'FAL', 'TOP'] },
  { name: 'Festas Exemplo Épsilon (demonstração)', city: 'Curitiba', uf: 'PR', lead: 7, terms: '28 dias', fams: ['VLN', 'VLP', 'TOP', 'FTA'] },
  { name: 'Alumínio Exemplo Zeta (demonstração)', city: 'Joinville', uf: 'SC', lead: 5, terms: '28 dias', fams: ['MXA', 'FAL'] },
  { name: 'Embalagens Exemplo Eta (demonstração)', city: 'Mafra', uf: 'SC', lead: 2, terms: '14 dias', fams: ['FRM', 'CPO', 'SCK', 'POT'] },
];

const FIRST = ['Ana', 'Bruna', 'Carla', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Juliana', 'Larissa', 'Mariana', 'Natália', 'Patrícia', 'Rafaela', 'Simone', 'Tatiane', 'Vanessa', 'Carlos', 'Diego', 'João', 'Lucas', 'Marcos', 'Paulo', 'Rodrigo', 'Tiago'];
const LAST = ['Almeida', 'Andrade', 'Barbosa', 'Cardoso', 'Costa', 'Ferreira', 'Gomes', 'Lima', 'Machado', 'Martins', 'Melo', 'Moraes', 'Nunes', 'Oliveira', 'Pereira', 'Ribeiro', 'Rocha', 'Santos', 'Schmidt', 'Souza', 'Teixeira', 'Wolf'];
const BUSINESS = ['Doceria', 'Confeitaria', 'Ateliê de Doces', 'Bolos', 'Lanchonete', 'Buffet', 'Padaria', 'Café'];
const BUSINESS_NAME = ['Doce Encanto', 'Sabor de Casa', 'Mel & Canela', 'Brigadeiro Fino', 'Açúcar Mascavo', 'Bem Casado', 'Pão Quente', 'Festa Boa', 'Cacau', 'Vó Maria', 'Trigo de Ouro', 'Cereja'];
// Codigos postais gerais das cidades (dado publico); ruas sao ficticias.
const CITIES = [
  { city: 'Canoinhas', cep: '89460000', w: 6, region: 'local' },
  { city: 'Três Barras', cep: '89490000', w: 1.5, region: 'regiao' },
  { city: 'Major Vieira', cep: '89480000', w: 1, region: 'regiao' },
  { city: 'Mafra', cep: '89300000', w: 1.5, region: 'regiao' },
  { city: 'Porto União', cep: '89400000', w: 1, region: 'regiao' },
] as const;
const STREETS = ['Rua das Flores', 'Rua dos Ipês', 'Rua das Araucárias', 'Avenida Central', 'Rua do Comércio', 'Rua das Palmeiras', 'Rua Sete', 'Rua da Estação'];
const DISTRICTS = ['Centro', 'Jardim Esperança', 'Água Verde', 'Alto da Tijuca', 'Campo da Água Verde', 'Bairro Novo'];

// ---------------------------------------------------------------- seed

type Pack = { id: string; variantId: string; kind: 'sale' | 'purchase'; label: string; unit: string; baseQty: number; priceCents: number | null; tiers: Tier[]; isDefault: boolean; position: number };
type Variant = { id: string; productId: string; productName: string; sku: string; famCode: string; active: boolean; mto: boolean; lead: number | null; minStock: number; weightG: number; sale: Pack[]; purchase: Pack; unitCost: number; suppliers: string[]; draft: boolean };
type Product = { id: string; name: string; status: string; weight: number; variants: Variant[] };

async function seedDemo() {
  if (confirm !== 'DEMO') throw new Error('Confirme com: npm run demo:seed -- --confirmar DEMO');
  for (const t of ['products', 'orders', 'quotes', 'customers', 'suppliers']) {
    if (await count(`SELECT count(*) AS n FROM ${t}`)) throw new Error(`O banco ja tem ${t}. O seed so roda num banco sem cadastros (use demo:reset antes, se for o caso).`);
  }
  const owner = (await db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' AND is_active ORDER BY created_at LIMIT 1`)).rows[0];
  if (!owner) throw new Error('Crie o proprietario antes (npm run create-owner).');
  const OWNER = owner.id;

  // ---------- equipe ficticia (senha aleatoria descartada: ninguem entra com estes usuarios)
  const staffDefs: [string, string, string][] = [
    ['manager', 'Gerente (demonstração)', 'gerente'],
    ['sales', 'Vendedora Ana (demonstração)', 'vendas.ana'],
    ['sales', 'Vendedor Lucas (demonstração)', 'vendas.lucas'],
    ['stock', 'Estoquista (demonstração)', 'estoque'],
    ['fiscal', 'Fiscal (demonstração)', 'fiscal'],
    ['shipping', 'Expedição (demonstração)', 'expedicao'],
  ];
  const staff: Record<string, string> = {};
  const userRows: unknown[][] = [];
  for (const [role, name, mail] of staffDefs) {
    const id = randomUUID();
    staff[mail] = id;
    userRows.push([id, `${mail}@demo.invalid`, name, role, await hashPassword(randomBytes(24).toString('base64url')), at(START - 20 * DAY)]);
  }
  const SALES = [staff['vendas.ana']!, staff['vendas.lucas']!];
  const STOCK = staff['estoque']!;
  const SHIP = staff['expedicao']!;
  const MANAGER = staff['gerente']!;

  // ---------- categorias
  const catRows: unknown[][] = [];
  const catId: Record<string, string> = {};
  CATEGORIES.forEach((c, i) => {
    const id = randomUUID();
    catRows.push([id, null, c.name, slugify(c.name), i]);
    c.children.forEach((ch, j) => {
      const cid = randomUUID();
      catId[ch] = cid;
      catRows.push([cid, id, ch, slugify(ch), j]);
    });
  });

  // ---------- produtos, variacoes e embalagens
  const products: Product[] = [];
  const supplierIds: string[] = SUPPLIERS.map(() => randomUUID());
  for (const f of FAMILIES) {
    f.sizes.forEach((size, i) => {
      const pid = randomUUID();
      const name = f.name(size);
      const mto = f.mto ? chance(f.mto[0]) : false;
      const p: Product = { id: pid, name, status: 'active', weight: 1, variants: [] };
      const values = f.attr ? f.attr[1] : [null];
      values.forEach((value) => {
        const vid = randomUUID();
        const sku = [f.code, slugify(size).replace(/-/g, '').toUpperCase().slice(0, 12), value ? slugify(value).toUpperCase().slice(0, 3) : null].filter(Boolean).join('-');
        const u = f.u(i);
        const sale: Pack[] = f.packs.map(([label, unit, qty], k) => {
          const factor = qty >= 1000 ? 0.85 : qty >= 100 && k > 0 ? 0.92 : 1;
          const price = round10(u * qty * factor);
          const tiers: Tier[] = k === 0 ? [{ minPacks: 5, priceCents: round10(price * 0.95) }, { minPacks: 10, priceCents: round10(price * 0.9) }].filter((t) => t.priceCents < price) : [];
          return { id: randomUUID(), variantId: vid, kind: 'sale', label, unit, baseQty: qty, priceCents: price, tiers, isDefault: k === 0, position: k };
        });
        const [pl, pu, pq] = f.purchase;
        const purchase: Pack = { id: randomUUID(), variantId: vid, kind: 'purchase', label: pl, unit: pu, baseQty: pq, priceCents: null, tiers: [], isDefault: true, position: 0 };
        const sups = SUPPLIERS.map((s, k) => (s.fams.includes(f.code) ? supplierIds[k]! : null)).filter((x): x is string => Boolean(x));
        p.variants.push({
          id: vid,
          productId: pid,
          productName: name,
          sku,
          famCode: f.code,
          active: true,
          mto,
          lead: mto ? f.mto![1] : null,
          minStock: Math.max(2, (f.packs[0]![2] ?? 1) * 3),
          weightG: f.weight(i),
          sale,
          purchase,
          unitCost: r4(u * (0.55 + rnd() * 0.1)),
          suppliers: sups,
          draft: false,
        });
      });
      products.push(p);
    });
  }
  // Alguns rascunhos e inativos, como numa loja de verdade.
  const shuffled = [...products].sort(() => rnd() - 0.5);
  shuffled.slice(0, 4).forEach((p) => ((p.status = 'draft'), p.variants.forEach((v) => (v.draft = true))));
  shuffled.slice(4, 7).forEach((p) => (p.status = 'inactive'));
  // Popularidade (curva ABC): poucos produtos vendem muito.
  const ranked = shuffled.slice(7).sort(() => rnd() - 0.5);
  ranked.forEach((p, i) => (p.weight = 1 / Math.pow(i + 3, 0.9)));
  const turnover = new Map(ranked.map((p, i) => [p.id, i < ranked.length * 0.2 ? 'high' : i < ranked.length * 0.5 ? 'medium' : 'low']));
  const sellable = ranked;
  const allVariants = products.flatMap((p) => p.variants);
  const variantById = new Map(allVariants.map((v) => [v.id, v]));
  const productById = new Map(products.map((p) => [p.id, p]));

  // ---------- clientes
  type Customer = { id: string; kind: 'pf' | 'pj'; name: string; email: string; phone: string | null; city: (typeof CITIES)[number]; address: Record<string, string | null>; createdAt: number };
  const customers: Customer[] = [];
  const customerHash = await hashPassword(randomBytes(24).toString('base64url'));
  for (let i = 1; i <= 64; i++) {
    const pj = chance(0.28);
    const first = pick(FIRST);
    const last = pick(LAST);
    const name = pj ? `${pick(BUSINESS)} ${pick(BUSINESS_NAME)}` : `${first} ${last}`;
    const city = weighted(CITIES, (c) => c.w);
    customers.push({
      id: randomUUID(),
      kind: pj ? 'pj' : 'pf',
      name,
      email: `cliente${String(i).padStart(2, '0')}@demo.invalid`,
      // Numeros no padrao 47 90000-NNNN (ficticios), so para quem aceitou avisos.
      phone: i <= 30 ? `479000${String(i).padStart(5, '0')}` : null,
      city,
      address: { label: 'Principal', recipient: pj ? `${first} ${last}` : name, cep: city.cep, street: pick(STREETS), number: String(int(10, 2400)), complement: chance(0.3) ? `Sala ${int(1, 20)}` : null, district: pick(DISTRICTS), city: city.city, uf: 'SC' },
      createdAt: START + rnd() * 120 * DAY,
    });
  }

  // ---------- formas de entrega
  const shipOpts = {
    pickup: { id: randomUUID(), name: 'Retirada na loja (demonstração)', kind: 'pickup', description: 'Retire no balcão em horário comercial.', ranges: [] as string[], base: 0, perKg: 0, free: null as number | null, min: 0, max: 1 },
    local: { id: randomUUID(), name: 'Entrega em Canoinhas (demonstração)', kind: 'delivery', description: 'Entrega própria na cidade.', ranges: ['89460000-89469999'], base: 1000, perKg: 0, free: 25000, min: 1, max: 2 },
    regiao: { id: randomUUID(), name: 'Entrega no Planalto Norte (demonstração)', kind: 'delivery', description: 'Mafra, Três Barras, Major Vieira e Porto União.', ranges: ['89300000-89309999', '89400000-89409999', '89480000-89499999'], base: 2500, perKg: 200, free: null, min: 2, max: 4 },
  };
  type ShipKey = keyof typeof shipOpts;
  const snapshot = (k: ShipKey, freight: number) => {
    const o = shipOpts[k];
    return { id: o.id, name: o.name, kind: o.kind, description: o.description, priceCents: freight, minDays: o.min, maxDays: o.max };
  };
  const freightFor = (k: ShipKey, subtotal: number, weightG: number) => {
    const o = shipOpts[k];
    if (o.free && subtotal >= o.free) return 0;
    return o.base + Math.ceil(weightG / 1000) * o.perKg;
  };

  // ---------- planos de pedido e orcamento (antes da simulacao, para estimar a demanda)
  type Line = { variantId: string; packagingId: string; sku: string; productName: string; label: string; baseQty: number; packs: number; list: number; unit: number; total: number; mto: boolean; lead: number | null };
  const randomLines = (n: number, pool: Pack[] | null = null): Line[] => {
    const lines: Line[] = [];
    const used = new Set<string>();
    for (let tries = 0; lines.length < n && tries < n * 6; tries++) {
      const pack = pool ? pick(pool) : (() => {
        const p = weighted(sellable, (x) => x.weight);
        const v = pick(p.variants);
        return v.sale.length > 1 && chance(0.25) ? v.sale[int(1, v.sale.length - 1)]! : v.sale[0]!;
      })();
      if (used.has(pack.id)) continue;
      used.add(pack.id);
      const v = variantById.get(pack.variantId)!;
      const packs = pack.baseQty >= 500 ? int(1, 2) : pack.baseQty >= 50 ? weighted([1, 2, 3, 4, 5, 6, 8, 10, 12], (x) => 1 / x) : weighted([1, 2, 3, 4, 5, 6, 10, 12, 20], (x) => 1 / x);
      const unit = unitPrice(pack.priceCents!, pack.tiers, packs);
      lines.push({ variantId: v.id, packagingId: pack.id, sku: v.sku, productName: v.productName, label: pack.label, baseQty: pack.baseQty, packs, list: pack.priceCents!, unit, total: unit * packs, mto: v.mto, lead: v.lead });
    }
    return lines;
  };
  const linesWeight = (lines: Line[]) => lines.reduce((s, l) => s + variantById.get(l.variantId)!.weightG * l.baseQty * l.packs, 0);
  /** Momento no passado, mais denso perto de hoje (a loja cresce). */
  const recentTime = (maxDays: number, minDays = 0) => businessHour(NOW - (minDays + maxDays * (1 - Math.sqrt(rnd()))) * DAY);

  type Buyer = Record<string, unknown>;
  type OrderPlan = {
    id: string;
    number: number;
    requestKey: string;
    channel: 'store' | 'sales_desk' | 'mercadolivre' | 'shopee';
    customerId: string | null;
    buyer: Buyer;
    shipTo: Record<string, string | null> | null;
    ship: { key: ShipKey | 'marketplace'; freight: number };
    method: 'pix' | 'card' | 'marketplace';
    lines: Line[];
    discount: number;
    notes: string | null;
    optin: boolean;
    phone: string | null;
    t: { created: number; paid?: number; preparing?: number; ready?: number; shipped?: number; delivered?: number; canceled?: number };
    cancelReason?: string;
    paymentRejectedFirst: boolean;
    quoteId?: string;
    actor: string | null;
    externalId?: string;
  };
  const orders: OrderPlan[] = [];

  /** Etapas a partir do pagamento, cortadas em "agora". */
  const pipeline = (o: OrderPlan, paidAt: number) => {
    o.t.paid = paidAt;
    const steps: [keyof OrderPlan['t'], number][] = [
      ['preparing', paidAt + (1 + rnd() * 20) * HOUR],
      ['ready', 0],
      ['shipped', 0],
      ['delivered', 0],
    ];
    steps[1]![1] = steps[0]![1] + (1 + rnd() * 18) * HOUR;
    steps[2]![1] = steps[1]![1] + (o.ship.key === 'pickup' ? (0.5 + rnd() * 30) * HOUR : (1 + rnd() * 20) * HOUR);
    steps[3]![1] = steps[2]![1] + (o.ship.key === 'pickup' ? 5 * MIN : (o.ship.key === 'marketplace' ? 2 + rnd() * 5 : 1 + rnd() * 2) * DAY);
    for (const [k, t] of steps) {
      if (t >= NOW) break;
      o.t[k] = t;
    }
  };

  const customerBuyer = (c: Customer) => ({ kind: c.kind, name: c.name, email: c.email, phone: c.phone, document: null, stateRegistration: null });
  const guestBuyer = (i: number) => {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    return { kind: 'pf', name, email: `visitante${String(i).padStart(3, '0')}@demo.invalid`, phone: null, document: null, stateRegistration: null };
  };
  const chooseShip = (city: (typeof CITIES)[number] | null): ShipKey => (!city || chance(0.45) ? 'pickup' : city.region === 'local' ? 'local' : 'regiao');

  // Loja virtual
  for (let i = 0; i < 292; i++) {
    // Os ultimos 22 sao das ultimas 36 horas: pedidos ainda em andamento para as telas de pedidos e expedicao.
    const created = i < 270 ? recentTime(178, 0) : NOW - (10 + rnd() * 36 * 60) * MIN;
    const c = chance(0.7) ? pick(customers) : null;
    const lines = randomLines(weighted([1, 2, 3, 4, 5], (x) => [3, 4, 3, 2, 1][x - 1]!));
    const shipKey = chooseShip(c?.city ?? null);
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const freight = shipKey === 'pickup' ? 0 : freightFor(shipKey, subtotal, linesWeight(lines));
    const optin = Boolean(c?.phone) && chance(0.7);
    const o: OrderPlan = {
      id: randomUUID(), number: 0, requestKey: `demo-${randomUUID()}`, channel: 'store', customerId: c?.id ?? null,
      buyer: c ? customerBuyer(c) : guestBuyer(i), shipTo: shipKey === 'pickup' ? null : c ? c.address : null, ship: { key: c || shipKey === 'pickup' ? shipKey : 'pickup', freight: c || shipKey === 'pickup' ? freight : 0 },
      method: chance(0.62) ? 'pix' : 'card', lines, discount: 0, notes: chance(0.1) ? 'Por favor, separar por tamanho.' : null, optin, phone: c?.phone ?? null,
      t: { created }, paymentRejectedFirst: false, actor: null,
    };
    o.paymentRejectedFirst = o.method === 'card' && chance(0.06);
    const age = (NOW - created) / DAY;
    if (age < 0.25 && chance(0.6)) {
      // Aguardando pagamento (prazo estendido para a demonstracao nao vencer sozinha).
    } else if (chance(0.08)) {
      o.t.canceled = created + (o.method === 'pix' ? 31 : 61) * MIN;
      o.cancelReason = 'Pagamento não confirmado no prazo.';
    } else {
      pipeline(o, created + (2 + rnd() * 60) * MIN);
      if (o.t.preparing && !o.t.shipped && chance(0.04)) {
        o.t.canceled = o.t.preparing + HOUR;
        o.t.ready = undefined;
        o.cancelReason = 'Desistência do cliente (demonstração).';
      }
    }
    orders.push(o);
  }

  // Marketplaces
  const listingPacks = (n: number) => [...new Set(Array.from({ length: n * 3 }, () => weighted(sellable.filter((p) => p.variants.every((v) => !v.mto)), (p) => p.weight)))].slice(0, n).map((p) => pick(p.variants).sale[0]!);
  const mlPacks = listingPacks(30);
  const shopeePacks = listingPacks(20);
  const marketplaceAccounts = { mercadolivre: randomUUID(), shopee: randomUUID() };
  for (const [channel, n, packs] of [['mercadolivre', 34, mlPacks], ['shopee', 24, shopeePacks]] as const) {
    for (let i = 0; i < n; i++) {
      const created = recentTime(170, 0);
      const ext = `${channel === 'mercadolivre' ? '20000' : '26111'}${String(int(1000000, 9999999))}`;
      const label = channel === 'mercadolivre' ? 'Mercado Livre' : 'Shopee';
      const o: OrderPlan = {
        id: randomUUID(), number: 0, requestKey: `mkt:${channel}:${marketplaceAccounts[channel]}:${ext}`, channel, customerId: null,
        buyer: { name: `Comprador ${label}`, marketplace: channel, marketplaceOrderId: ext }, shipTo: null, ship: { key: 'marketplace', freight: 0 }, method: 'marketplace',
        lines: randomLines(weighted([1, 2, 3], (x) => [6, 3, 1][x - 1]!), packs as Pack[]), discount: 0, notes: `Venda ${label} nº ${ext}`, optin: false, phone: null,
        t: { created }, paymentRejectedFirst: false, actor: null, externalId: ext,
      };
      pipeline(o, created);
      orders.push(o);
    }
  }

  // Orcamentos do balcao (parte vira pedido)
  type QuotePlan = { id: string; number: number; created: number; buyer: Buyer; customerId: string | null; ship: ShipKey | null; shipTo: Record<string, string | null> | null; lines: Line[]; discount: number; freight: number; notes: string | null; validUntil: number; status: 'open' | 'converted' | 'canceled'; sharedAt: number | null; canceledAt: number | null; cancelReason: string | null; convertedAt: number | null; orderId: string | null; actor: string };
  const quotes: QuotePlan[] = [];
  for (let i = 0; i < 240; i++) {
    const created = recentTime(150, 0);
    const known = chance(0.6) ? pick(customers) : null;
    const buyer = known ? customerBuyer(known) : { kind: chance(0.3) ? 'pj' : 'pf', name: chance(0.3) ? `${pick(BUSINESS)} ${pick(BUSINESS_NAME)}` : `${pick(FIRST)} ${pick(LAST)}`, email: null, phone: null, document: null, stateRegistration: null };
    const lines = randomLines(int(2, 8));
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const ship: ShipKey | null = chance(0.5) ? chooseShip(known?.city ?? null) : null;
    const shipKey = ship && ship !== 'pickup' && !known ? 'pickup' : ship;
    const freight = shipKey && shipKey !== 'pickup' ? freightFor(shipKey, subtotal, linesWeight(lines)) : 0;
    const discount = subtotal > 30000 && chance(0.4) ? Math.round((subtotal * int(2, 5)) / 100) : 0;
    const q: QuotePlan = {
      id: randomUUID(), number: 0, created, buyer, customerId: known?.id ?? null, ship: shipKey, shipTo: shipKey && shipKey !== 'pickup' && known ? known.address : null, lines, discount, freight,
      notes: chance(0.2) ? 'Valores para pagamento à vista.' : null, validUntil: created + 7 * DAY, status: 'open', sharedAt: chance(0.65) ? created + (5 + rnd() * 120) * MIN : null,
      canceledAt: null, cancelReason: null, convertedAt: null, orderId: null, actor: pick(SALES),
    };
    const age = (NOW - created) / DAY;
    if (age > 1 && chance(age > 14 ? 0.45 : 0.36)) {
      const conv = created + (0.3 + rnd() * Math.min(5, age - 0.5)) * DAY;
      q.status = 'converted';
      q.convertedAt = conv;
      const o: OrderPlan = {
        id: randomUUID(), number: 0, requestKey: `demo-quote-${q.id}`, channel: 'sales_desk', customerId: q.customerId, buyer: { ...buyer, email: buyer.email ?? `balcao${String(i).padStart(3, '0')}@demo.invalid` },
        shipTo: q.shipTo, ship: { key: shipKey ?? 'pickup', freight }, method: chance(0.7) ? 'pix' : 'card', lines, discount, notes: q.notes, optin: false, phone: null,
        t: { created: conv }, paymentRejectedFirst: false, quoteId: q.id, actor: q.actor,
      };
      pipeline(o, conv + (5 + rnd() * 90) * MIN);
      q.orderId = o.id;
      orders.push(o);
    } else if (age > 1 && chance(age > 14 ? 0.5 : 0.18)) {
      q.status = 'canceled';
      q.canceledAt = created + (0.5 + rnd() * Math.min(6, age - 0.5)) * DAY;
      q.cancelReason = pick(['Cliente comprou em outro lugar.', 'Evento cancelado.', 'Preço acima do esperado.', 'Cliente pediu novo orçamento com outras medidas.']);
    }
    quotes.push(q);
  }

  // Numeracao em ordem de data
  const firstOrder = Number((await db.query<{ n: string }>(`SELECT nextval('order_number') AS n`)).rows[0]!.n);
  orders.sort((a, b) => a.t.created - b.t.created).forEach((o, i) => (o.number = firstOrder + i));
  const firstQuote = Number((await db.query<{ n: string }>(`SELECT nextval('quote_number') AS n`)).rows[0]!.n);
  quotes.sort((a, b) => a.created - b.created).forEach((q, i) => (q.number = firstQuote + i));

  // ---------- simulacao do estoque em ordem de data
  const demand = new Map<string, number>();
  for (const o of orders) for (const l of o.lines) demand.set(l.variantId, (demand.get(l.variantId) ?? 0) + l.baseQty * l.packs);

  type State = { onHand: number; reserved: number; avg: number };
  const state = new Map<string, State>(allVariants.map((v) => [v.id, { onHand: 0, reserved: 0, avg: 0 }]));
  const movements: unknown[][] = [];
  const move = (t: number, variantId: string, kind: string, dOn: number, dRes: number, cost: number | null, sourceType: string | null, sourceId: string | null, reason: string | null, actor: string | null) => {
    const s = state.get(variantId)!;
    if (cost !== null && dOn > 0) s.avg = r4((s.onHand * s.avg + dOn * cost) / (s.onHand + dOn));
    s.onHand += dOn;
    s.reserved += dRes;
    if (s.onHand < 0 || s.reserved < 0) throw new Error(`simulacao: saldo negativo em ${variantById.get(variantId)!.sku}`);
    movements.push([variantId, kind, dOn, dRes, s.onHand, s.reserved, cost === null ? null : cost.toFixed(4), s.avg.toFixed(4), sourceType, sourceId, reason, actor, at(t)]);
  };

  type POItem = { id: string; variantId: string; pack: Pack; packs: number; cost: number; received: number };
  type Receipt = { id: string; at: number; items: { itemId: string; packs: number; baseQty: number; unitCost: number }[]; invoiceRef: string | null };
  type PO = { id: string; number: number; supplierIdx: number; status: string; createdAt: number; sentAt: number | null; closedAt: number | null; expectedAt: number | null; freight: number; notes: string | null; cancelReason: string | null; createdBy: string; items: Map<string, POItem>; receipts: Receipt[] };
  const pos: PO[] = [];
  const costOf = new Map<string, number[]>(); // custo da embalagem de compra por fornecedor
  const supplierProducts: unknown[][] = [];
  for (const v of allVariants) {
    const base = Math.max(1, Math.round(v.unitCost * v.purchase.baseQty));
    const costs = v.suppliers.map((sid, k) => {
      const c = Math.max(1, Math.round(base * (k === 0 ? 1 : 0.94 + rnd() * 0.14)));
      supplierProducts.push([randomUUID(), sid, v.purchase.id, `${v.sku}-F${k + 1}`, c, SUPPLIERS[supplierIds.indexOf(sid)]!.lead, dateOnly(NOW - int(5, 90) * DAY)]);
      return c;
    });
    costOf.set(v.id, costs);
  }
  const newPO = (supplierIdx: number, createdAt: number, status: string, createdBy: string): PO => {
    const po: PO = { id: randomUUID(), number: 0, supplierIdx, status, createdAt, sentAt: status === 'draft' ? null : createdAt + 2 * HOUR, closedAt: null, expectedAt: null, freight: 0, notes: null, cancelReason: null, createdBy, items: new Map(), receipts: [] };
    po.expectedAt = createdAt + SUPPLIERS[supplierIdx]!.lead * DAY;
    pos.push(po);
    return po;
  };
  const addItem = (po: PO, v: Variant, packs: number) => {
    let it = po.items.get(v.purchase.id);
    const k = Math.max(0, v.suppliers.indexOf(supplierIds[po.supplierIdx]!));
    if (!it) {
      it = { id: randomUUID(), variantId: v.id, pack: v.purchase, packs: 0, cost: Math.max(1, Math.round(costOf.get(v.id)![k]! * (0.97 + rnd() * 0.08))), received: 0 };
      po.items.set(v.purchase.id, it);
    }
    it.packs += packs;
    return it;
  };
  const receive = (po: PO, t: number, items: { it: POItem; packs: number }[]) => {
    const r: Receipt = { id: randomUUID(), at: t, items: [], invoiceRef: chance(0.7) ? `NF ${int(1000, 99999)}` : null };
    for (const { it, packs } of items) {
      const baseQty = packs * it.pack.baseQty;
      const unitCost = r4(it.cost / it.pack.baseQty);
      it.received += packs;
      r.items.push({ itemId: it.id, packs, baseQty, unitCost });
      move(t, it.variantId, 'receipt', baseQty, 0, unitCost, 'purchase_receipt', r.id, null, STOCK);
    }
    po.receipts.push(r);
    po.closedAt = t;
  };
  const openRestock = new Map<string, PO>();
  /** Compra que chega a tempo de cobrir a necessidade (o estoque nunca fica negativo). */
  const restock = (t: number, v: Variant, need: number) => {
    const sIdx = supplierIds.indexOf(v.suppliers[0]!);
    const bucket = `${sIdx}:${Math.floor(t / (4 * DAY))}`;
    let po = openRestock.get(bucket);
    if (!po) {
      po = newPO(sIdx, t - (SUPPLIERS[sIdx]!.lead + 1) * DAY - rnd() * DAY, 'received', MANAGER);
      openRestock.set(bucket, po);
    }
    const extra = Math.ceil((demand.get(v.id) ?? 0) * 0.3);
    const packs = Math.max(1, Math.ceil((need + extra + v.minStock) / v.purchase.baseQty));
    receive(po, t - HOUR, [{ it: addItem(po, v, packs), packs }]);
  };

  type Ev = { t: number; run: () => void };
  const events: Ev[] = [];

  // Estoque inicial: um pedido de compra recebido por fornecedor
  events.push({
    t: START,
    run: () => {
      const bySupplier = new Map<number, Variant[]>();
      for (const v of allVariants) {
        if (v.draft) continue;
        const sIdx = supplierIds.indexOf(v.suppliers[0]!);
        bySupplier.set(sIdx, [...(bySupplier.get(sIdx) ?? []), v]);
      }
      for (const [sIdx, vs] of bySupplier) {
        const po = newPO(sIdx, START - 8 * DAY, 'received', OWNER);
        po.notes = 'Estoque inicial (demonstração).';
        po.freight = int(80, 400) * 100;
        const items = vs.map((v) => {
          const packs = Math.max(1, Math.ceil((Math.ceil((demand.get(v.id) ?? 0) * 0.35) + v.minStock * 2) / v.purchase.baseQty));
          return { it: addItem(po, v, packs), packs };
        });
        receive(po, START, items);
      }
    },
  });

  const reservations: unknown[][] = [];
  const resOf = new Map<string, { id: string; variantId: string; qty: number; backorder: boolean }[]>();
  for (const o of orders) {
    events.push({
      t: o.t.created,
      run: () => {
        const per = new Map<string, number>();
        for (const l of o.lines) per.set(l.variantId, (per.get(l.variantId) ?? 0) + l.baseQty * l.packs);
        const list: { id: string; variantId: string; qty: number; backorder: boolean }[] = [];
        for (const [vid, qty] of per) {
          const v = variantById.get(vid)!;
          const s = state.get(vid)!;
          if (!v.mto && s.onHand - s.reserved < qty) restock(o.t.created, v, qty - (s.onHand - s.reserved));
          const backorder = v.mto && s.onHand - s.reserved < qty;
          const id = randomUUID();
          list.push({ id, variantId: vid, qty, backorder });
          move(o.t.created, vid, 'reserve', 0, qty, null, 'reservation', id, null, null);
        }
        resOf.set(o.id, list);
      },
    });
    if (o.t.canceled) {
      events.push({
        t: o.t.canceled,
        run: () => {
          for (const r of resOf.get(o.id)!) {
            move(o.t.canceled!, r.variantId, 'release', 0, -r.qty, null, 'reservation', r.id, null, o.cancelReason?.startsWith('Pagamento') ? null : SHIP);
            reservations.push([r.id, r.variantId, r.qty, 'released', r.backorder, 'order', o.id, null, at(o.t.created), at(o.t.canceled!)]);
          }
        },
      });
    } else if (o.t.shipped) {
      events.push({
        t: o.t.shipped,
        run: () => {
          for (const r of resOf.get(o.id)!) {
            const v = variantById.get(r.variantId)!;
            if (state.get(r.variantId)!.onHand < r.qty) restock(o.t.shipped!, v, r.qty - state.get(r.variantId)!.onHand);
            move(o.t.shipped!, r.variantId, 'sale', -r.qty, -r.qty, null, 'order', o.id, null, SHIP);
            reservations.push([r.id, r.variantId, r.qty, 'consumed', r.backorder, 'order', o.id, null, at(o.t.created), at(o.t.shipped!)]);
          }
        },
      });
    }
  }

  // Perdas, avarias e ajustes
  const lossReasons = ['Embalagem danificada no recebimento.', 'Avaria no transporte.', 'Queda na loja.', 'Produto com defeito de fábrica.'];
  for (let i = 0; i < 18; i++) {
    const t = recentTime(170, 1);
    const v = weighted(sellable, (p) => p.weight).variants[0]!;
    events.push({
      t,
      run: () => {
        const s = state.get(v.id)!;
        const q = Math.min(s.onHand - s.reserved, Math.max(1, Math.round(v.sale[0]!.baseQty * int(1, 2))));
        if (q <= 0) return;
        const kind = i % 6 === 5 ? 'adjustment' : chance(0.5) ? 'loss' : 'damage';
        move(t, v.id, kind, -q, 0, null, 'manual', null, kind === 'adjustment' ? 'Correção de lançamento duplicado.' : pick(lossReasons), STOCK);
      },
    });
  }

  // Inventario fechado ha 60 dias (forminhas e copos) e um aberto em andamento
  const invClosed = { id: randomUUID(), createdAt: NOW - 62 * DAY, closedAt: NOW - 60 * DAY, items: [] as unknown[][] };
  const invVariants = allVariants.filter((v) => !v.draft && (v.famCode === 'FRM' || v.famCode === 'CPO')).slice(0, 24);
  events.push({
    t: invClosed.closedAt,
    run: () => {
      for (const v of invVariants) {
        const s = state.get(v.id)!;
        const system = s.onHand;
        let diff = chance(0.6) ? 0 : int(-30, 20);
        if (system + diff < s.reserved) diff = 0;
        if (diff) move(invClosed.closedAt, v.id, 'inventory', diff, 0, null, 'inventory', invClosed.id, 'Contagem de inventário', STOCK);
        invClosed.items.push([invClosed.id, v.id, system, system + diff, diff, STOCK, at(invClosed.closedAt - 3 * HOUR)]);
      }
    },
  });

  // Compras em andamento (ultimos dias): enviadas, parciais, rascunhos e canceladas
  const openPOs: PO[] = [];
  const recentPO = (status: string, daysAgo: number) => {
    const sIdx = int(0, SUPPLIERS.length - 1);
    const po = newPO(sIdx, businessHour(NOW - daysAgo * DAY), status, MANAGER);
    const vs = allVariants.filter((v) => !v.draft && v.suppliers.includes(supplierIds[sIdx]!));
    for (const v of [...vs].sort(() => rnd() - 0.5).slice(0, int(2, 6))) addItem(po, v, int(1, 4));
    po.closedAt = null;
    if (status === 'canceled') {
      po.cancelReason = 'Fornecedor sem prazo de entrega.';
      po.closedAt = po.createdAt + DAY;
    }
    openPOs.push(po);
    return po;
  };
  for (let i = 0; i < 4; i++) recentPO('sent', int(1, 6));
  for (let i = 0; i < 3; i++) recentPO('draft', int(0, 3));
  for (let i = 0; i < 2; i++) recentPO('canceled', int(8, 30));
  for (let i = 0; i < 2; i++) {
    const po = recentPO('partial', int(6, 12));
    events.push({ t: po.createdAt + 4 * DAY, run: () => receive(po, po.createdAt + 4 * DAY, [...po.items.values()].slice(0, 2).map((it) => ({ it, packs: Math.max(1, Math.floor(it.packs / 2)) }))) });
    po.closedAt = null;
  }

  events.sort((a, b) => a.t - b.t);
  for (const e of events) e.run();
  for (const po of pos.filter((p) => p.status === 'partial')) po.closedAt = null;

  // Reservas ainda ativas (pedidos em aberto)
  for (const o of orders) {
    if (o.t.canceled || o.t.shipped) continue;
    for (const r of resOf.get(o.id)!) reservations.push([r.id, r.variantId, r.qty, 'active', r.backorder, 'order', o.id, null, at(o.t.created), null]);
  }

  // Numeracao das compras em ordem de data
  const firstPO = Number((await db.query<{ n: string }>(`SELECT nextval('purchase_order_number') AS n`)).rows[0]!.n);
  pos.sort((a, b) => a.createdAt - b.createdAt).forEach((p, i) => (p.number = firstPO + i));

  // ---------------------------------------------------------------- gravacao
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.user_id', $1, true)`, [OWNER]);

  await insertRows('users', ['id', 'email', 'name', 'role', 'password_hash', 'created_at'], userRows);
  await insertRows('categories', ['id', 'parent_id', 'name', 'slug', 'position'], catRows);

  const productRows: unknown[][] = [];
  const variantRows: unknown[][] = [];
  const packRows: unknown[][] = [];
  const tierRows: unknown[][] = [];
  const fiscalRows: unknown[][] = [];
  FAMILIES.forEach((f) => {
    f.sizes.forEach((size) => {
      const p = products.find((x) => x.name === f.name(size))!;
      const v0 = p.variants[0]!;
      const fi = f.sizes.indexOf(size);
      productRows.push([
        p.id, catId[f.cat]!, p.name, slugify(p.name), `${f.material}. Vendido em: ${f.packs.map((k) => k[0].toLowerCase()).join(', ')}.`, null, null, p.status, f.unit ?? 'UN',
        turnover.get(p.id) ?? null, v0.mto ? 'made_to_order' : 'stock', v0.lead, v0.minStock,
        JSON.stringify([{ label: 'Material', value: f.material }, { label: 'Medida', value: size }, ...(f.attr ? [{ label: f.attr[0], value: f.attr[1].join(', ') }] : [])]), at(START - 15 * DAY),
      ]);
      fiscalRows.push([p.id]);
      p.variants.forEach((v, k) => {
        const [l, w, h] = f.dims(fi);
        variantRows.push([v.id, p.id, v.sku, JSON.stringify(f.attr ? { [f.attr[0]]: f.attr[1][k] } : {}), k, v.weightG, l, w, h]);
        for (const pk of [...v.sale, v.purchase]) {
          packRows.push([pk.id, v.id, pk.kind, pk.label, pk.unit, pk.baseQty, pk.priceCents, pk.isDefault, pk.position]);
          for (const t of pk.tiers) tierRows.push([randomUUID(), pk.id, t.minPacks, t.priceCents]);
        }
      });
    });
  });
  await insertRows('products', ['id', 'category_id', 'name', 'slug', 'summary', 'description', 'brand', 'status', 'base_unit', 'turnover', 'availability_mode', 'lead_time_days', 'min_stock', 'specs', 'created_at'], productRows);
  await insertRows('product_variants', ['id', 'product_id', 'sku', 'attributes', 'position', 'weight_g', 'length_mm', 'width_mm', 'height_mm'], variantRows);
  await insertRows('packagings', ['id', 'variant_id', 'kind', 'label', 'unit_code', 'base_qty', 'price_cents', 'is_default', 'position'], packRows);
  await insertRows('price_tiers', ['id', 'packaging_id', 'min_packs', 'price_cents'], tierRows);
  // Classificacao fiscal pendente: NCM e origem sao do contador, nao do seed.
  await insertRows('product_fiscal', ['product_id'], fiscalRows);
  // Alguns reajustes para o historico de precos
  for (const p of sellable.slice(0, 15)) {
    const pk = p.variants[0]!.sale[0]!;
    await db.query('UPDATE packagings SET price_cents = $2 WHERE id = $1', [pk.id, round10(pk.priceCents! * 1.06)]);
    await db.query('UPDATE packagings SET price_cents = $2 WHERE id = $1', [pk.id, pk.priceCents]);
  }

  await insertRows(
    'suppliers',
    ['id', 'name', 'city', 'uf', 'payment_terms', 'lead_time_days', 'min_order_cents', 'freight_terms', 'notes', 'email', 'created_at'],
    SUPPLIERS.map((s, i) => [supplierIds[i], s.name, s.city, s.uf, s.terms, s.lead, int(3, 15) * 10000, chance(0.5) ? 'CIF acima do pedido mínimo' : 'FOB', 'Fornecedor fictício da demonstração.', `compras${i + 1}@demo.invalid`, at(START - 30 * DAY)]),
  );
  await insertRows('supplier_contacts', ['id', 'supplier_id', 'name', 'role', 'email'], SUPPLIERS.map((_, i) => [randomUUID(), supplierIds[i], `${pick(FIRST)} ${pick(LAST)}`, 'Representante', `representante${i + 1}@demo.invalid`]));
  await insertRows('supplier_products', ['id', 'supplier_id', 'packaging_id', 'supplier_sku', 'cost_cents', 'lead_time_days', 'quoted_at'], supplierProducts);

  await insertRows(
    'shipping_options',
    ['id', 'name', 'kind', 'description', 'cep_ranges', 'base_cents', 'per_kg_cents', 'free_above_cents', 'min_days', 'max_days', 'position'],
    Object.values(shipOpts).map((o, i) => [o.id, o.name, o.kind, o.description, o.ranges, o.base, o.perKg, o.free, o.min, o.max, i]),
  );

  await insertRows('customers', ['id', 'kind', 'name', 'email', 'phone', 'password_hash', 'created_at', 'updated_at'], customers.map((c) => [c.id, c.kind, c.name, c.email, c.phone, customerHash, at(c.createdAt), at(c.createdAt)]));
  await insertRows(
    'customer_addresses',
    ['id', 'customer_id', 'label', 'recipient', 'cep', 'street', 'number', 'complement', 'district', 'city', 'uf', 'is_default', 'created_at'],
    customers.map((c) => [randomUUID(), c.id, c.address.label, c.address.recipient, c.address.cep, c.address.street, c.address.number, c.address.complement, c.address.district, c.address.city, 'SC', true, at(c.createdAt)]),
  );

  // Compras
  const poRows: unknown[][] = [];
  const poItemRows: unknown[][] = [];
  const receiptRows: unknown[][] = [];
  const receiptItemRows: unknown[][] = [];
  for (const po of pos) {
    const allReceived = [...po.items.values()].every((it) => it.received >= it.packs);
    const status = po.status === 'received' && !allReceived ? 'partial' : po.status;
    poRows.push([po.id, po.number, supplierIds[po.supplierIdx], status, po.expectedAt ? dateOnly(po.expectedAt) : null, po.freight, po.notes, po.createdBy, at(po.createdAt), po.sentAt ? at(po.sentAt) : null, po.closedAt && (status === 'received' || status === 'canceled') ? at(po.closedAt) : null, po.cancelReason, at(po.closedAt ?? po.createdAt)]);
    for (const it of po.items.values()) poItemRows.push([it.id, po.id, it.variantId, it.pack.id, it.pack.label, it.pack.baseQty, it.packs, it.cost, it.received]);
    for (const r of po.receipts) {
      receiptRows.push([r.id, po.id, `demo-${r.id}`, r.invoiceRef, po.createdBy === OWNER ? OWNER : STOCK, at(r.at)]);
      for (const ri of r.items) receiptItemRows.push([r.id, ri.itemId, ri.packs, ri.baseQty, ri.unitCost.toFixed(4)]);
    }
  }
  await insertRows('purchase_orders', ['id', 'number', 'supplier_id', 'status', 'expected_at', 'freight_cents', 'notes', 'created_by', 'created_at', 'sent_at', 'closed_at', 'cancel_reason', 'updated_at'], poRows);
  await db.query(`SELECT setval('purchase_order_number', $1)`, [firstPO + pos.length - 1]);
  await insertRows('purchase_order_items', ['id', 'order_id', 'variant_id', 'packaging_id', 'packaging_label', 'base_qty_per_pack', 'packs', 'pack_cost_cents', 'received_packs'], poItemRows);
  await insertRows('purchase_receipts', ['id', 'order_id', 'request_key', 'invoice_ref', 'received_by', 'received_at'], receiptRows);
  await insertRows('purchase_receipt_items', ['receipt_id', 'item_id', 'packs', 'base_qty', 'unit_cost_cents'], receiptItemRows);

  // Inventarios
  const invOpen = { id: randomUUID(), createdAt: NOW - 1 * DAY };
  await insertRows('inventory_counts', ['id', 'status', 'notes', 'created_by', 'created_at', 'closed_by', 'closed_at'], [
    [invClosed.id, 'closed', 'Inventário de forminhas e copos (demonstração).', STOCK, at(invClosed.createdAt), MANAGER, at(invClosed.closedAt)],
    [invOpen.id, 'open', 'Contagem de caixas em andamento (demonstração).', STOCK, at(invOpen.createdAt), null, null],
  ]);
  const openItems = allVariants.filter((v) => !v.draft && v.famCode === 'CXD').slice(0, 12);
  await insertRows('inventory_count_items', ['count_id', 'variant_id', 'system_qty', 'counted_qty', 'diff_qty', 'counted_by', 'counted_at'], [
    ...invClosed.items,
    ...openItems.map((v, i) => [invOpen.id, v.id, null, i < 7 ? Math.max(0, state.get(v.id)!.onHand + (chance(0.7) ? 0 : int(-5, 5))) : null, null, i < 7 ? STOCK : null, i < 7 ? at(NOW - 3 * HOUR) : null]),
  ]);

  // Pedidos
  const orderRows: unknown[][] = [];
  const itemRows: unknown[][] = [];
  const eventRows: unknown[][] = [];
  const paymentRows: unknown[][] = [];
  const shipmentRows: unknown[][] = [];
  const statusOf = (o: OrderPlan) =>
    o.t.canceled ? 'canceled' : o.t.delivered ? 'delivered' : o.t.shipped ? 'shipped' : o.t.ready ? 'ready' : o.t.preparing ? 'preparing' : o.t.paid ? 'paid' : 'pending_payment';
  const OPTIN = 'Aceito receber avisos deste pedido pelo WhatsApp (demonstração).';
  for (const o of orders) {
    const status = statusOf(o);
    const subtotal = o.lines.reduce((s, l) => s + l.total, 0);
    const total = subtotal - o.discount + o.ship.freight;
    const ship = o.ship.key === 'marketplace' ? { id: null, kind: 'marketplace', name: `Envio pelo ${o.channel === 'mercadolivre' ? 'Mercado Livre' : 'Shopee'}`, priceCents: 0 } : snapshot(o.ship.key, o.ship.freight);
    const last = Math.max(...Object.values(o.t).filter((x): x is number => typeof x === 'number'));
    const backorder = (resOf.get(o.id) ?? []).some((r) => r.backorder);
    const invoice = status === 'shipped' || status === 'delivered' ? 'not_required' : 'pending';
    const due = status === 'pending_payment' ? NOW + 2 * DAY : o.t.created + (o.method === 'pix' ? 30 : 60) * MIN;
    orderRows.push([
      o.id, o.number, sha256(publicToken(o.requestKey)), o.requestKey, o.customerId, o.channel, status, JSON.stringify(o.buyer), o.shipTo ? JSON.stringify(o.shipTo) : null, ship.id, JSON.stringify(ship), o.method,
      subtotal, o.discount, o.ship.freight, total, o.notes, invoice, backorder, new Date(due), o.t.paid ? at(o.t.paid) : null, o.t.canceled ? at(o.t.canceled) : null, o.cancelReason ?? null,
      at(o.t.created), at(last), o.optin ? OPTIN : null, o.optin ? at(o.t.created) : null,
    ]);
    for (const l of o.lines) itemRows.push([randomUUID(), o.id, l.variantId, l.packagingId, l.sku, l.productName, l.label, l.baseQty, l.packs, l.list, l.unit, l.total, l.mto, l.lead]);
    const ev = (st: string, t: number | undefined, note: string | null, actor: string | null) => t && eventRows.push([o.id, st, note, actor, at(t)]);
    const marketName = o.channel === 'mercadolivre' ? 'Mercado Livre' : 'Shopee';
    if (o.method === 'marketplace') ev('paid', o.t.created, `Venda importada do ${marketName} (nº ${o.externalId}, situação paid).`, null);
    else ev('pending_payment', o.t.created, o.quoteId ? `Pedido criado do orçamento nº ${quotes.find((q) => q.id === o.quoteId)!.number}` : o.method === 'pix' ? 'Pedido criado, aguardando Pix' : 'Pedido criado, aguardando cartão', o.actor);
    if (o.method !== 'marketplace') ev('paid', o.t.paid, 'Pagamento aprovado', null);
    ev('preparing', o.t.preparing, null, SHIP);
    ev('ready', o.t.ready, null, SHIP);
    ev('shipped', o.t.shipped, null, SHIP);
    ev('delivered', o.t.delivered, null, SHIP);
    ev('canceled', o.t.canceled, o.cancelReason ?? null, o.cancelReason?.startsWith('Pagamento') ? null : SHIP);
    if (o.method !== 'marketplace') {
      const pay = (st: string, t: number, upd: number) =>
        paymentRows.push([randomUUID(), o.id, 'fake', o.method, randomUUID(), `demo-${randomUUID().slice(0, 13)}`, st, null, total, o.method === 'card' ? String(int(1000, 9999)) : null, o.method === 'card' ? pick(['visa', 'master', 'elo']) : null, o.method === 'card' ? int(1, 3) : null, at(t), at(upd)]);
      if (o.paymentRejectedFirst) pay('rejected', o.t.created + MIN, o.t.created + 2 * MIN);
      if (o.t.paid) pay(o.t.canceled ? 'refunded' : 'approved', o.t.created + 3 * MIN, o.t.canceled ?? o.t.paid);
      else if (o.t.canceled) pay(o.method === 'pix' ? 'canceled' : 'rejected', o.t.created + MIN, o.t.canceled);
      else pay('pending', o.t.created + MIN, o.t.created + MIN);
    }
    if (o.t.shipped) {
      const weight = Math.max(1, Math.round(linesWeight(o.lines)));
      const carrier = o.ship.key === 'marketplace' ? (o.channel === 'mercadolivre' ? 'Mercado Envios' : 'Shopee Xpress') : o.ship.key === 'pickup' ? null : 'Entrega própria';
      shipmentRows.push([randomUUID(), o.id, carrier, o.ship.key === 'marketplace' ? `DEMO${int(100000000, 999999999)}BR` : null, int(1, 3), weight, at(o.t.shipped), o.t.delivered ? at(o.t.delivered) : null, SHIP, at(o.t.shipped)]);
    }
  }
  await insertRows(
    'orders',
    ['id', 'number', 'public_token_hash', 'request_key', 'customer_id', 'channel', 'status', 'buyer', 'ship_to', 'shipping_option_id', 'shipping_snapshot', 'payment_method', 'subtotal_cents', 'discount_cents', 'freight_cents', 'total_cents', 'notes', 'invoice_status', 'has_backorder', 'payment_due_at', 'paid_at', 'canceled_at', 'cancel_reason', 'created_at', 'updated_at', 'whatsapp_optin_text', 'whatsapp_optin_at'],
    orderRows,
  );
  await db.query(`SELECT setval('order_number', $1)`, [firstOrder + orders.length - 1]);
  await insertRows('order_items', ['id', 'order_id', 'variant_id', 'packaging_id', 'sku', 'product_name', 'packaging_label', 'base_qty_per_pack', 'packs', 'list_price_cents', 'unit_price_cents', 'total_cents', 'made_to_order', 'lead_time_days'], itemRows);
  eventRows.sort((a, b) => (a[4] as Date).getTime() - (b[4] as Date).getTime());
  await insertRows('order_events', ['order_id', 'status', 'note', 'actor_id', 'created_at'], eventRows);
  await insertRows('payments', ['id', 'order_id', 'provider', 'method', 'idempotency_key', 'provider_payment_id', 'status', 'status_detail', 'amount_cents', 'card_last_four', 'card_brand', 'installments', 'created_at', 'updated_at'], paymentRows);
  await insertRows('shipments', ['id', 'order_id', 'carrier', 'tracking_code', 'volumes', 'weight_g', 'shipped_at', 'delivered_at', 'shipped_by', 'created_at'], shipmentRows);

  // Estoque
  await insertRows('stock_reservations', ['id', 'variant_id', 'qty', 'status', 'backorder', 'source_type', 'source_id', 'expires_at', 'created_at', 'closed_at'], reservations);
  await insertRows('stock_movements', ['variant_id', 'kind', 'on_hand_delta', 'reserved_delta', 'on_hand_after', 'reserved_after', 'unit_cost_cents', 'avg_cost_after', 'source_type', 'source_id', 'reason', 'created_by', 'created_at'], movements);
  await insertRows('stock_balances', ['variant_id', 'on_hand', 'reserved', 'avg_cost_cents'], allVariants.filter((v) => !v.draft).map((v) => {
    const s = state.get(v.id)!;
    return [v.id, s.onHand, s.reserved, s.avg.toFixed(4)];
  }));

  // Orcamentos
  const quoteRows: unknown[][] = [];
  const quoteItemRows: unknown[][] = [];
  const quoteEventRows: unknown[][] = [];
  for (const q of quotes) {
    const subtotal = q.lines.reduce((s, l) => s + l.total, 0);
    quoteRows.push([
      q.id, q.number, sha256(quoteToken(q.id)), `demo-${q.id}`, q.status, JSON.stringify(q.buyer), q.customerId, q.shipTo ? JSON.stringify(q.shipTo) : null, q.ship ? shipOpts[q.ship].id : null, q.ship ? JSON.stringify(snapshot(q.ship, q.freight)) : null,
      subtotal, q.discount, q.freight, subtotal - q.discount + q.freight, q.notes, dateOnly(q.validUntil), q.orderId, q.status === 'converted' ? 1 : 0, q.sharedAt ? at(q.sharedAt) : null, q.canceledAt ? at(q.canceledAt) : null, q.cancelReason, q.actor, at(q.created), at(q.convertedAt ?? q.canceledAt ?? q.sharedAt ?? q.created),
    ]);
    q.lines.forEach((l, i) => quoteItemRows.push([randomUUID(), q.id, i, l.variantId, l.packagingId, l.sku, l.productName, l.label, l.baseQty, l.packs, l.list, l.unit, l.total, l.mto, l.lead]));
    quoteEventRows.push([q.id, 'created', null, q.actor, at(q.created)]);
    if (q.sharedAt) quoteEventRows.push([q.id, 'shared', 'Link enviado pelo WhatsApp', q.actor, at(q.sharedAt)]);
    if (q.convertedAt) quoteEventRows.push([q.id, 'converted', `Pedido nº ${orders.find((o) => o.id === q.orderId)!.number}`, q.actor, at(q.convertedAt)]);
    if (q.canceledAt) quoteEventRows.push([q.id, 'canceled', q.cancelReason, q.actor, at(q.canceledAt)]);
  }
  await insertRows('quotes', ['id', 'number', 'public_token_hash', 'request_key', 'status', 'buyer', 'customer_id', 'ship_to', 'shipping_option_id', 'shipping_snapshot', 'subtotal_cents', 'discount_cents', 'freight_cents', 'total_cents', 'notes', 'valid_until', 'order_id', 'conversions', 'shared_at', 'canceled_at', 'cancel_reason', 'created_by', 'created_at', 'updated_at'], quoteRows);
  await db.query(`SELECT setval('quote_number', $1)`, [firstQuote + quotes.length - 1]);
  await insertRows('quote_items', ['id', 'quote_id', 'position', 'variant_id', 'packaging_id', 'sku', 'product_name', 'packaging_label', 'base_qty_per_pack', 'packs', 'list_price_cents', 'unit_price_cents', 'total_cents', 'made_to_order', 'lead_time_days'], quoteItemRows);
  quoteEventRows.sort((a, b) => (a[4] as Date).getTime() - (b[4] as Date).getTime());
  await insertRows('quote_events', ['quote_id', 'kind', 'note', 'actor_id', 'created_at'], quoteEventRows);

  // Marketplaces: contas desconectadas (a rotina nunca chama a API com elas)
  await insertRows('marketplace_accounts', ['id', 'channel', 'external_id', 'name', 'status', 'last_error', 'connected_by', 'created_at', 'updated_at'], [
    [marketplaceAccounts.mercadolivre, 'mercadolivre', 'DEMO-ML', 'Conta Mercado Livre (demonstração)', 'disconnected', 'Conta de demonstração: não conectada.', OWNER, at(START), at(START)],
    [marketplaceAccounts.shopee, 'shopee', 'DEMO-SHOPEE', 'Conta Shopee (demonstração)', 'disconnected', 'Conta de demonstração: não conectada.', OWNER, at(START), at(START)],
  ]);
  const listingRows: unknown[][] = [];
  for (const [acc, packs, prefix] of [[marketplaceAccounts.mercadolivre, mlPacks, 'MLB9'], [marketplaceAccounts.shopee, shopeePacks, '2299']] as const) {
    packs.forEach((pk, i) => {
      const v = variantById.get(pk.variantId)!;
      const s = state.get(v.id)!;
      listingRows.push([randomUUID(), acc, `${prefix}${String(100000 + i)}`, '', pk.id, `${v.productName} ${pk.label}`.slice(0, 200), true, true, Math.max(0, Math.floor((s.onHand - s.reserved) / pk.baseQty)), at(NOW - 2 * HOUR), OWNER, at(START)]);
    });
  }
  await insertRows('marketplace_listings', ['id', 'account_id', 'external_item_id', 'external_variation_id', 'packaging_id', 'title', 'sync_stock', 'active', 'last_pushed_qty', 'last_pushed_at', 'created_by', 'created_at'], listingRows);
  const mktRows: unknown[][] = orders
    .filter((o) => o.externalId)
    .map((o) => {
      const status = statusOf(o);
      return [randomUUID(), marketplaceAccounts[o.channel as 'mercadolivre' | 'shopee'], o.externalId, status === 'delivered' ? 'delivered' : status === 'shipped' ? 'shipped' : 'paid', o.id, 'imported', 1, at(o.t.created), at(o.t.created), at(o.t.created)];
    });
  for (let i = 0; i < 4; i++) {
    const t = recentTime(90, 1);
    mktRows.push([randomUUID(), marketplaceAccounts.mercadolivre, `20000${int(1000000, 9999999)}`, 'cancelled', null, 'canceled', 1, at(t), at(t), at(t)]);
  }
  await insertRows('marketplace_orders', ['id', 'account_id', 'external_order_id', 'external_status', 'order_id', 'state', 'check_count', 'next_check_at', 'created_at', 'updated_at'], mktRows);

  // WhatsApp: modelos, avisos ja enviados e mensagens recebidas
  const TEMPLATES = { order_paid: 'pedido_pago_demo', order_ready: 'pedido_pronto_demo', order_shipped: 'pedido_despachado_demo' } as const;
  await insertRows('whatsapp_templates', ['event', 'name', 'language', 'active', 'updated_by'], Object.entries(TEMPLATES).map(([e, n]) => [e, n, 'pt_BR', true, OWNER]));
  const waRows: unknown[][] = [];
  for (const o of orders.filter((x) => x.optin && x.phone)) {
    const msgs: [keyof typeof TEMPLATES, number | undefined][] = [
      ['order_paid', o.t.paid],
      ['order_ready', o.ship.key === 'pickup' ? o.t.ready : undefined],
      ['order_shipped', o.ship.key !== 'pickup' ? o.t.shipped : undefined],
    ];
    for (const [event, t] of msgs) {
      if (!t || o.t.canceled) continue;
      const st = weighted(['read', 'delivered', 'sent', 'failed'] as const, (s) => ({ read: 70, delivered: 20, sent: 7, failed: 3 })[s]);
      const name = String(o.buyer.name).split(' ')[0];
      waRows.push([randomUUID(), o.id, event, 'template', `55${o.phone}`, TEMPLATES[event], 'pt_BR', JSON.stringify({ nome: name, pedido: String(o.number), ...(event === 'order_shipped' ? { rastreio: 'Entrega própria' } : {}) }), null, st, st === 'failed' ? null : `wamid.DEMO${randomUUID().replace(/-/g, '')}`, st === 'failed' ? 'Número sem WhatsApp (demonstração).' : null, 1, at(t + MIN), null, at(t + MIN), at(t + 5 * MIN)]);
    }
  }
  const inboundPhones = customers.filter((c) => c.phone).slice(0, 8);
  const inboundTexts = ['Bom dia! Vocês têm caixa para 12 brigadeiros?', 'Qual o horário de vocês no sábado?', 'Meu pedido já saiu para entrega?', 'Tem forminha nº 4 dourada?', 'Consigo retirar hoje à tarde?', 'Obrigada, chegou tudo certinho!', 'Vocês fazem entrega em Três Barras?', 'Preciso de 500 copos de 200 ml para sexta.'];
  const inboundRows: unknown[][] = [];
  inboundPhones.forEach((c, i) => {
    const t = i < 3 ? NOW - int(10, 300) * MIN : NOW - int(30, 70) * HOUR;
    inboundRows.push([`wamid.INDEMO${randomUUID().replace(/-/g, '')}`, `55${c.phone}`, c.name, 'text', inboundTexts[i % inboundTexts.length], at(t), at(t)]);
    if (i % 2 === 0) waRows.push([randomUUID(), null, null, 'text', `55${c.phone}`, null, null, null, 'Olá! Temos sim. Posso separar para você?', 'read', `wamid.DEMO${randomUUID().replace(/-/g, '')}`, null, 1, at(t + 4 * MIN), pick(SALES), at(t + 4 * MIN), at(t + 9 * MIN)]);
  });
  await insertRows('whatsapp_messages', ['id', 'order_id', 'event', 'kind', 'to_phone', 'template_name', 'language', 'params', 'body', 'status', 'wamid', 'error', 'attempts', 'next_attempt_at', 'created_by', 'created_at', 'updated_at'], waRows);
  await insertRows('whatsapp_inbound', ['wamid', 'from_phone', 'profile_name', 'type', 'body', 'sent_at', 'received_at'], inboundRows);

  const summary = { produtos: products.length, variacoes: allVariants.length, pedidos: orders.length, orcamentos: quotes.length, clientes: customers.length, compras: pos.length, movimentos: movements.length };
  await db.query(`INSERT INTO audit_logs (actor_id, action, entity, metadata) VALUES ($1, 'demo.seed', 'database', $2)`, [OWNER, JSON.stringify(summary)]);
  await db.query('COMMIT');
  console.log('Dados de demonstracao gravados:', summary);
  console.log('Para apagar tudo depois: npm run demo:reset -- --confirmar APAGAR-TUDO');
}

// ---------------------------------------------------------------- reversao

// Ficam: proprietarios (users), as permissoes e sessoes deles, a auditoria (imutavel), a tabela de unidades
// (dado de referencia da migration) e o controle de migrations. As linhas de configuracao voltam ao padrao.
/** Configuracoes de linha unica fora do KEEP: o reset as recria com os valores padrao. */
const SINGLETONS = ['bot_settings', 'email_settings'];
// warehouses (SGLog, 0020): o deposito padrao vem da migration e todo movimento de estoque depende dele.
const KEEP = new Set(['users', 'user_permissions', 'sessions', 'audit_logs', 'units', 'schema_migrations', 'fiscal_settings', 'store_settings', 'warehouses']);

async function resetAll() {
  if (confirm !== 'APAGAR-TUDO') throw new Error('Isto apaga todos os cadastros. Confirme com: npm run demo:reset -- --confirmar APAGAR-TUDO');
  const owner = (await db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' AND is_active ORDER BY created_at LIMIT 1`)).rows[0];
  if (!owner) throw new Error('Nenhum proprietario ativo: a reversao deixaria o sistema sem acesso.');

  // Travas: documento fiscal e pagamento real nunca sao apagados.
  const blockers: string[] = [];
  if ((await db.query(`SELECT 1 FROM fiscal_settings WHERE environment = 'producao'`)).rowCount) blockers.push('a emissao fiscal esta liberada em producao');
  if (await count('SELECT count(*) AS n FROM fiscal_documents')) blockers.push('existem notas fiscais emitidas (mesmo em homologacao)');
  if (await count('SELECT count(*) AS n FROM fiscal_inutilizations')) blockers.push('existem inutilizacoes de numeracao');
  if (await count('SELECT count(*) AS n FROM fiscal_files')) blockers.push('existem arquivos fiscais guardados');
  if (await count('SELECT count(*) AS n FROM purchase_invoices')) blockers.push('existem XML de notas de compra importados');
  if (await count(`SELECT count(*) AS n FROM payments WHERE provider <> 'fake' AND status IN ('approved', 'refunded', 'charged_back')`)) blockers.push('existem pagamentos reais aprovados');
  if (await count('SELECT count(*) AS n FROM marketplace_accounts WHERE access_token_enc IS NOT NULL OR refresh_token_enc IS NOT NULL')) blockers.push('existe conta de marketplace conectada de verdade');
  if (blockers.length) throw new Error(`Reversao recusada: ${blockers.join('; ')}. Estes registros precisam ser guardados.`);

  console.log('Fazendo backup antes de apagar...');
  const backup = spawnSync(process.execPath, [path.join(root, 'scripts/backup.mjs'), 'backup'], { cwd: root, stdio: 'inherit' });
  if (backup.status !== 0) throw new Error('Backup falhou; nada foi apagado.');

  const images = (await db.query<{ k: string }>(`SELECT file_key AS k FROM product_images UNION SELECT logo_key FROM store_settings WHERE logo_key IS NOT NULL`)).rows.map((r) => r.k);
  const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.t).filter((t) => !KEEP.has(t));
  const list = tables.map((t) => `"${t}"`).join(', ');

  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL lock_timeout = '15s'`);
    // Os gatilhos de imutabilidade valem para o uso normal; aqui sao desligados so dentro desta transacao.
    for (const t of tables) await db.query(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    await db.query(`TRUNCATE ${list} RESTART IDENTITY`);
    for (const t of tables) await db.query(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    // Tabelas de linha unica (criadas com INSERT ... DEFAULT VALUES nas migrations) voltam ao padrao, nunca vazias:
    // sem a linha, o bot e o painel de e-mail quebram.
    for (const t of SINGLETONS) if (tables.includes(t)) await db.query(`INSERT INTO "${t}" DEFAULT VALUES ON CONFLICT DO NOTHING`);

    await db.query(`UPDATE fiscal_settings SET environment = 'homologacao', nfe_series = NULL, nfe_next_number = NULL, accreditation_status = 'not_started', accreditation_notes = NULL,
      provider = NULL, production_released_by = NULL, production_released_at = NULL, updated_by = NULL, updated_at = now(), emission_policy = 'manual', production_validator_name = NULL`);
    await db.query(`UPDATE store_settings SET store_name = NULL, tagline = NULL, domain = NULL, logo_key = NULL, colors = '{}', whatsapp_number = NULL, support_email = NULL, pages = '{}',
      updated_by = NULL, updated_at = now()`);

    // Equipe: so os proprietarios ficam. Quem aparece na auditoria nao pode ser apagado (a trilha aponta para o
    // usuario): fica desativado, sem MFA, sem permissoes e sem sessao.
    const inAudit = `id IN (SELECT actor_id FROM audit_logs WHERE actor_id IS NOT NULL)`;
    await db.query(`DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM users WHERE role <> 'owner')`);
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role <> 'owner')`);
    const kept = await db.query(
      `UPDATE users SET is_active = false, totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, updated_at = now() WHERE role <> 'owner' AND ${inAudit}`,
    );
    const removed = await db.query(`DELETE FROM users WHERE role <> 'owner' AND NOT (${inAudit})`);

    const summary = { tabelas: tables.length, usuariosRemovidos: removed.rowCount ?? 0, usuariosDesativados: kept.rowCount ?? 0 };
    await db.query(`INSERT INTO audit_logs (actor_id, action, entity, metadata) VALUES ($1, 'demo.reset', 'database', $2)`, [owner.id, JSON.stringify(summary)]);
    await db.query('COMMIT');
    console.log('Banco limpo:', summary);
    if (summary.usuariosDesativados) console.log('Usuarios que aparecem na Auditoria ficaram desativados (a trilha nao pode perder o autor).');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  // Fotos e logotipo apagados do disco (o banco ja nao aponta para eles).
  const imagesDir = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? '../../storage', 'images');
  for (const k of images) if (/^[a-f0-9-]{36}$/.test(k)) await rm(path.join(imagesDir, k), { recursive: true, force: true });
  if (images.length) console.log(`${images.length} imagem(ns) removida(s) do armazenamento.`);
}

// ----------------------------------------------------------------

await db.connect();
try {
  if (command === 'seed') await seedDemo();
  else if (command === 'reset') await resetAll();
  else throw new Error('Uso: demo.ts seed --confirmar DEMO | demo.ts reset --confirmar APAGAR-TUDO');
} catch (err) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.end();
  // Os modulos importados abrem o pool da API (sem conexoes); encerra para o processo terminar.
  const { pool } = await import('./pool.js');
  await pool.end().catch(() => {});
}
