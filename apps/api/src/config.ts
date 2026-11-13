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
});

export const config = schema.parse(process.env);
export const isProduction = config.NODE_ENV === 'production';
if (isProduction && config.PAYMENT_FAKE) throw new Error('PAYMENT_FAKE nao pode ser usado em producao');
