import { ensureTestDatabase } from './env-guard.js';

// Roda uma vez, no processo principal do vitest, antes de qualquer arquivo de teste. Aqui process.env ainda
// tem os valores do .env (o vitest.config so troca DB_NAME dentro dos processos de teste).
export default async function setup() {
  await ensureTestDatabase(process.env);
}
