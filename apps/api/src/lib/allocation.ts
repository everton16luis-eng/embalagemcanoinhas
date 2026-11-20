// SGLog Fase 4: motor de distribuicao (docs/22-sglog-fase4-planejamento.md §4.1 e docs/23-sglog-fase4.md).
// Funcao PURA e deterministica: sem banco, sem relogio proprio (recebe `now`), sem aleatoriedade. A mesma entrada da
// sempre a mesma saida, inclusive a ordem e os textos. Nao grava nada: quem grava e a confirmacao (modules/logistics).
//
// Regras (D4-3 a D4-6, D4-13):
// - estoque proprio antes de fornecedor; o motor nunca troca estoque livre por fornecedor;
// - um deposito proprio por pedido: primeiro um deposito ativo que cubra o pedido inteiro, na ordem padrao ->
//   prioridade cadastrada (menor primeiro) -> codigo;
// - sem deposito que cubra tudo: o padrao com o que tiver, e o resto por encomenda ao fornecedor (entrega no padrao,
//   porque o recebimento de compra ainda e so no padrao); marketplaces so com estoque proprio;
// - dropshipping so aparece com a trava liberada; travado, vira aviso;
// - automatico so no caso simples (um deposito cobre tudo); o resto vai para analise com o motivo.
import { chooseSupplier, type ChoiceSettings, type SupplierOfferInput } from './supplier-choice.js';

export const ENGINE_VERSION = 'f4.1';

export type EngineItem = { orderItemId: string; variantId: string; sku: string; name: string; need: number; madeToOrder: boolean };
export type EngineWarehouse = { id: string; code: string; name: string; isDefault: boolean; priority: number };
/** Livre do deposito para este pedido: disponivel - reservado, devolvendo as reservas do proprio pedido ali. */
export type EngineStock = { warehouseId: string; variantId: string; free: number };

export type EngineInput = {
  orderId: string;
  channel: string;
  items: EngineItem[];
  /** Depositos ativos. */
  warehouses: EngineWarehouse[];
  stock: EngineStock[];
  /** Ofertas por variante (supplier_offer_terms). */
  offers: Record<string, SupplierOfferInput[]>;
  choiceSettings: ChoiceSettings;
  dropshipReleased: boolean;
  /** Marketplaces: so estoque proprio (D4-13). */
  ownOnly: boolean;
  now: Date;
};

export type PlanMode = 'stock' | 'purchase_to_order' | 'dropship';
export type PlanLine = {
  orderItemId: string;
  variantId: string;
  sku: string;
  qty: number;
  mode: PlanMode;
  /** Deposito da reserva (proprio ou destino da encomenda); nulo no dropshipping. */
  warehouseId: string | null;
  offerId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  unitCostCents: number | null;
  leadDays: number | null;
};
export type Plan = {
  key: string;
  label: string;
  lines: PlanLine[];
  /** Custo conhecido da parte de fornecedor (o estoque proprio ja foi pago). */
  supplierCostCents: number;
  /** Maior prazo entre as linhas de fornecedor; 0 quando tudo e estoque proprio. Nulo = desconhecido. */
  leadDays: number | null;
  reasons: string[];
};
export type WarehouseEval = {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  priority: number;
  coversAll: boolean;
  short: { variantId: string; sku: string; need: number; free: number }[];
};
export type EngineOutput = {
  engineVersion: string;
  criteria: string[];
  automatic: boolean;
  recommended: Plan | null;
  alternatives: Plan[];
  warehouses: WarehouseEval[];
  /** Motivo da analise humana (nulo no caso automatico). */
  analysisReason: string | null;
  suggestions: string[];
  excluded: { key: string; reasons: string[] }[];
};

const EPS = 1e-9;
const n3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

export const CRITERIA = [
  'Estoque próprio antes de fornecedor.',
  'Um depósito próprio por pedido nesta fase.',
  'Depósito que cobre o pedido inteiro: padrão primeiro, depois a prioridade cadastrada (menor primeiro), depois o código.',
  'Sem depósito que cubra tudo: o padrão com o que tiver e o resto por encomenda ao fornecedor recomendado (custo, prazo, principal).',
  'Marketplaces: só estoque próprio.',
  'Dropshipping só com a validação fiscal registrada.',
  'Automático só quando um depósito cobre o pedido inteiro.',
];

/** Ordem dos depositos: padrao, prioridade, codigo (estavel). */
export function sortWarehouses(ws: EngineWarehouse[]) {
  return [...ws].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.priority - b.priority || a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
}

function needByVariant(items: EngineItem[]) {
  const need = new Map<string, { sku: string; qty: number }>();
  for (const it of items) {
    const cur = need.get(it.variantId);
    need.set(it.variantId, { sku: it.sku, qty: n3((cur?.qty ?? 0) + it.need) });
  }
  return need;
}

