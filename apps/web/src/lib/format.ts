const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const qtyFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });

export const money = (cents: string | number | null | undefined) => (cents === null || cents === undefined ? '—' : brl.format(Number(cents) / 100));
export const qty = (v: string | number) => qtyFmt.format(Number(v));
export const when = (v: string | Date | null | undefined) => (v ? dateTime.format(new Date(v)) : '—');

/** "12,50" ou "12.50" para centavos. Devolve null se nao for um valor valido. */
export function parseMoney(text: string): number | null {
  const clean = text.trim().replace(/\s|R\$/g, '');
  if (!clean) return null;
  const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}
export const centsToInput = (cents: string | number | null | undefined) => (cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2).replace('.', ','));

/** Quantidade digitada ("1,5" ou "1.5") no formato da API ("1.5"). */
export const parseQty = (text: string) => text.trim().replace(/\./g, '').replace(',', '.');
export const qtyToInput = (v: string) => String(Number(v)).replace('.', ',');

export function formatCnpj(v: string | null) {
  if (!v) return '';
  return v.length === 14 ? `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}` : v;
}

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Proprietário',
  manager: 'Gerente',
  sales: 'Atendimento',
  stock: 'Estoque e compras',
  fiscal: 'Fiscal',
  shipping: 'Expedição',
  logistics: 'Gerente de logística',
  buyer: 'Comprador',
  finance: 'Financeiro',
};

export const PERMISSION_LABELS: Record<string, string> = {
  'users.view': 'Ver usuários',
  'users.manage': 'Gerenciar usuários',
  'audit.view': 'Ver auditoria',
  'settings.manage': 'Configurar a loja',
  'company.view': 'Ver dados da empresa',
  'company.manage': 'Alterar dados da empresa',
  'fiscal.view': 'Ver configuração fiscal',
  'fiscal.manage': 'Informar dados fiscais',
  'fiscal.validate': 'Validar classificação fiscal (contador)',
  'catalog.view': 'Ver catálogo',
  'catalog.manage': 'Cadastrar produtos',
  'prices.manage': 'Alterar preços',
  'catalog.import': 'Importar produtos por planilha (Excel)',
  'stock.view': 'Ver estoque',
  'stock.manage': 'Movimentar estoque',
  'stock.transfer': 'Transferir entre depósitos',
  'stock.adjust': 'Ajustar estoque, perdas, avarias e estornos (exige verificação em duas etapas)',
  'logistics.view': 'Ver a alocação dos pedidos (depósito e fornecedor)',
  'logistics.allocate': 'Confirmar, trocar e desfazer a alocação dos pedidos',
  'logistics.manage': 'Criar, dividir, liberar e cancelar remessas',
  'shipping.pick': 'Separar, conferir e embalar remessas',
  'purchases.view': 'Ver compras',
  'purchases.manage': 'Registrar compras',
  'purchases.approve': 'Aprovar compras',
  'purchases.receive': 'Receber mercadoria de compras',
  'purchases.pay': 'Informar pagamento de compras (sem movimentar dinheiro)',
  'purchases.request': 'Pedir compra (requisição interna)',
  'suppliers.view': 'Ver fornecedores, ofertas e disponibilidade',
  'suppliers.manage': 'Cadastrar fornecedores e alterar custos',
  'orders.view': 'Ver pedidos',
  'orders.manage': 'Gerenciar pedidos',
  'shipping.manage': 'Expedição',
  'sales_desk.use': 'Central comercial',
  'marketplaces.manage': 'Marketplaces (Mercado Livre, Shopee)',
  'finance.view': 'Ver financeiro',
  'reports.view': 'Ver relatórios',
  'email.view': 'Ver e-mails da loja',
  'email.manage': 'Configurar envio e textos dos e-mails',
  'email.accounts': 'Criar e alterar caixas de e-mail',
  'bot.manage': 'Configurar o bot de atendimento do WhatsApp',
};

export const TAX_REGIMES: Record<string, string> = {
  mei: 'MEI',
  simples_nacional: 'Simples Nacional',
  simples_excesso_sublimite: 'Simples Nacional – excesso de sublimite',
  lucro_presumido: 'Lucro Presumido',
  lucro_real: 'Lucro Real',
};

export const ORIGINS = [
  '0 – Nacional',
  '1 – Estrangeira, importação direta',
  '2 – Estrangeira, adquirida no mercado interno',
  '3 – Nacional, conteúdo de importação entre 40% e 70%',
  '4 – Nacional, processos produtivos básicos',
  '5 – Nacional, conteúdo de importação até 40%',
  '6 – Estrangeira, importação direta, sem similar nacional (CAMEX)',
  '7 – Estrangeira, mercado interno, sem similar nacional (CAMEX)',
  '8 – Nacional, conteúdo de importação acima de 70%',
];

const unitBrl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** Custo por unidade base: um copo pode custar R$ 0,0437, entao mostra ate 4 casas. */
export const unitMoney = (cents: string | number | null | undefined) => (cents === null || cents === undefined ? '—' : unitBrl.format(Number(cents) / 100));
