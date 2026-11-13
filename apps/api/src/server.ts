import { buildApp } from './app.js';
import { config } from './config.js';
import { pool, tx } from './db/pool.js';
import { expireReservations } from './lib/stock.js';
import { fiscalTick } from './modules/fiscal.js';
import { marketplaceTick } from './modules/marketplaces.js';
import { whatsappTick } from './modules/whatsapp.js';
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
  // NF-e em processamento: consulta o provedor; com politica "ao pagar", emite as notas devidas.
  fiscalTick(app.fiscal)
    .then((r) => (r.synced || r.emitted) && app.log.info(`fiscal: ${r.synced} nota(s) consultada(s), ${r.emitted} emitida(s)`))
    .catch((err) => app.log.error(err, 'falha na rotina fiscal'));
  // Marketplaces: renova tokens, consulta vendas avisadas (ou paradas) e envia saldos alterados.
  marketplaceTick(app.marketplaces)
    .then((r) => (r.refreshed || Object.keys(r.sales).length || r.stock.pushed || r.stock.failed) && app.log.info({ marketplaces: r }, 'rotina de marketplaces'))
    .catch((err) => app.log.error(err, 'falha na rotina de marketplaces'));
  // WhatsApp: envia os avisos de pedido da fila.
  whatsappTick(app.whatsapp)
    .then((r) => (r.sent || r.failed) && app.log.info(`whatsapp: ${r.sent} aviso(s) enviado(s), ${r.failed} com falha`))
    .catch((err) => app.log.error(err, 'falha na rotina do WhatsApp'));
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
