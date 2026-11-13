import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = await buildApp({
  // Sem provedor de e-mail configurado o link nao e entregue. O token nunca vai para o log.
  notifier: async () => {
    app.log.warn('Recuperacao de senha solicitada, mas nenhum provedor de e-mail esta configurado');
  },
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: encerrando depois das requisicoes em andamento`);
  setTimeout(() => process.exit(1), 15_000).unref();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
