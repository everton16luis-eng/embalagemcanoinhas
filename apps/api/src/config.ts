import { z } from 'zod';

/** Linha vazia no .env conta como ausente. */
const blankAsMissing = <T extends z.ZodType>(s: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_NAME: z.string().regex(/^loja_[a-z]+$/, 'DB_NAME deve seguir o padrao loja_*'),
  APP_DB_USER: z.literal('loja_app'),
  APP_DB_PASSWORD: z.string().min(16),
  APP_ORIGIN: z.url(),
  // Chave AES-256 (64 hex) para segredos: MFA, credenciais de provedores e, na Fase 5, o certificado A1.
  ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/),
  // Quantos proxies confiaveis existem na frente da API. Nunca "todos": o cliente escolheria o proprio IP.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  PORT: z.coerce.number().int().positive().default(4010),
  HOST: z.string().min(1).default('127.0.0.1'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_STORE: blankAsMissing(z.enum(['memory', 'postgres']).optional()),
  STORAGE_DIR: z.string().min(1).default('../../storage'),
  // Mercado Pago (credenciais da conta da loja; vazias = pagamento online desligado).
  MP_ACCESS_TOKEN: blankAsMissing(z.string().min(20).optional()),
  MP_PUBLIC_KEY: blankAsMissing(z.string().min(20).optional()),
  MP_WEBHOOK_SECRET: blankAsMissing(z.string().min(16).optional()),
  // Endereco publico que o Mercado Pago chama (https em producao).
  PUBLIC_API_URL: blankAsMissing(z.url().optional()),
  PIX_EXPIRATION_MINUTES: z.coerce.number().int().min(30).max(1440).default(60),
  CARD_PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(10).max(1440).default(30),
  // Somente desenvolvimento: provedor simulado para testar a loja sem conta no Mercado Pago.
  PAYMENT_FAKE: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  // Provedor fiscal (docs/05-fiscal-nfe.md). Um token por ambiente; vazio = emissao desligada naquele ambiente.
  FOCUS_TOKEN_HOMOLOGACAO: blankAsMissing(z.string().min(16).optional()),
  FOCUS_TOKEN_PRODUCAO: blankAsMissing(z.string().min(16).optional()),
  // Valor que o provedor envia no header do aviso (cadastrado em authorization do gatilho).
  FISCAL_WEBHOOK_SECRET: blankAsMissing(z.string().min(24).optional()),
  // Somente desenvolvimento: provedor fiscal simulado.
  FISCAL_FAKE: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  // Marketplaces (docs/07-marketplaces.md). Credenciais do aplicativo cadastrado em cada plataforma; vazias = desligado.
  ML_CLIENT_ID: blankAsMissing(z.string().regex(/^\d{1,30}$/).optional()),
  ML_CLIENT_SECRET: blankAsMissing(z.string().min(16).optional()),
  // URL de retorno cadastrada no aplicativo. Padrao: pagina do painel em APP_ORIGIN.
  ML_REDIRECT_URI: blankAsMissing(z.url().optional()),
  SHOPEE_PARTNER_ID: blankAsMissing(z.string().regex(/^\d{1,20}$/).optional()),
  SHOPEE_PARTNER_KEY: blankAsMissing(z.string().min(16).optional()),
  SHOPEE_REDIRECT_URI: blankAsMissing(z.url().optional()),
  SHOPEE_API_HOST: z.url().default('https://partner.shopeemobile.com'),
  SHOPEE_AUTH_HOST: z.url().default('https://open.shopee.com.br'),
  // URL exata cadastrada para o push da Shopee (entra na assinatura). Padrao: PUBLIC_API_URL + /api/v1/webhooks/marketplaces/shopee.
  SHOPEE_PUSH_URL: blankAsMissing(z.url().optional()),
  // WhatsApp Cloud API (docs/08). Numero, token de usuario do sistema, segredo do app e token de verificacao do webhook.
  WA_PHONE_NUMBER_ID: blankAsMissing(z.string().regex(/^[0-9]{5,30}$/).optional()),
  WA_ACCESS_TOKEN: blankAsMissing(z.string().min(20).optional()),
  WA_APP_SECRET: blankAsMissing(z.string().min(16).optional()),
  WA_VERIFY_TOKEN: blankAsMissing(z.string().min(16).optional()),
  WA_GRAPH_VERSION: z.string().regex(/^v[0-9]{1,3}[.][0-9]$/).default('v27.0'),
  WHATSAPP_FAKE: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  // Transportadoras (docs/08 §2): Melhor Envio. Token do aplicativo; User-Agent com nome do app e e-mail tecnico (obrigatorio).
  MELHOR_ENVIO_TOKEN: blankAsMissing(z.string().min(20).optional()),
  MELHOR_ENVIO_USER_AGENT: blankAsMissing(z.string().min(5).max(200).optional()),
  MELHOR_ENVIO_SANDBOX: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v !== 'false'),
  // CEP de onde sai a mercadoria (cotacao).
  SHIP_FROM_CEP: blankAsMissing(z.string().regex(/^[0-9]{8}$/).optional()),
  CARRIER_FAKE: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  // Somente desenvolvimento: marketplaces simulados.
  MARKETPLACE_FAKE: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  // E-mail (docs/EMAIL.md). SMTP do servidor proprio; SMTP_HOST vazio = envio desligado.
  SMTP_HOST: blankAsMissing(z.string().regex(/^[a-z0-9.-]{3,253}$/i).optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // false + 587 = STARTTLS obrigatorio; true so para a porta 465.
  SMTP_SECURE: blankAsMissing(z.enum(['true', 'false']).optional()).transform((v) => v === 'true'),
  SMTP_USER: blankAsMissing(z.string().max(254).optional()),
  SMTP_PASS: blankAsMissing(z.string().max(200).optional()),
  // Mesmo endereco do login SMTP (ou um apelido dele), senao o Postfix recusa ou o DMARC reprova.
  MAIL_FROM: blankAsMissing(z.string().max(300).optional()),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  // Socket do systemd que altera as caixas do dominio da loja (deploy/systemd/loja-contas-email.socket). Vazio = desligado.
  EMAIL_ACCOUNTS_SOCKET: blankAsMissing(z.string().max(200).optional()),
  // Opcional: endereco do webmail, mostrado nas instrucoes das caixas.
  EMAIL_WEBMAIL_URL: blankAsMissing(z.url().optional()),
});

