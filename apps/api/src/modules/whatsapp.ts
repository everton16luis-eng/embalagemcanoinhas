import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { keyedHash } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { toWhatsAppNumber, WhatsAppRejected, type WhatsAppProvider } from '../lib/whatsapp.js';
import { requirePermission } from './auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    whatsapp: WhatsAppProvider | null;
  }
}

export const WA_EVENTS = ['order_paid', 'order_ready', 'order_shipped'] as const;
export type WaEvent = (typeof WA_EVENTS)[number];
export const WA_EVENT_LABEL: Record<WaEvent, string> = {
  order_paid: 'Pagamento confirmado',
  order_ready: 'Pronto para retirada',
  order_shipped: 'Pedido despachado',
};
const WINDOW_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 8;
const STOP_WORDS = new Set(['sair', 'parar', 'pare', 'stop', 'cancelar']);
const phoneHash = (phone: string) => keyedHash(`wa-optout:${phone}`);

/** Texto do consentimento. Sem nome da loja nao ha opt-in valido (a Meta exige o nome da empresa). */
export const optinText = (storeName: string) => `Quero receber atualizações deste pedido pelo WhatsApp da ${storeName}. Para parar, responda SAIR.`;

export async function currentOptinText(db: Db | typeof pool) {
  const name = (await db.query<{ store_name: string | null }>('SELECT store_name FROM store_settings')).rows[0]?.store_name;
  return name ? optinText(name) : null;
}

/**
 * Coloca o aviso do pedido na fila, na transacao de quem chama. So com opt-in, telefone valido, modelo configurado
 * e numero fora da lista de bloqueio. Repetir o evento nao duplica.
 */