function freeAt(input: EngineInput, warehouseId: string, variantId: string) {
  return input.stock.find((s) => s.warehouseId === warehouseId && s.variantId === variantId)?.free ?? 0;
}

/** Plano todo em estoque proprio num deposito. */
function stockPlan(input: EngineInput, w: EngineWarehouse, why: string[]): Plan {
  return {
    key: `stock:${w.id}`,
    label: `Estoque próprio — ${w.name}`,
    lines: input.items.map((it) => ({
      orderItemId: it.orderItemId,
      variantId: it.variantId,
      sku: it.sku,
      qty: it.need,
      mode: 'stock',
      warehouseId: w.id,
      offerId: null,
      supplierId: null,
      supplierName: null,
      unitCostCents: null,
      leadDays: 0,
    })),
    supplierCostCents: 0,
    leadDays: 0,
    reasons: why,
  };
}

/**
 * Plano com o que o deposito tem e o resto por fornecedor (encomenda ou dropshipping). Devolve null com motivos
 * quando alguma falta nao tem fornecedor apto.
 */
function splitPlan(input: EngineInput, w: EngineWarehouse, mode: 'purchase_to_order' | 'dropship'): { plan: Plan | null; reasons: string[] } {
  const need = needByVariant(input.items);
  const reasons: string[] = [];
  const lines: PlanLine[] = [];
  let cost = 0;
  let lead: number | null = 0;
  // Livre do deposito distribuido pelos itens na ordem do pedido.
  const left = new Map<string, number>();
  for (const v of need.keys()) left.set(v, Math.max(0, freeAt(input, w.id, v)));
  const shortByVariant = new Map<string, number>();
  for (const it of input.items) {
    const own = Math.min(it.need, left.get(it.variantId)!);
    left.set(it.variantId, n3(left.get(it.variantId)! - own));
    if (own > EPS) {
      lines.push({ orderItemId: it.orderItemId, variantId: it.variantId, sku: it.sku, qty: n3(own), mode: 'stock', warehouseId: w.id, offerId: null, supplierId: null, supplierName: null, unitCostCents: null, leadDays: 0 });
    }
    const rest = n3(it.need - own);
    if (rest > EPS) shortByVariant.set(it.variantId, n3((shortByVariant.get(it.variantId) ?? 0) + rest));
  }
  // Fornecedor por variante, para a falta somada da variante.
  const chosen = new Map<string, NonNullable<ReturnType<typeof chooseSupplier>['recommended']>>();
  for (const [variantId, short] of [...shortByVariant.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sku = need.get(variantId)!.sku;
    const choice = chooseSupplier(
      input.offers[variantId] ?? [],
      { need: short, context: mode === 'dropship' ? 'fulfillment' : 'purchase', dropshipReleased: input.dropshipReleased, now: input.now },
      input.choiceSettings,
    );
    if (!choice.recommended) {
      reasons.push(`${sku}: faltam ${fmt(short)} e não há fornecedor apto (${choice.summary})`);
      continue;
    }
    chosen.set(variantId, choice.recommended);
    cost += choice.recommended.totalCents;
    lead = lead === null || choice.recommended.leadDays === null ? null : Math.max(lead, choice.recommended.leadDays);
  }
  if (reasons.length) return { plan: null, reasons };
  if (!shortByVariant.size) return { plan: null, reasons: ['Nada a encomendar: o depósito cobre o pedido.'] };
  // Linhas de fornecedor por item (mesma oferta da variante).
  const restLeft = new Map(shortByVariant);
  for (const it of input.items) {
    const ownQty = lines.filter((l) => l.orderItemId === it.orderItemId).reduce((s, l) => s + l.qty, 0);
    const rest = n3(it.need - ownQty);
    if (rest <= EPS) continue;
    const opt = chosen.get(it.variantId)!;
    restLeft.set(it.variantId, n3(restLeft.get(it.variantId)! - rest));
    lines.push({
      orderItemId: it.orderItemId,
      variantId: it.variantId,
      sku: it.sku,
      qty: rest,
      mode,
      warehouseId: mode === 'dropship' ? null : w.id,
      offerId: opt.offerId,
      supplierId: opt.supplierId,
      supplierName: opt.supplierName,
      unitCostCents: opt.unitCostCents,
      leadDays: opt.leadDays,
    });
  }
  const suppliers = [...new Set([...chosen.values()].map((o) => o.supplierName))].join(', ');
  const why = [
    `${w.name} atende ${lines.filter((l) => l.mode === 'stock').length ? 'parte do pedido' : 'nenhum item'} com estoque próprio.`,
    mode === 'dropship'
      ? `O restante sai direto do fornecedor (${suppliers}) para o cliente.`
      : `O restante vem por encomenda (${suppliers}), com entrega no ${w.name}; a reserva fica aguardando a mercadoria.`,
    ...[...chosen.entries()].map(([v, o]) => `${need.get(v)!.sku}: ${o.supplierName} — ${o.reasons[0] ?? 'recomendado'}`),
  ];
  return {
    plan: {
      key: `${mode === 'dropship' ? 'dropship' : 'order'}:${w.id}:${[...chosen.values()].map((o) => o.offerId).sort().join(',')}`,
      label: mode === 'dropship' ? `Estoque do ${w.name} + dropshipping` : `Estoque do ${w.name} + encomenda ao fornecedor`,
      lines,
      supplierCostCents: cost,
      leadDays: lead,
      reasons: why,
    },
    reasons: [],
  };
}

export function allocate(input: EngineInput): EngineOutput {
  const need = needByVariant(input.items);
  const ordered = sortWarehouses(input.warehouses);
  const evals: WarehouseEval[] = ordered.map((w) => {
    const short = [...need.entries()]
      .map(([variantId, n]) => ({ variantId, sku: n.sku, need: n.qty, free: n3(Math.max(0, freeAt(input, w.id, variantId))) }))
      .filter((s) => s.free + EPS < s.need)
      .sort((a, b) => a.sku.localeCompare(b.sku));
    return { id: w.id, code: w.code, name: w.name, isDefault: w.isDefault, priority: w.priority, coversAll: short.length === 0, short };
  });
  const base = { engineVersion: ENGINE_VERSION, criteria: CRITERIA, warehouses: evals };
  if (!input.items.length) {
    return { ...base, automatic: false, recommended: null, alternatives: [], analysisReason: 'Pedido sem itens.', suggestions: [], excluded: [] };
  }

  const covering = ordered.filter((w) => evals.find((e) => e.id === w.id)!.coversAll);
  if (covering.length) {
    const [first, ...others] = covering;
    const why = [
      `${first!.name} cobre todos os itens do pedido com estoque livre.`,
      first!.isDefault ? 'É o depósito padrão.' : `O padrão não cobre tudo; ${first!.name} vem pela prioridade ${first!.priority}.`,
    ];
    return {
      ...base,
      automatic: true,
      recommended: stockPlan(input, first!, why),
      alternatives: others.map((w) => stockPlan(input, w, [`${w.name} também cobre o pedido inteiro (prioridade ${w.priority}).`])),
      analysisReason: null,
      suggestions: [],
      excluded: [],
    };
  }

  // Ninguem cobre tudo: analise humana.
  const dflt = ordered.find((w) => w.isDefault) ?? null;
  const dEval = dflt ? evals.find((e) => e.id === dflt.id)! : null;
  const shortText = (dEval?.short ?? []).map((s) => `${s.sku} (precisa ${fmt(s.need)}, livre ${fmt(s.free)})`).join('; ');
  const analysisReason = `Nenhum depósito cobre o pedido inteiro${shortText ? `. No ${dflt!.name}: ${shortText}` : ''}.`;

  const suggestions: string[] = [];
  if (dflt && dEval) {
    for (const s of dEval.short) {
      const others = ordered
        .filter((w) => w.id !== dflt.id)
        .map((w) => ({ w, free: n3(Math.max(0, freeAt(input, w.id, s.variantId))) }))
        .filter((x) => x.free > EPS);
      for (const o of others) {
        suggestions.push(`Transferir até ${fmt(Math.min(o.free, n3(s.need - s.free)))} de ${s.sku} do ${o.w.name} para o ${dflt.name} e alocar de novo.`);
      }
    }
  }
  if (!input.dropshipReleased && !input.ownOnly) suggestions.push('Dropshipping indisponível: aguarda a validação fiscal (D3).');

  const plans: Plan[] = [];
  const excluded: { key: string; reasons: string[] }[] = [];
  if (input.ownOnly) {
    excluded.push({ key: 'supplier', reasons: ['Pedido de marketplace: só estoque próprio (D4-13). Transfira ou ajuste o estoque e aloque de novo.'] });
  } else if (dflt) {
    const order = splitPlan(input, dflt, 'purchase_to_order');
    if (order.plan) plans.push(order.plan);
    else excluded.push({ key: 'purchase_to_order', reasons: order.reasons });
    if (input.dropshipReleased) {
      const drop = splitPlan(input, dflt, 'dropship');
      if (drop.plan) plans.push(drop.plan);
      else excluded.push({ key: 'dropship', reasons: drop.reasons });
    }
  }
  return {
    ...base,
    automatic: false,
    recommended: plans[0] ?? null,
    alternatives: plans.slice(1),
    analysisReason,
    suggestions,
    excluded,
  };
}
