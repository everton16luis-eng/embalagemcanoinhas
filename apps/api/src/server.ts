import { buildApp } from './app.js';
import { config, isProduction, productionWarnings } from './config.js';
import { pool, tx } from './db/pool.js';
import { expireReservations } from './lib/stock.js';
import { fiscalTick } from './modules/fiscal.js';
import { marketplaceTick } from './modules/marketplaces.js';
import { whatsappTick } from './modules/whatsapp.js';
import { botTick } from './modules/bot.js';
import { expireOrders } from './modules/orders.js';
import { allocatePending } from './modules/logistics.js';

// Recuperacao de senha pelo SMTP do .env (docs/EMAIL.md). Sem SMTP o link nao e entregue; o token nunca vai para o log.
const app = await buildApp({});

if (isProduction) for (const w of productionWarnings(config)) app.log.warn(w);
if (!app.mailer.configured) app.log.warn('E-mail nao configurado (SMTP_HOST/MAIL_FROM): recuperacao de senha por e-mail fica indisponivel');
if (!app.emailAccounts) app.log.info('Caixas de e-mail pelo painel desligadas (EMAIL_ACCOUNTS_SOCKET vazio)');

// Reservas vencidas (carrinho abandonado, pedido sem pagamento) voltam ao disponivel.
const expiry = setInterval(() => {
  tx(null, (db) => expireReservations(db))
    .then((n) => n && app.log.info(`${n} reserva(s) vencida(s) liberada(s)`))
    .catch((err) => app.log.error(err, 'falha ao liberar reservas vencidas'));
  // Pedido sem pagamento no prazo: cancela e devolve o estoque reservado.
  expireOrders(app.payments)
    .then((n) => n && app.log.info(`${n} pedido(s) sem pagamento cancelado(s)`))
    .catch((err) => app.log.error(err, 'falha ao cancelar pedidos vencidos'));
  // SGLog Fase 4: pedidos pagos aguardando alocacao (fora do pagamento). ALLOCATION_AUTO=off so separa os de analise.
  allocatePending({ auto: config.ALLOCATION_AUTO })
    .then((r) => (r.allocated || r.analysis || r.failed) && app.log.info({ allocation: r }, 'rotina de alocação'))
    .catch((err) => app.log.error(err, 'falha na rotina de alocação'));
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
  // Bot: responde o que o webhook nao conseguiu responder na hora.
  botTick(app.whatsapp).catch((err) => app.log.error(err, 'falha na rotina do bot'));
}, 60_000);
expiry.unref();

// Contadores de limite vencidos (auditoria 11/2026): cada IP e rota deixava uma linha para sempre.
// So contadores ja sem efeito: janela encerrada ha mais de 1 hora e bloqueio de login vencido.
const housekeeping = setInterval(() => {
  pool
    .query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 hour'`)
    .then(() => pool.query(`DELETE FROM auth_throttle WHERE window_start < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`))
    .catch((err) => app.log.error(err, 'falha ao limpar contadores de limite'));
}, 3_600_000);
housekeeping.unref();

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: encerrando depois das requisicoes em andamento`);
  setTimeout(() => process.exit(1), 15_000).unref();
  clearInterval(expiry);
  clearInterval(housekeeping);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
