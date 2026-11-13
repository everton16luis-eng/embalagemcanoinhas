import { buildApp } from './app.js';
import { config } from './config.js';
import { pool, tx } from './db/pool.js';
import { expireReservations } from './lib/stock.js';
import { expireOrders } from './modules/orders.js';

const app = await buildApp({
  // Sem provedor de e-mail configurado o link nao e entregue. O token nunca vai para o log.
  notifier: async () => {
    app.log.warn('Recuperacao de senha solicitada, mas nenhum provedor de e-mail esta configurado');
  },
});

// Reservas vencidas (carrinho abandonado, pedido sem pagamento) voltam ao disponivel.
const expiry = setInterval(() => {
  tx(null, (db) => expireReservations(db))
    .then((n) => n && app.log.info(`${n} reserva(s) vencida(s) liberada(s)`))
    .catch((err) => app.log.error(err, 'falha ao liberar reservas vencidas'));
  // Pedido sem pagamento no prazo: cancela e devolve o estoque reservado.
  expireOrders(app.payments)
    .then((n) => n && app.log.info(`${n} pedido(s) sem pagamento cancelado(s)`))
    .catch((err) => app.log.error(err, 'falha ao cancelar pedidos vencidos'));
}, 60_000);
expiry.unref();

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: encerrando depois das requisicoes em andamento`);
  setTimeout(() => process.exit(1), 15_000).unref();
  clearInterval(expiry);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
