import type { Db } from '../db/pool.js';

// Permissoes da equipe. Cada rota exige uma; o papel da o padrao e o proprietario pode
// conceder ou retirar permissoes individuais (exceto do proprio proprietario).
export const PERMISSIONS = [
  'users.view',
  'users.manage',
  'audit.view',
  'settings.manage',
  'company.view',
  'company.manage',
  'fiscal.view',
  'fiscal.manage',
  'fiscal.validate',
  'catalog.view',
  'catalog.manage',
  'prices.manage',
  // Importacao de produtos em massa por planilha (docs/14-importacao-produtos.md). Exige tambem catalog.manage.
  'catalog.import',
  // Fases seguintes: entram aqui para que o painel ja possa mostrar e atribuir.
  'stock.view',
  'stock.manage',
  // SGLog Fase 3 (docs/20-sglog-fase3.md §1.4): transferencia entre depositos; ajuste, perda, avaria (baixa), estorno,
  // extravio e aprovacao de solicitacao de ajuste (com MFA).
  'stock.transfer',
  'stock.adjust',
  'purchases.view',
  'purchases.manage',
  // SGLog Fase 6 (docs/29-sglog-fase6.md): aprovar compra (MFA, D6-3/D6-4), registrar recebimento (separado de quem
  // compra, D6-1) e informar o pagamento da compra (so registro, sem mover dinheiro, D6-5).
  'purchases.approve',
  'purchases.receive',
  'purchases.pay',
  // SGLog Fase 7 (docs/32-sglog-fase7.md): pedir compra (requisicao interna). Consolidar em compra continua com
  // purchases.manage.
  'purchases.request',
  // SGLog Fase 2 (docs/18-sglog-fase2.md): fornecedores, ofertas, custo e disponibilidade. Lista, detalhe e ofertas
  // tambem aceitam purchases.view (a tela de compras escolhe fornecedor).
  'suppliers.view',
  'suppliers.manage',
  // SGLog Fase 4 (docs/23-sglog-fase4.md): ver a alocacao dos pedidos; confirmar, trocar e desfazer (sem MFA: operacao
  // do dia a dia). Liberar o dropshipping exige settings.manage (com MFA).
  'logistics.view',
  'logistics.allocate',
  // SGLog Fase 5 (docs/26-sglog-fase5.md): separar, conferir e embalar (estoquista incluso, sem despachar); criar,
  // dividir, cancelar e liberar remessa.
  'shipping.pick',
  'logistics.manage',
  'orders.view',
  'orders.manage',
  'shipping.manage',
  // SGLog Fase 8 (docs/35-sglog-fase8.md): comprar, cancelar e resolver etiqueta de frete (gasta dinheiro: MFA, D8-7).
  // A compra real continua bloqueada pela trava do frete.
  'shipping.labels',
  // SGLog Fase 9 (docs/38-sglog-fase9.md): abrir e tratar ocorrencias; autorizar devolucao, decidir a quarentena e
  // encerrar; receber e conferir a devolucao (expedicao e estoque, sem autorizar); registrar reembolso (so registro,
  // sem mover dinheiro; MFA, D9-5).
  'occurrences.manage',
  'returns.manage',
  'returns.receive',
  'refunds.record',
  // SGLog Fase 10 (docs/41-sglog-fase10.md): consultar custos (CMV, frete, embalagem, taxas, perdas); consultar margens
  // de contribuicao; consultar o painel Gestao e os relatorios gerenciais; alterar configuracoes financeiras (taxas,
  // aliquotas estimadas, embalagem; MFA); registrar e estornar custos externos (MFA). Tributo estimado so vale validado
  // por quem tem fiscal.validate (o contador).
  'costs.view',
  'margins.view',
  'management.view',
  'costs.settings',
  'costs.record',
  'sales_desk.use',
  'marketplaces.manage',
  'finance.view',
  'reports.view',
  // E-mail: ver a tela, alterar envio e textos, e criar/alterar caixas do dominio (docs/EMAIL.md).
  'email.view',
  'email.manage',
  'email.accounts',
  // Bot de atendimento do WhatsApp: ligar, textos, horario, chat de teste (docs/10-bot-atendimento-proposta.md).
  'bot.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'manager', 'sales', 'stock', 'fiscal', 'shipping', 'logistics', 'buyer', 'finance'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_DEFAULTS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: ['users.view', 'audit.view', 'settings.manage', 'company.view', 'fiscal.view', 'catalog.view', 'catalog.manage', 'prices.manage', 'catalog.import', 'stock.view', 'stock.manage', 'stock.transfer', 'stock.adjust', 'purchases.view', 'purchases.manage', 'purchases.approve', 'purchases.receive', 'purchases.pay', 'purchases.request', 'suppliers.view', 'suppliers.manage', 'logistics.view', 'logistics.allocate', 'shipping.pick', 'logistics.manage', 'orders.view', 'orders.manage', 'shipping.manage', 'shipping.labels', 'occurrences.manage', 'returns.manage', 'returns.receive', 'refunds.record', 'sales_desk.use', 'marketplaces.manage', 'finance.view', 'reports.view', 'email.view',
    // Fase 10: consulta custos, margens e o painel Gestao; nao altera configuracao financeira nem lanca custo.
    'costs.view', 'margins.view', 'management.view'],
  // Fase 9: o atendimento abre e acompanha ocorrencias.
  sales: ['catalog.view', 'stock.view', 'logistics.view', 'orders.view', 'sales_desk.use', 'occurrences.manage'],
  // Estoquista ve fornecedores, mas nao muda custo nem cadastro (D2-4); concessao individual continua possivel.
  // Fase 7 (D7-6): pede compra (requisicao).
  // Fase 3 (D3-2): transfere, mas nao ajusta direto; ajuste, perda e avaria viram solicitacao com aprovacao.
  stock: ['catalog.view', 'stock.view', 'stock.manage', 'stock.transfer', 'purchases.view', 'purchases.manage', 'purchases.receive', 'purchases.request', 'suppliers.view', 'logistics.view', 'shipping.pick', 'returns.receive'],
  // fiscal.validate fica so com quem o proprietario conceder (o contador ou responsavel tributario).
  fiscal: ['company.view', 'fiscal.view', 'fiscal.manage', 'catalog.view', 'orders.view'],
  // Fase 9 (R9-19): a expedicao recebe e confere a devolucao, mas nao autoriza nem registra reembolso.
  shipping: ['catalog.view', 'orders.view', 'shipping.manage', 'shipping.pick', 'logistics.view', 'occurrences.manage', 'returns.receive'],
  // SGLog (docs/sglog-fase0-auditoria.md §10.3.1): menor privilegio, so permissoes que ja existem.
  // Gerente de logistica: estoque, despacho e consulta de compras. Sem orders.manage (cancelar pedido mexe em
  // cobranca e nota) e sem reports.view (faturamento).
  logistics: ['catalog.view', 'stock.view', 'stock.manage', 'stock.transfer', 'stock.adjust', 'purchases.view', 'purchases.receive', 'purchases.request', 'suppliers.view', 'logistics.view', 'logistics.allocate', 'logistics.manage', 'shipping.pick', 'orders.view', 'shipping.manage', 'shipping.labels', 'occurrences.manage', 'returns.manage', 'returns.receive'],
  // Comprador: compras e fornecedores. Sem orders.view (dados pessoais de clientes) e sem stock.manage (ajustes e perdas).
  // Fase 6 (D6-1): nao recebe mercadoria (purchases.receive): quem compra nao da entrada no estoque.
  buyer: ['catalog.view', 'stock.view', 'purchases.view', 'purchases.manage', 'suppliers.view', 'suppliers.manage', 'logistics.view'],
  // Financeiro: pedidos, compras e relatorios de venda, so leitura. Sem logistics.view (D4-11). finance.view fica de fora: hoje so mostra custo
  // nas telas de estoque, que exigem stock.view.
  // Fase 9: registra o reembolso feito (MFA), sem mexer em devolucao fisica.
  // Fase 10: consulta custos, margens e o painel Gestao e lanca custos externos (MFA). Configuracao financeira fica com
  // o proprietario (concessao individual possivel).
  finance: ['orders.view', 'purchases.view', 'purchases.pay', 'suppliers.view', 'reports.view', 'refunds.record', 'costs.view', 'margins.view', 'management.view', 'costs.record'],
};

