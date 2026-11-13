import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { requireAuth } from './auth.js';
import { currentCompany } from './company.js';

type Status = 'done' | 'missing' | 'later';
type Item = { key: string; label: string; status: Status; owner: 'empresa' | 'contador' | 'sistema'; required: boolean; hint?: string };
type Group = { key: string; title: string; items: Item[] };

// O que a NF-e exige do emitente (bloco emit). Os demais campos sao recomendados.
const REQUIRED_COMPANY: [string, string, string?][] = [
  ['legal_name', 'Razão social', 'Exatamente como no cartão CNPJ.'],
  ['cnpj', 'CNPJ da sede'],
  ['state_registration', 'Inscrição Estadual (SC)', 'Obrigatória para emitir NF-e de venda de mercadorias.'],
  ['street', 'Logradouro'],
  ['number', 'Número'],
  ['district', 'Bairro'],
  ['city', 'Município'],
  ['city_ibge', 'Código IBGE do município', 'Consulte na tabela oficial do IBGE.'],
  ['uf', 'UF'],
  ['cep', 'CEP'],
  ['tax_regime', 'Regime tributário', 'Confirme com o contador.'],
];
const RECOMMENDED_COMPANY: [string, string, string?][] = [
  ['trade_name', 'Nome fantasia'],
  ['phone', 'Telefone'],
  ['email', 'E-mail'],
  ['cnae_main', 'CNAE principal', 'Deve cobrir o comércio dos produtos vendidos.'],
];

