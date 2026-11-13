/**
 * Monta o JSON da NF-e no formato da Focus NFe a partir do pedido, da versao da empresa e da regra fiscal.
 * Funcao pura: nao consulta banco nem rede. So usa campos documentados (docs/05-fiscal-nfe.md, secao 3).
 * Codigos tributarios vem da regra validada pelo contador; aqui nao se decide tributacao.
 */
export type NfeRule = {
  natureza_operacao: string;
  cfop: string;
  icms_situacao_tributaria: string;
  pis_situacao_tributaria: string;
  cofins_situacao_tributaria: string;
  consumidor_final: boolean;
  presenca_comprador: number;
  extra_fields: Record<string, unknown>;
  item_extra_fields: Record<string, unknown>;
};

export type NfeCompany = {
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  state_registration: string;
  street: string;
  number: string;
  district: string;
  city: string;
  uf: string;
  cep: string;
  phone: string | null;
  tax_regime: string;
};

export type NfeAddress = { street: string; number: string; complement?: string | null; district: string; city: string; uf: string; cep: string };

export type NfeItem = {
  sku: string;
  description: string;
  unitCode: string;
  packs: number;
  unitPriceCents: number;
  totalCents: number;
  baseQtyPerPack: string;
  ncm: string;
  origin: number;
  taxUnit: string | null;
  taxUnitQty: string | null;
};

export type NfeInput = {
  environment: 'homologacao' | 'producao';
  issuedAt: Date;
  company: NfeCompany;
  rule: NfeRule;
  destination: 'internal' | 'interstate';
  buyer: { kind: 'pf' | 'pj'; name: string; document: string; stateRegistration: string | null; phone: string | null; email: string | null };
  address: NfeAddress;
  shippingKind: 'pickup' | 'delivery';
  paymentMethod: 'pix' | 'card';
  subtotalCents: number;
  discountCents: number;
  freightCents: number;
  totalCents: number;
  items: NfeItem[];
};

/** Regime da empresa para regime_tributario_emitente (1, 2, 3 documentados). MEI fica sem mapeamento. */
export const REGIME: Record<string, 1 | 2 | 3> = { simples_nacional: 1, simples_excesso_sublimite: 2, lucro_presumido: 3, lucro_real: 3 };

/**
 * Meio de pagamento (tabela tPag da NF-e): 17 = PIX dinamico, 03 = cartao de credito.
 * Cartao sem integracao com automacao (tipo_integracao 2). A confirmar com o contador na homologacao.
 */
export const PAYMENT_CODE = { pix: '17', card: '03' } as const;

/** Texto exigido pela SEFAZ no nome do destinatario em homologacao (exemplo oficial da Focus). */
export const HOMOLOGATION_NAME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

/** Campos que a loja monta. A regra fiscal pode acrescentar campos, nunca substituir estes. */
export const RESERVED_FIELDS = new Set([
  'natureza_operacao', 'data_emissao', 'tipo_documento', 'finalidade_emissao', 'local_destino', 'consumidor_final', 'presenca_comprador',
  'indicador_intermediario', 'cnpj_emitente', 'nome_emitente', 'nome_fantasia_emitente', 'logradouro_emitente', 'numero_emitente',
  'bairro_emitente', 'municipio_emitente', 'uf_emitente', 'cep_emitente', 'inscricao_estadual_emitente', 'regime_tributario_emitente',
  'telefone_emitente', 'nome_destinatario', 'cpf_destinatario', 'cnpj_destinatario', 'inscricao_estadual_destinatario',
  'indicador_inscricao_estadual_destinatario', 'logradouro_destinatario', 'numero_destinatario', 'complemento_destinatario',
  'bairro_destinatario', 'municipio_destinatario', 'uf_destinatario', 'cep_destinatario', 'pais_destinatario', 'telefone_destinatario',
  'email_destinatario', 'valor_frete', 'valor_seguro', 'valor_desconto', 'valor_outras_despesas', 'valor_total', 'valor_produtos',
  'modalidade_frete', 'formas_pagamento', 'items', 'ref', 'numero', 'serie',
]);
export const RESERVED_ITEM_FIELDS = new Set([
  'numero_item', 'codigo_produto', 'descricao', 'cfop', 'codigo_ncm', 'quantidade_comercial', 'quantidade_tributavel',
  'valor_unitario_comercial', 'valor_unitario_tributavel', 'unidade_comercial', 'unidade_tributavel', 'valor_bruto', 'inclui_no_total',
  'icms_origem', 'icms_situacao_tributaria', 'pis_situacao_tributaria', 'cofins_situacao_tributaria',
]);

const money = (cents: number) => Math.round(cents) / 100;
const round = (v: number, places: number) => Number(v.toFixed(places));

/** Data e hora de Brasilia com fuso explicito (formato ISO pedido pela API). */
export function brasiliaIso(d: Date) {
  const local = new Date(d.getTime() - 3 * 3600_000);
  return `${local.toISOString().slice(0, 19)}-03:00`;
}