/** Permissoes que exigem verificacao em duas etapas ativa na conta. */
export const MFA_REQUIRED: ReadonlySet<Permission> = new Set(['users.manage', 'settings.manage', 'company.manage', 'fiscal.manage', 'fiscal.validate', 'prices.manage', 'catalog.import', 'marketplaces.manage', 'email.manage', 'email.accounts', 'bot.manage', 'stock.adjust', 'purchases.approve', 'shipping.labels', 'refunds.record', 'costs.settings', 'costs.record']);

export const roleDefaults = (role: string) => new Set<Permission>(ROLE_DEFAULTS[role as Role] ?? []);

/** Padrao do papel mais concessoes e revogacoes individuais. O proprietario nunca e limitado. */
export async function effectivePermissions(db: Db | { query: Db['query'] }, userId: string, role: string): Promise<Set<Permission>> {
  const result = roleDefaults(role);
  if (role === 'owner') return result;
  const { rows } = await db.query<{ permission: Permission; granted: boolean }>('SELECT permission, granted FROM user_permissions WHERE user_id = $1', [userId]);
  for (const row of rows) {
    if (!(PERMISSIONS as readonly string[]).includes(row.permission)) continue;
    if (row.granted) result.add(row.permission);
    else result.delete(row.permission);
  }
  return result;
}
