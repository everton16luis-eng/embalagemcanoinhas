// SGLog Fase 2: escolha do melhor fornecedor para uma necessidade (docs/18-sglog-fase2.md §Escolha do fornecedor).
// Funcao PURA e deterministica: sem banco, sem relogio proprio (recebe `now`), sem aleatoriedade. A mesma entrada da
// sempre a mesma saida, inclusive a ordem. Nao esta ligada a reposicao nem ao pedido de compra nesta fase (D2-6):
// so a comparacao das telas a usa, como sugestao explicada.
//
// Regras principais:
// - custo desconhecido NUNCA vale zero: oferta sem custo e excluida; frete ou despesa do pedido desconhecidos deixam
//   o custo total "incompleto", e as opcoes com custo completo vem antes das incompletas;
// - empate tecnico: custo total ate `tieTolerancePct` % acima do mais barato da faixa (padrao 3 %, configuravel);
//   dentro do empate decide o fornecedor principal, depois o menor prazo, a disponibilidade confirmada mais recente,
//   o menor excedente, o menor custo e, por fim, o id da oferta (desempate final estavel);
// - cada opcao traz o motivo da posicao, e cada excluida o motivo da exclusao.

export type ChoiceContext = 'purchase' | 'fulfillment';

export type SupplierOfferInput = {
  offerId: string;
  supplierId: string;
  supplierName: string;
  supplierStatus: 'active' | 'inactive' | 'blocked';
  supplierBlockedReason?: string | null;
  supplierArchived: boolean;
  offerStatus: 'active' | 'paused' | 'ended';
  packagingLabel: string;
  packagingActive: boolean;
  variantActive: boolean;
  /** Custo da embalagem de compra, em centavos. Nulo = desconhecido (exclui). */
  costCents: number | null;
  /** Unidades base por embalagem. */
  baseQty: number;
  minOrderPacks: number | null;
  orderMultiplePacks: number | null;
  /** Prazo efetivo em dias (preparo + entrega). Nulo = desconhecido. */
  leadDays: number | null;
  isPrimary: boolean;
  /** Frete e despesas fixas por pedido. Nulo = desconhecido; 0 = incluso. */
  orderFreightCents: number | null;
  orderExtraCents: number | null;
  /** Pedido minimo em valor do fornecedor (so aviso). */
  minOrderCents: number | null;
  /** Data da cotacao (YYYY-MM-DD). */
  quotedAt: string;
  dropshipEnabled: boolean;
  dropshipAllowed: boolean;
  /** Ultima disponibilidade informada pelo fornecedor (unidade base), vencida ou nao. */
  availableQty: number | null;
  availabilityConfirmedAt: string | null;
  availabilityValidUntil: string | null;
};

export type ChoiceSettings = {
  /** Empate tecnico em % do custo total (padrao 3). */
  tieTolerancePct: number;
  /** Cotacao mais velha que isto gera aviso (padrao 90). */
  staleQuoteDays: number;
};

export type ChoiceRequest = {
  /** Necessidade em unidades base (> 0). */
  need: number;
  context: ChoiceContext;
  /** Prazo-limite em dias; quem nao atende vai para o fim, sem ser excluido. */
  maxLeadDays?: number | null;
  /** Dropshipping liberado para operacao. Na Fase 2 e sempre falso fora dos testes (validacao fiscal pendente). */
  dropshipReleased?: boolean;
  now: Date;
};

export type ChoiceOption = {
  rank: number;
  offerId: string;
  supplierId: string;
  supplierName: string;
  packagingLabel: string;
  packs: number;
  goodsCents: number;
  freightCents: number | null;
  extraCents: number | null;
  /** Custo total conhecido (mercadoria + frete + despesas conhecidos). */
  totalCents: number;
  /** false quando frete ou despesa do pedido sao desconhecidos: o total real e maior que totalCents. */
  costComplete: boolean;
  /** Custo por unidade base efetivamente recebida, com frete e despesas conhecidos. */
  unitCostCents: number;
  surplus: number;
  leadDays: number | null;
  meetsDeadline: boolean | null;
  isPrimary: boolean;
  availability: 'current' | 'expired' | 'none';
  warnings: string[];
  /** Por que esta nesta posicao (a recomendada: por que foi escolhida). */
  reasons: string[];
};

export type ChoiceExclusion = { offerId: string; supplierId: string; supplierName: string; packagingLabel: string; reasons: string[] };