/** Quantidade e valor na unidade tributavel; sem unidade tributavel cadastrada, iguais aos comerciais. */
export function taxQuantities(i: NfeItem) {
  if (!i.taxUnit || !i.taxUnitQty) return { unit: i.unitCode, qty: i.packs, unitValue: money(i.unitPriceCents) };
  const qty = round((i.packs * Number(i.baseQtyPerPack)) / Number(i.taxUnitQty), 4);
  return { unit: i.taxUnit, qty, unitValue: round(i.totalCents / 100 / qty, 10) };
}

export function buildNfePayload(n: NfeInput): Record<string, unknown> {
  const homolog = n.environment === 'homologacao';
  const contribuinte = n.buyer.kind === 'pj' && Boolean(n.buyer.stateRegistration);
  const online = [2, 3, 4, 9].includes(n.rule.presenca_comprador);

  const items = n.items.map((i, idx) => {
    const tax = taxQuantities(i);
    const base: Record<string, unknown> = {
      numero_item: idx + 1,
      codigo_produto: i.sku,
      descricao: i.description.slice(0, 120),
      cfop: n.rule.cfop,
      codigo_ncm: i.ncm,
      quantidade_comercial: i.packs,
      unidade_comercial: i.unitCode.slice(0, 6),
      valor_unitario_comercial: money(i.unitPriceCents),
      quantidade_tributavel: tax.qty,
      unidade_tributavel: tax.unit.slice(0, 6),
      valor_unitario_tributavel: tax.unitValue,
      valor_bruto: money(i.totalCents),
      inclui_no_total: 1,
      icms_origem: i.origin,
      icms_situacao_tributaria: n.rule.icms_situacao_tributaria,
      pis_situacao_tributaria: n.rule.pis_situacao_tributaria,
      cofins_situacao_tributaria: n.rule.cofins_situacao_tributaria,
    };
    for (const [k, v] of Object.entries(n.rule.item_extra_fields)) if (!RESERVED_ITEM_FIELDS.has(k)) base[k] = v;
    return base;
  });

  const payload: Record<string, unknown> = {
    natureza_operacao: n.rule.natureza_operacao,
    data_emissao: brasiliaIso(n.issuedAt),
    tipo_documento: 1,
    finalidade_emissao: 1,
    local_destino: n.destination === 'internal' ? 1 : 2,
    consumidor_final: n.rule.consumidor_final ? 1 : 0,
    presenca_comprador: n.rule.presenca_comprador,
    // Venda no site proprio, sem marketplace: sem intermediador.
    ...(online ? { indicador_intermediario: 0 } : {}),
    cnpj_emitente: n.company.cnpj,
    nome_emitente: n.company.legal_name,
    ...(n.company.trade_name ? { nome_fantasia_emitente: n.company.trade_name } : {}),
    logradouro_emitente: n.company.street,
    numero_emitente: n.company.number,
    bairro_emitente: n.company.district,
    municipio_emitente: n.company.city,
    uf_emitente: n.company.uf,
    cep_emitente: n.company.cep,
    inscricao_estadual_emitente: n.company.state_registration,
    regime_tributario_emitente: REGIME[n.company.tax_regime],
    ...(n.company.phone ? { telefone_emitente: n.company.phone } : {}),
    nome_destinatario: homolog ? HOMOLOGATION_NAME : n.buyer.name.slice(0, 60),
    ...(n.buyer.kind === 'pf' ? { cpf_destinatario: n.buyer.document } : { cnpj_destinatario: n.buyer.document }),
    ...(contribuinte ? { inscricao_estadual_destinatario: n.buyer.stateRegistration } : {}),
    indicador_inscricao_estadual_destinatario: contribuinte ? 1 : 9,
    logradouro_destinatario: n.address.street,
    numero_destinatario: n.address.number,
    ...(n.address.complement ? { complemento_destinatario: n.address.complement } : {}),
    bairro_destinatario: n.address.district,
    municipio_destinatario: n.address.city,
    uf_destinatario: n.address.uf,
    cep_destinatario: n.address.cep,
    pais_destinatario: 'Brasil',
    ...(n.buyer.phone ? { telefone_destinatario: n.buyer.phone } : {}),
    ...(n.buyer.email ? { email_destinatario: n.buyer.email } : {}),
    valor_produtos: money(n.subtotalCents),
    valor_frete: money(n.freightCents),
    valor_seguro: 0,
    valor_desconto: money(n.discountCents),
    valor_outras_despesas: 0,
    valor_total: money(n.totalCents),
    // 0 = por conta do emitente (entrega da loja); 9 = sem transporte (retirada).
    modalidade_frete: n.shippingKind === 'delivery' ? 0 : 9,
    formas_pagamento: [
      { forma_pagamento: PAYMENT_CODE[n.paymentMethod], valor_pagamento: money(n.totalCents), ...(n.paymentMethod === 'card' ? { tipo_integracao: 2 } : {}) },
    ],
    items,
  };
  for (const [k, v] of Object.entries(n.rule.extra_fields)) if (!RESERVED_FIELDS.has(k)) payload[k] = v;
  return payload;
}