export async function queueOrderMessage(db: Db, orderId: string, event: WaEvent) {
  const o = (
    await db.query<{ number: number; buyer: { name?: string; phone?: string }; whatsapp_optin_at: Date | null; tracking_code: string | null }>(
      `SELECT o.number, o.buyer, o.whatsapp_optin_at, s.tracking_code FROM orders o LEFT JOIN shipments s ON s.order_id = o.id WHERE o.id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!o?.whatsapp_optin_at) return false;
  const to = toWhatsAppNumber(o.buyer?.phone);
  if (!to) return false;
  const t = (await db.query<{ name: string; language: string }>(`SELECT name, language FROM whatsapp_templates WHERE event = $1 AND active`, [event])).rows[0];
  if (!t) return false;
  if ((await db.query('SELECT 1 FROM whatsapp_optouts WHERE phone_hash = $1', [phoneHash(to)])).rows[0]) return false;
  const params: Record<string, string> = { nome: String(o.buyer?.name ?? '').trim().split(/\s+/)[0] || 'cliente', pedido: String(o.number) };
  if (event === 'order_shipped') params.rastreio = o.tracking_code || 'informado pela loja';
  const r = await db.query(
    `INSERT INTO whatsapp_messages (order_id, event, kind, to_phone, template_name, language, params) VALUES ($1, $2, 'template', $3, $4, $5, $6)
     ON CONFLICT (order_id, event) DO NOTHING`,
    [orderId, event, to, t.name, t.language, JSON.stringify(params)],
  );
  return (r.rowCount ?? 0) > 0;
}

type QueuedRow = { id: string; to_phone: string; template_name: string; language: string; params: Record<string, string>; attempts: number };

/** Envia os avisos da fila. Cada mensagem e reservada antes do envio: duas instancias nao mandam a mesma. */
export async function whatsappTick(provider: WhatsAppProvider | null, limit = 20) {
  if (!provider) return { sent: 0, failed: 0 };
  const { rows } = await pool.query<QueuedRow>(
    `UPDATE whatsapp_messages SET next_attempt_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
     WHERE id IN (SELECT id FROM whatsapp_messages WHERE status = 'queued' AND kind = 'template' AND next_attempt_at <= now()
                  ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, to_phone, template_name, language, params, attempts`,
    [limit],
  );
  let sent = 0;
  let failed = 0;
  for (const m of rows) {
    if ((await pool.query('SELECT 1 FROM whatsapp_optouts WHERE phone_hash = $1', [phoneHash(m.to_phone)])).rows[0]) {
      await pool.query(`UPDATE whatsapp_messages SET status = 'canceled', error = 'Cliente pediu para não receber mais', updated_at = now() WHERE id = $1`, [m.id]);
      continue;
    }
    try {
      const r = await provider.sendTemplate({ to: m.to_phone, name: m.template_name, language: m.language, params: m.params });
      await pool.query(`UPDATE whatsapp_messages SET status = 'sent', wamid = $2, error = NULL, updated_at = now() WHERE id = $1 AND status = 'queued'`, [m.id, r.wamid]);
      sent++;
    } catch (err) {
      const final = err instanceof WhatsAppRejected || m.attempts >= MAX_ATTEMPTS;
      await pool.query(
        `UPDATE whatsapp_messages SET status = CASE WHEN $3 THEN 'failed' ELSE status END, error = $2,
           next_attempt_at = now() + make_interval(mins => least(power(2, $4)::int, 360)), updated_at = now() WHERE id = $1`,
        [m.id, (err as Error).message.slice(0, 500), final, m.attempts],
      );
      if (final) failed++;
    }
  }
  return { sent, failed };
}

// ---------------- webhook ----------------

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyWebhook(body: any) {
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const v = change.value ?? {};
      const names = new Map<string, string>();
      for (const c of Array.isArray(v.contacts) ? v.contacts : []) if (typeof c?.wa_id === 'string') names.set(c.wa_id, String(c?.profile?.name ?? '').slice(0, 200));
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const from = typeof m?.from === 'string' && /^\d{6,20}$/.test(m.from) ? m.from : null;
        if (!from || typeof m?.id !== 'string') continue; // usuario sem numero (so username): fora do escopo por enquanto
        const text = m.type === 'text' && typeof m.text?.body === 'string' ? m.text.body.slice(0, 4096) : null;
        const ts = Number(m.timestamp);
        const inserted = await pool.query(
          `INSERT INTO whatsapp_inbound (wamid, from_phone, profile_name, type, body, sent_at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6)) ON CONFLICT (wamid) DO NOTHING`,
          [m.id.slice(0, 200), from, names.get(from) || null, String(m.type ?? 'unknown').slice(0, 40), text, Number.isFinite(ts) && ts > 0 ? ts : Date.now() / 1000],
        );
        // Pedido de saida: bloqueia o numero e cancela o que estava na fila.
        if (inserted.rowCount && text && STOP_WORDS.has(text.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))) {
          await pool.query('INSERT INTO whatsapp_optouts (phone_hash) VALUES ($1) ON CONFLICT DO NOTHING', [phoneHash(from)]);
          await pool.query(`UPDATE whatsapp_messages SET status = 'canceled', error = 'Cliente pediu para não receber mais', updated_at = now() WHERE to_phone = $1 AND status = 'queued'`, [from]);
        }
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        if (typeof s?.id !== 'string' || !(s.status in STATUS_RANK)) continue;
        const err = Array.isArray(s.errors) && s.errors[0] ? String(s.errors[0].title ?? s.errors[0].message ?? s.errors[0].code ?? 'erro').slice(0, 500) : null;
        // Avisos chegam fora de ordem: a situacao so avanca (entregue nao volta para enviado).
        await pool.query(
          `UPDATE whatsapp_messages SET status = $2, error = coalesce($3, error), updated_at = now()
           WHERE wamid = $1 AND status <> 'canceled' AND (CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END) < $4`,
          [s.id, s.status, err, STATUS_RANK[s.status]],
        );
      }
    }
  }
}

export async function whatsappWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const limit = { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } };
  app.get('/', limit, async (req, reply) => {
    const ch = app.whatsapp?.verifyChallenge(req.query as Record<string, unknown>) ?? null;
    if (!ch) return reply.code(403).send();
    return reply.code(200).type('text/plain').send(ch);
  });
  app.post('/', limit, async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const sig = req.headers['x-hub-signature-256'];
    if (!app.whatsapp || !app.whatsapp.verifySignature(raw, typeof sig === 'string' ? sig : undefined)) return reply.code(401).send();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply.code(200).send(); // assinado mas ilegivel: nao adianta reenviar
    }
    await applyWebhook(body);
    return reply.code(200).send();
  });
}

// ---------------- painel ----------------

const phoneBody = z.strictObject({ phone: z.string().regex(/^\d{10,15}$/, 'Número inválido.') });

async function windowFor(phone: string) {
  const last = (await pool.query<{ at: Date | null }>('SELECT max(sent_at) AS at FROM whatsapp_inbound WHERE from_phone = $1', [phone])).rows[0]?.at ?? null;
  const until = last ? new Date(last.getTime() + WINDOW_MS) : null;
  return { lastInboundAt: last, windowOpenUntil: until && until.getTime() > Date.now() ? until : null };
}

export async function whatsappAdminRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'sales_desk.use');
    const templates = (await pool.query('SELECT event, name, language, active, updated_at FROM whatsapp_templates')).rows;
    const counts = (await pool.query(`SELECT status, count(*)::int AS n FROM whatsapp_messages WHERE created_at > now() - interval '30 days' GROUP BY status`)).rows;
    return {
      configured: Boolean(app.whatsapp),
      fake: Boolean(app.whatsapp?.fake),
      optinText: await currentOptinText(pool),
      events: WA_EVENTS.map((e) => ({ event: e, label: WA_EVENT_LABEL[e], template: templates.find((t) => t.event === e) ?? null })),
      counts,
    };
  });

  app.put('/templates/:event', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const { event } = z.object({ event: z.enum(WA_EVENTS) }).parse(req.params);
    const b = z
      .strictObject({
        name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Nome do modelo: letras minúsculas, números e _ (como no WhatsApp Manager).'),
        language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Idioma como pt_BR.').default('pt_BR'),
        active: z.boolean().default(true),
      })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT name, language, active FROM whatsapp_templates WHERE event = $1', [event])).rows[0] ?? null;
      await db.query(
        `INSERT INTO whatsapp_templates (event, name, language, active, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event) DO UPDATE SET name = EXCLUDED.name, language = EXCLUDED.language, active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [event, b.name, b.language, b.active, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'whatsapp.template', entity: 'whatsapp_template', before, after: { event, ...b }, ip: auth.ip });
      return { ok: true };
    });
  });

  /** Conversas dos ultimos 30 dias (recebidas e enviadas), mais recente primeiro. */
  app.get('/conversations', async (req) => {
    requirePermission(req, 'sales_desk.use');
    const { rows } = await pool.query(
      `WITH ev AS (
         SELECT from_phone AS phone, sent_at AS at, 'in' AS dir, body, profile_name FROM whatsapp_inbound WHERE sent_at > now() - interval '30 days'
         UNION ALL
         SELECT to_phone, created_at, 'out', coalesce(body, 'Modelo ' || template_name), NULL FROM whatsapp_messages WHERE created_at > now() - interval '30 days'
       ), last AS (SELECT DISTINCT ON (phone) phone, at, dir, body FROM ev ORDER BY phone, at DESC)
       SELECT l.phone, l.at AS last_at, l.dir AS last_dir, left(l.body, 120) AS last_body,
              (SELECT profile_name FROM whatsapp_inbound i WHERE i.from_phone = l.phone AND profile_name IS NOT NULL ORDER BY sent_at DESC LIMIT 1) AS name,
              (SELECT max(sent_at) FROM whatsapp_inbound i WHERE i.from_phone = l.phone) > now() - interval '24 hours' AS window_open
       FROM last l ORDER BY l.at DESC LIMIT 100`,
    );
    return { conversations: rows };
  });

  /** Mensagens de um numero (telefone no corpo, nao na URL). */
  app.post('/conversations/view', async (req) => {
    requirePermission(req, 'sales_desk.use');
    const { phone } = phoneBody.parse(req.body);
    const { rows } = await pool.query(
      `SELECT 'in' AS dir, wamid AS id, body, type, NULL AS status, NULL AS error, NULL AS event, NULL AS order_number, sent_at AS at FROM whatsapp_inbound WHERE from_phone = $1
       UNION ALL
       SELECT 'out', m.id::text, coalesce(m.body, 'Modelo ' || m.template_name), m.kind, m.status, m.error, m.event, o.number, m.created_at
       FROM whatsapp_messages m LEFT JOIN orders o ON o.id = m.order_id WHERE m.to_phone = $1
       ORDER BY at DESC LIMIT 200`,
      [phone],
    );
    const optedOut = Boolean((await pool.query('SELECT 1 FROM whatsapp_optouts WHERE phone_hash = $1', [phoneHash(phone)])).rows[0]);
    return { phone, messages: rows.reverse(), optedOut, ...(await windowFor(phone)) };
  });

  /** Resposta em texto livre: so dentro da janela de 24 h aberta pela ultima mensagem do cliente. */
  app.post('/conversations/reply', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requirePermission(req, 'sales_desk.use');
    const b = phoneBody.extend({ text: z.string().trim().min(1).max(4096) }).parse(req.body);
    const provider = app.whatsapp;
    if (!provider) throw new AppError(503, 'WHATSAPP_UNAVAILABLE', 'WhatsApp não configurado neste servidor.');
    if ((await pool.query('SELECT 1 FROM whatsapp_optouts WHERE phone_hash = $1', [phoneHash(b.phone)])).rows[0]) {
      throw new AppError(409, 'OPTED_OUT', 'O cliente pediu para não receber mensagens.');
    }
    const w = await windowFor(b.phone);
    if (!w.windowOpenUntil) throw new AppError(409, 'WINDOW_CLOSED', 'Passaram 24 h desde a última mensagem do cliente: só modelos aprovados podem ser enviados.');
    let wamid: string | null = null;
    let error: string | null = null;
    try {
      wamid = (await provider.sendText(b.phone, b.text)).wamid;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    await tx(auth.userId, async (db) => {
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO whatsapp_messages (kind, to_phone, body, status, wamid, error, attempts, created_by) VALUES ('text', $1, $2, $3, $4, $5, 1, $6) RETURNING id`,
          [b.phone, b.text, wamid ? 'sent' : 'failed', wamid, error, auth.userId],
        )
      ).rows[0]!.id;
      await audit(db, { actorId: auth.userId, action: 'whatsapp.reply', entity: 'whatsapp_message', entityId: id, metadata: { sent: Boolean(wamid) }, ip: auth.ip });
    });
    if (error) throw new AppError(502, 'WHATSAPP_SEND_FAILED', `Não foi enviada: ${error}`);
    return { ok: true };
  });
}