export type ChoiceResult = {
  recommended: ChoiceOption | null;
  options: ChoiceOption[];
  excluded: ChoiceExclusion[];
  summary: string;
};

const EPS = 1e-9;
const DAY = 86_400_000;
const brl = (cents: number) => `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const ceilTo = (n: number) => Math.ceil(n - EPS);

/** Embalagens para cobrir a necessidade, respeitando minimo e multiplo do fornecedor. */
export function packsFor(need: number, baseQty: number, minOrderPacks: number | null, orderMultiplePacks: number | null): number {
  let packs = ceilTo(need / baseQty);
  if (minOrderPacks && packs < minOrderPacks - EPS) packs = minOrderPacks;
  if (orderMultiplePacks) packs = ceilTo(round3(packs / orderMultiplePacks)) * orderMultiplePacks;
  return round3(packs);
}

function availabilityState(o: SupplierOfferInput, now: Date): 'current' | 'expired' | 'none' {
  if (o.availableQty === null || !o.availabilityValidUntil) return 'none';
  return new Date(o.availabilityValidUntil).getTime() < now.getTime() ? 'expired' : 'current';
}

function exclusionReasons(o: SupplierOfferInput, req: ChoiceRequest): string[] {
  const r: string[] = [];
  if (o.supplierArchived) r.push('fornecedor arquivado');
  else if (o.supplierStatus === 'blocked') r.push(`fornecedor bloqueado${o.supplierBlockedReason ? `: ${o.supplierBlockedReason}` : ''}`);
  else if (o.supplierStatus === 'inactive') r.push('fornecedor inativo');
  if (o.offerStatus === 'paused') r.push('oferta pausada');
  if (o.offerStatus === 'ended') r.push('oferta encerrada');
  if (!o.packagingActive) r.push('embalagem de compra desativada no catálogo');
  if (!o.variantActive) r.push('variante desativada no catálogo');
  if (o.costCents === null || !(o.costCents > 0)) r.push('custo desconhecido');
  if (!(o.baseQty > 0)) r.push('embalagem sem quantidade válida');
  if (req.context === 'fulfillment') {
    if (!req.dropshipReleased) r.push('dropshipping bloqueado para operação até validação fiscal e autorização');
    if (!o.dropshipEnabled || !o.dropshipAllowed) r.push('fornecedor ou item sem dropshipping');
    const state = availabilityState(o, req.now);
    if (state === 'none') r.push('sem disponibilidade informada pelo fornecedor');
    else if (state === 'expired') r.push('disponibilidade do fornecedor vencida');
    else if ((o.availableQty ?? 0) < req.need - EPS) r.push(`fornecedor informou só ${qty(o.availableQty ?? 0)} disponível`);
  }
  return r;
}

type Candidate = ChoiceOption & { short: boolean; confirmedTs: number | null; band: number };

/** Ordem lexicografica. Cada criterio tem um rotulo usado para explicar a posicao. */
const CRITERIA: { label: (a: Candidate, b: Candidate) => string; cmp: (a: Candidate, b: Candidate) => number }[] = [
  {
    cmp: (a, b) => Number(a.meetsDeadline === false || a.meetsDeadline === null) - Number(b.meetsDeadline === false || b.meetsDeadline === null),
    label: (a) => (a.leadDays === null ? 'prazo desconhecido: pode não atender o prazo-limite' : `prazo de ${a.leadDays} dias acima do prazo-limite`),
  },
  {
    cmp: (a, b) => Number(a.short) - Number(b.short),
    label: (a) => 'disponibilidade informada abaixo da necessidade',
  },
  {
    cmp: (a, b) => Number(!a.costComplete) - Number(!b.costComplete),
    label: () => 'custo total incompleto (frete ou despesa do pedido não informados)',
  },
  {
    cmp: (a, b) => a.band - b.band,
    label: (a, b) => `custo total ${brl(a.totalCents - b.totalCents)} maior (+${(((a.totalCents - b.totalCents) / b.totalCents) * 100).toFixed(1)} %), fora do empate técnico`,
  },
  { cmp: (a, b) => Number(!a.isPrimary) - Number(!b.isPrimary), label: (_a, b) => `empate técnico de custo; ${b.supplierName} é o fornecedor principal` },
  {
    cmp: (a, b) => (a.leadDays === b.leadDays ? 0 : a.leadDays === null ? 1 : b.leadDays === null ? -1 : a.leadDays - b.leadDays),
    label: (a, b) => `empate técnico de custo; prazo ${a.leadDays === null ? 'desconhecido' : `de ${a.leadDays} dias`} contra ${b.leadDays} dias`,
  },
  {
    cmp: (a, b) => (a.confirmedTs === b.confirmedTs ? 0 : a.confirmedTs === null ? 1 : b.confirmedTs === null ? -1 : b.confirmedTs - a.confirmedTs),
    label: () => 'empate técnico de custo e prazo; disponibilidade confirmada há mais tempo',
  },
  { cmp: (a, b) => a.surplus - b.surplus, label: (a, b) => `empate técnico; excedente maior (${qty(a.surplus)} contra ${qty(b.surplus)})` },
  { cmp: (a, b) => a.totalCents - b.totalCents, label: (a, b) => `empate técnico; custo ${brl(a.totalCents - b.totalCents)} maior` },
  { cmp: (a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0), label: () => 'empate completo; desempate fixo pela identificação da oferta' },
];

function compare(a: Candidate, b: Candidate): number {
  for (const c of CRITERIA) {
    const d = c.cmp(a, b);
    if (d !== 0) return d;
  }
  return 0;
}

/** Explica por que `a` ficou atras de `b` (o primeiro criterio em que perde). */
function whyBehind(a: Candidate, b: Candidate): string {
  for (const c of CRITERIA) if (c.cmp(a, b) > 0) return c.label(a, b);
  return 'empate completo';
}

export function chooseSupplier(offers: SupplierOfferInput[], req: ChoiceRequest, settings: ChoiceSettings): ChoiceResult {
  if (!(req.need > 0)) throw new RangeError('A necessidade precisa ser maior que zero.');
  const tol = Math.max(0, settings.tieTolerancePct) / 100;
  const excluded: ChoiceExclusion[] = [];
  const candidates: Candidate[] = [];

  // Entrada ordenada pelo id: a saida nao depende da ordem recebida.
  for (const o of [...offers].sort((x, y) => (x.offerId < y.offerId ? -1 : 1))) {
    const reasons = exclusionReasons(o, req);
    if (reasons.length) {
      excluded.push({ offerId: o.offerId, supplierId: o.supplierId, supplierName: o.supplierName, packagingLabel: o.packagingLabel, reasons });
      continue;
    }
    const packs = packsFor(req.need, o.baseQty, o.minOrderPacks, o.orderMultiplePacks);
    const goods = Math.round(packs * o.costCents!);
    const costComplete = o.orderFreightCents !== null && o.orderExtraCents !== null;
    const total = goods + (o.orderFreightCents ?? 0) + (o.orderExtraCents ?? 0);
    const received = round3(packs * o.baseQty);
    const surplus = round3(received - req.need);
    const state = availabilityState(o, req.now);
    const warnings: string[] = [];
    if (o.orderFreightCents === null) warnings.push('frete do pedido não informado (custo total incompleto)');
    if (o.orderExtraCents === null) warnings.push('despesas do pedido não informadas (custo total incompleto)');
    if (o.minOrderPacks && ceilTo(req.need / o.baseQty) < o.minOrderPacks - EPS) warnings.push(`quantidade mínima de ${qty(o.minOrderPacks)} embalagens aumenta a compra`);
    if (o.orderMultiplePacks && packs > ceilTo(req.need / o.baseQty) && !(o.minOrderPacks && packs <= o.minOrderPacks + EPS)) warnings.push(`vendido em múltiplos de ${qty(o.orderMultiplePacks)} embalagens`);
    if (surplus > EPS) warnings.push(`excedente de ${qty(surplus)} unidades`);
    if (o.minOrderCents && goods < o.minOrderCents) warnings.push(`abaixo do pedido mínimo do fornecedor (${brl(o.minOrderCents)})`);
    const ageDays = Math.floor((req.now.getTime() - new Date(`${o.quotedAt}T00:00:00Z`).getTime()) / DAY);
    if (ageDays > settings.staleQuoteDays) warnings.push(`cotação de ${ageDays} dias (mais de ${settings.staleQuoteDays})`);
    if (o.leadDays === null) warnings.push('prazo desconhecido');
    if (state === 'expired') warnings.push('disponibilidade vencida: tratada como sem informação');
    if (state === 'none') warnings.push('sem disponibilidade informada');
    const short = state === 'current' && (o.availableQty ?? 0) < req.need - EPS;
    if (short) warnings.push(`fornecedor informou só ${qty(o.availableQty ?? 0)} disponível`);
    const meetsDeadline = req.maxLeadDays === null || req.maxLeadDays === undefined ? true : o.leadDays === null ? null : o.leadDays <= req.maxLeadDays;
    candidates.push({
      rank: 0,
      offerId: o.offerId,
      supplierId: o.supplierId,
      supplierName: o.supplierName,
      packagingLabel: o.packagingLabel,
      packs,
      goodsCents: goods,
      freightCents: o.orderFreightCents,
      extraCents: o.orderExtraCents,
      totalCents: total,
      costComplete,
      unitCostCents: Math.round((total / received) * 10_000) / 10_000,
      surplus,
      leadDays: o.leadDays,
      meetsDeadline,
      isPrimary: o.isPrimary,
      availability: state,
      warnings,
      reasons: [],
      short,
      confirmedTs: state === 'current' && o.availabilityConfirmedAt ? new Date(o.availabilityConfirmedAt).getTime() : null,
      band: 0,
    });
  }

  // Faixas de empate tecnico, dentro de cada grupo (prazo, disponibilidade, custo completo): a faixa comeca no mais
  // barato que sobrou e inclui quem esta ate `tol` acima dele.
  const groupKey = (c: Candidate) => `${Number(c.meetsDeadline !== true)}|${Number(c.short)}|${Number(!c.costComplete)}`;
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) groups.set(groupKey(c), [...(groups.get(groupKey(c)) ?? []), c]);
  for (const list of groups.values()) {
    list.sort((a, b) => a.totalCents - b.totalCents || (a.offerId < b.offerId ? -1 : 1));
    let band = 0;
    let floor = -1;
    for (const c of list) {
      if (floor < 0 || c.totalCents > floor * (1 + tol) + EPS) {
        if (floor >= 0) band++;
        floor = c.totalCents;
      }
      c.band = band;
    }
  }

  candidates.sort(compare);
  const best = candidates[0];
  candidates.forEach((c, i) => {
    c.rank = i + 1;
    if (i === 0) {
      const others = candidates.slice(1);
      const tied = others.filter((o) => groupKey(o) === groupKey(c) && o.band === c.band);
      if (!others.length) c.reasons.push('única opção apta');
      else if (!tied.length) c.reasons.push(c.costComplete ? 'menor custo total entre os aptos' : 'menor custo conhecido entre os aptos (todos com custo incompleto ou à frente dos incompletos)');
      else {
        const decisive = CRITERIA.slice(4).find((k) => tied.some((t) => k.cmp(t, c) > 0));
        const what = decisive === CRITERIA[4] ? 'é o fornecedor principal' : decisive === CRITERIA[5] ? 'tem o menor prazo' : decisive === CRITERIA[6] ? 'tem a disponibilidade confirmada mais recente' : decisive === CRITERIA[7] ? 'tem o menor excedente' : decisive === CRITERIA[8] ? 'tem o menor custo' : 'desempate fixo';
        c.reasons.push(`empate técnico de custo (até ${settings.tieTolerancePct} %) com ${tied.map((t) => t.supplierName).join(', ')}; escolhido porque ${what}`);
      }
      if (req.maxLeadDays !== null && req.maxLeadDays !== undefined && c.meetsDeadline !== true) c.reasons.push('nenhuma opção apta garante o prazo-limite');
    } else {
      c.reasons.push(whyBehind(c, best!));
    }
  });

  const options: ChoiceOption[] = candidates.map(({ short: _s, confirmedTs: _c, band: _b, ...o }) => o);
  const recommended = options[0] ?? null;
  const summary = recommended
    ? `${recommended.supplierName}: ${qty(recommended.packs)} × ${recommended.packagingLabel}, ${brl(recommended.totalCents)}${recommended.costComplete ? '' : ' + frete/despesas não informados'}` +
      `${recommended.leadDays === null ? ', prazo desconhecido' : `, ${recommended.leadDays} dias`}.`
    : offers.length
      ? 'Nenhum fornecedor apto: veja os motivos das exclusões.'
      : 'Nenhum fornecedor cadastrado para esta variante.';
  return { recommended, options, excluded, summary };
}