export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);
export const isProduction = config.NODE_ENV === 'production';

/** O que impede subir em producao: enderecos publicos sem HTTPS (cookies Secure e webhooks exigem). */
export function productionErrors(c: Pick<Config, 'APP_ORIGIN' | 'PUBLIC_API_URL' | 'ML_REDIRECT_URI' | 'SHOPEE_REDIRECT_URI' | 'SHOPEE_PUSH_URL'>): string[] {
  const urls: [string, string | undefined][] = [
    ['APP_ORIGIN', c.APP_ORIGIN],
    ['PUBLIC_API_URL', c.PUBLIC_API_URL],
    ['ML_REDIRECT_URI', c.ML_REDIRECT_URI],
    ['SHOPEE_REDIRECT_URI', c.SHOPEE_REDIRECT_URI],
    ['SHOPEE_PUSH_URL', c.SHOPEE_PUSH_URL],
  ];
  return urls.filter(([, v]) => v !== undefined && !v.startsWith('https://')).map(([k]) => `${k} precisa ser https:// em producao`);
}

/** Avisos de producao que nao impedem a subida. */
export function productionWarnings(c: Pick<Config, 'TRUST_PROXY'>): string[] {
  return c.TRUST_PROXY === 0 ? ['TRUST_PROXY=0: atras do nginx os limites de tentativas valeriam para todos os clientes juntos (use 1)'] : [];
}

if (isProduction) {
  const errors = productionErrors(config);
  if (errors.length) throw new Error(errors.join('; '));
}
if (isProduction && config.PAYMENT_FAKE) throw new Error('PAYMENT_FAKE nao pode ser usado em producao');
if (isProduction && config.FISCAL_FAKE) throw new Error('FISCAL_FAKE nao pode ser usado em producao');
if (isProduction && config.MARKETPLACE_FAKE) throw new Error('MARKETPLACE_FAKE nao pode ser usado em producao');
if (isProduction && config.WHATSAPP_FAKE) throw new Error('WHATSAPP_FAKE nao pode ser usado em producao');
if (isProduction && config.CARRIER_FAKE) throw new Error('CARRIER_FAKE nao pode ser usado em producao');