/** Assistente de configuracao: o que ja foi informado, o que falta e quem deve informar. */
export async function setupRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requireAuth(req);
    const company = await currentCompany(pool);
    const fiscal = (await pool.query('SELECT * FROM fiscal_settings')).rows[0];
    const store = (await pool.query('SELECT * FROM store_settings')).rows[0];
    const counts = (
      await pool.query<{ products: number; pending: number; informed: number; validated: number; no_image: number }>(
        `SELECT count(*)::int AS products,
                count(*) FILTER (WHERE coalesce(f.status, 'pending') = 'pending')::int AS pending,
                count(*) FILTER (WHERE f.status = 'informed')::int AS informed,
                count(*) FILTER (WHERE f.status = 'validated')::int AS validated,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id))::int AS no_image
         FROM products p LEFT JOIN product_fiscal f ON f.product_id = p.id WHERE p.status <> 'inactive'`,
      )
    ).rows[0]!;
    const launch = (
      await pool.query<{ rules: number; validated_rules: number; cert_until: Date | null; homolog_ok: number; homolog_canceled: number; shipping: number }>(
        `SELECT (SELECT count(*)::int FROM fiscal_rules) AS rules,
                (SELECT count(*)::int FROM fiscal_rules WHERE status = 'validated') AS validated_rules,
                (SELECT valid_until FROM fiscal_certificates WHERE active) AS cert_until,
                (SELECT count(*)::int FROM fiscal_documents WHERE environment = 'homologacao' AND provider <> 'fake' AND status IN ('authorized', 'canceled')) AS homolog_ok,
                (SELECT count(*)::int FROM fiscal_documents WHERE environment = 'homologacao' AND provider <> 'fake' AND status = 'canceled') AS homolog_canceled,
                (SELECT count(*)::int FROM shipping_options WHERE active) AS shipping`,
      )
    ).rows[0]!;
    const certDays = launch.cert_until ? Math.floor((launch.cert_until.getTime() - Date.now()) / 86_400_000) : null;
    const fiscalReal = app.fiscal && app.fiscal.name !== 'fake' ? app.fiscal : null;
    const paymentsReal = app.payments && app.payments.name !== 'fake';
    const has = (col: string) => Boolean(company && company[col] !== null && company[col] !== '');
    const groups: Group[] = [
      {
        key: 'company',
        title: 'Dados da empresa (emitente)',
        items: [
          ...REQUIRED_COMPANY.map(([col, label, hint]) => ({ key: col, label, hint, status: (has(col) ? 'done' : 'missing') as Status, owner: 'empresa' as const, required: true })),
          ...RECOMMENDED_COMPANY.map(([col, label, hint]) => ({ key: col, label, hint, status: (has(col) ? 'done' : 'missing') as Status, owner: 'empresa' as const, required: false })),
        ],
      },
      {
        key: 'accountant',
        title: 'Contador ou responsável fiscal',
        items: [
          { key: 'accountant_name', label: 'Nome do contador', status: has('accountant_name') ? 'done' : 'missing', owner: 'empresa', required: true },
          { key: 'accountant_crc', label: 'CRC', status: has('accountant_crc') ? 'done' : 'missing', owner: 'contador', required: true },
          { key: 'accountant_contact', label: 'E-mail ou telefone do contador', status: has('accountant_email') || has('accountant_phone') ? 'done' : 'missing', owner: 'contador', required: true },
          {
            key: 'products_validated',
            label: 'Classificação fiscal dos produtos validada',
            hint: counts.products ? `${counts.validated} de ${counts.products} validados; ${counts.pending} sem dados; ${counts.informed} aguardando o contador.` : 'Cadastre os produtos primeiro.',
            status: counts.products > 0 && counts.validated === counts.products ? 'done' : 'missing',
            owner: 'contador',
            required: true,
          },
          {
            key: 'tax_rules',
            label: 'Regras de ICMS, PIS, COFINS, CFOP e CST/CSOSN por operação',
            hint: launch.rules ? `${launch.validated_rules} de ${launch.rules} regra(s) validadas pelo contador.` : 'Cadastradas em Nota fiscal, a partir da orientação do contador.',
            status: launch.rules > 0 && launch.validated_rules === launch.rules ? 'done' : 'missing',
            owner: 'contador',
            required: true,
          },
        ],
      },
      {
        key: 'fiscal',
        title: 'Emissão de NF-e',
        items: [
          {
            key: 'accreditation',
            label: 'Credenciamento como emissor de NF-e na SEF-SC',
            hint: fiscal.accreditation_status === 'in_progress' ? 'Em andamento.' : 'Feito pela empresa ou pelo contador junto à SEF-SC.',
            status: fiscal.accreditation_status === 'accredited' ? 'done' : 'missing',
            owner: 'contador',
            required: true,
          },
          {
            key: 'certificate',
            label: 'Certificado digital A1 do CNPJ',
            hint:
              certDays === null
                ? 'Enviado ao provedor fiscal; aqui ficam titular e validade.'
                : certDays < 0
                  ? 'Vencido: a emissão para.'
                  : `Vence em ${certDays} dia(s).${certDays <= 30 ? ' Renove já.' : ''}`,
            status: certDays !== null && certDays > 0 ? 'done' : 'missing',
            owner: 'empresa',
            required: true,
          },
          { key: 'series', label: 'Série e próximo número da NF-e', hint: 'Se já emitiu notas em outro sistema, informe a série e o último número usado.', status: fiscal.nfe_series !== null && fiscal.nfe_next_number ? 'done' : 'missing', owner: 'contador', required: true },
          {
            key: 'provider',
            label: 'Provedor fiscal com token de homologação no servidor',
            hint: fiscalReal ? undefined : app.fiscal ? 'Só o simulado de desenvolvimento.' : 'Token do provedor no .env do servidor.',
            status: fiscalReal?.configured('homologacao') ? 'done' : 'missing',
            owner: 'sistema',
            required: true,
          },
        ],
      },
      {
        key: 'store',
        title: 'Marca e loja',
        items: [
          { key: 'store_name', label: 'Nome da loja', status: store.store_name ? 'done' : 'missing', owner: 'empresa', required: true },
          { key: 'domain', label: 'Domínio', status: store.domain ? 'done' : 'missing', owner: 'empresa', required: true },
          { key: 'support', label: 'E-mail de atendimento', status: store.support_email ? 'done' : 'missing', owner: 'empresa', required: true },
          { key: 'whatsapp', label: 'WhatsApp de atendimento', status: store.whatsapp_number ? 'done' : 'missing', owner: 'empresa', required: false },
          { key: 'policies', label: 'Política de trocas e devoluções', status: store.pages?.returns ? 'done' : 'missing', owner: 'empresa', required: true },
          { key: 'images', label: 'Fotos dos produtos', hint: counts.products ? `${counts.no_image} produto(s) sem foto.` : undefined, status: counts.products > 0 && counts.no_image === 0 ? 'done' : 'missing', owner: 'empresa', required: true },
        ],
      },
      {
        key: 'payments',
        title: 'Pagamentos',
        items: [
          {
            key: 'gateway',
            label: 'Conta e credenciais do provedor de pagamento',
            hint: paymentsReal ? undefined : app.payments ? 'Só o simulado de desenvolvimento.' : 'Credenciais do Mercado Pago no .env do servidor.',
            status: paymentsReal ? 'done' : 'missing',
            owner: 'empresa',
            required: true,
          },
        ],
      },
      {
        key: 'launch',
        title: 'Antes de vender',
        items: [
          {
            key: 'shipping',
            label: 'Formas de entrega reais',
            hint: launch.shipping ? `${launch.shipping} forma(s) ativa(s): confira valores e faixas de CEP.` : 'Nenhuma forma de entrega ativa.',
            status: launch.shipping > 0 ? 'done' : 'missing',
            owner: 'empresa',
            required: true,
          },
          { key: 'privacy', label: 'Política de privacidade (LGPD)', status: store.pages?.privacy ? 'done' : 'missing', owner: 'empresa', required: true },
          { key: 'terms', label: 'Termos de uso e condições de venda', status: store.pages?.terms ? 'done' : 'missing', owner: 'empresa', required: true },
          {
            key: 'homologation',
            label: 'NF-e de teste autorizada e cancelada em homologação',
            hint: `${launch.homolog_ok} autorizada(s), ${launch.homolog_canceled} cancelada(s) no provedor real.`,
            status: launch.homolog_ok > 0 && launch.homolog_canceled > 0 ? 'done' : 'missing',
            owner: 'sistema',
            required: true,
          },
          {
            key: 'production',
            label: 'Produção fiscal liberada com a validação do contador',
            hint: fiscal.environment === 'producao' ? `Liberada; validação de ${fiscal.production_validator_name ?? '—'}.` : 'Liberação em Nota fiscal, depois dos itens acima.',
            status: fiscal.environment === 'producao' ? 'done' : 'missing',
            owner: 'contador',
            required: true,
          },
          { key: 'backup', label: 'Backup diário e teste de restauração no servidor', hint: 'Conferido fora do sistema: ver docs/IMPLANTACAO.md e docs/BACKUP.md.', status: 'later', owner: 'sistema', required: true },
        ],
      },
    ];
    const all = groups.flatMap((g) => g.items).filter((i) => i.required);
    return { groups, summary: { required: all.length, done: all.filter((i) => i.status === 'done').length, later: all.filter((i) => i.status === 'later').length } };
  });
}
