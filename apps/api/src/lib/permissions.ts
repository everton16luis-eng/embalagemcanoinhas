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
  'purchases.view',
  'purchases.manage',
  // SGLog Fase 2 (docs/18-sglog-fase2.md): fornecedores, ofertas, custo e disponibilidade. Lista, detalhe e ofertas
  // tambem aceitam purchases.view (a tela de compras escolhe fornecedor).
  'suppliers.view',
  'suppliers.manage',
  'orders.view',
  'orders.manage',
  'shipping.manage',
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
  manager: ['users.view', 'audit.view', 'settings.manage', 'company.view', 'fiscal.view', 'catalog.view', 'catalog.manage', 'prices.manage', 'catalog.import', 'stock.view', 'stock.manage', 'purchases.view', 'purchases.manage', 'suppliers.view', 'suppliers.manage', 'orders.view', 'orders.manage', 'shipping.manage', 'sales_desk.use', 'marketplaces.manage', 'finance.view', 'reports.view', 'email.view'],
  sales: ['catalog.view', 'stock.view', 'orders.view', 'sales_desk.use'],
  // Estoquista ve fornecedores, mas nao muda custo nem cadastro (D2-4); concessao individual continua possivel.
  stock: ['catalog.view', 'stock.view', 'stock.manage', 'purchases.view', 'purchases.manage', 'suppliers.view'],
  // fiscal.validate fica so com quem o proprietario conceder (o contador ou responsavel tributario).
  fiscal: ['company.view', 'fiscal.view', 'fiscal.manage', 'catalog.view', 'orders.view'],
  shipping: ['catalog.view', 'orders.view', 'shipping.manage'],
  // SGLog (docs/sglog-fase0-auditoria.md §10.3.1): menor privilegio, so permissoes que ja existem.
  // Gerente de logistica: estoque, despacho e consulta de compras. Sem orders.manage (cancelar pedido mexe em
  // cobranca e nota) e sem reports.view (faturamento).
  logistics: ['catalog.view', 'stock.view', 'stock.manage', 'purchases.view', 'suppliers.view', 'orders.view', 'shipping.manage'],
  // Comprador: compras e fornecedores. Sem orders.view (dados pessoais de clientes) e sem stock.manage (ajustes e perdas).
  buyer: ['catalog.view', 'stock.view', 'purchases.view', 'purchases.manage', 'suppliers.view', 'suppliers.manage'],
  // Financeiro: pedidos, compras e relatorios de venda, so leitura. finance.view fica de fora: hoje so mostra custo
  // nas telas de estoque, que exigem stock.view.
  finance: ['orders.view', 'purchases.view', 'suppliers.view', 'reports.view'],
};

/** Permissoes que exigem verificacao em duas etapas ativa na conta. */
export const MFA_REQUIRED: ReadonlySet<Permission> = new Set(['users.manage', 'settings.manage', 'company.manage', 'fiscal.manage', 'fiscal.validate', 'prices.manage', 'catalog.import', 'marketplaces.manage', 'email.manage', 'email.accounts', 'bot.manage']);

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
