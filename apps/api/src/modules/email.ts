// Painel -> E-mails (docs/EMAIL.md): caixas do dominio da loja (pelo script do servidor), envio (nome do remetente,
// Reply-To, textos dos e-mails automaticos, teste) e historico. Servidor, usuario e senha do SMTP ficam so no .env.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { AccountsRunner } from '../lib/email-accounts.js';
import { emailSettings, isTemplateKind, Mailer, missingRequired, renderTemplate, RESET_VALIDITY, resetLink, sendTemplate, TEMPLATES, unknownVariables, type TemplateKind } from '../lib/email.js';
import { AppError, notFound } from '../lib/errors.js';
import { passwordSchema, requirePermission, type ResetNotifier } from './auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer;
    emailAccounts: AccountsRunner | null;
  }
}

/** Recuperacao de senha do painel pelo e-mail. Nao lanca: falha de envio fica no log e no historico. */
export const resetNotifier =
  (app: FastifyInstance): ResetNotifier =>
  async (email, token) => {
    try {
      const name = (await pool.query<{ name: string }>('SELECT name FROM auth_find_user($1)', [email])).rows[0]?.name ?? '';
      await sendTemplate(app.mailer, 'password_reset', email, { nome: name.split(/\s+/)[0] ?? '', link: resetLink(token), validade: RESET_VALIDITY });
    } catch (err) {
      app.log.error({ err: (err as Error).message }, 'falha ao enviar a redefinicao de senha');
    }
  };

const ADDRESS = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const address = () =>
  z.string().trim().toLowerCase().max(254).regex(ADDRESS, 'Endereço inválido: use letras minúsculas, números, ponto, hífen ou sublinhado.').refine((v) => !v.includes('..'), 'Endereço inválido.');
const mailboxPassword = () => passwordSchema.refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'A senha não pode ter quebras de linha nem caracteres de controle.');
const plain = (max: number) => z.string().trim().max(max).refine((v) => !/[<>\r\n]/.test(v), 'Caracteres inválidos.');
const emailOrEmpty = () => z.union([z.literal(''), z.email().max(254)]);
const templateBody = z.strictObject({
  subject: z.string().trim().min(3).max(200).refine((v) => !/[\r\n]/.test(v), 'O assunto deve ter uma linha só.'),
  body: z.string().trim().min(10).max(5000),
});

function kindParam(req: FastifyRequest): TemplateKind {
  const { kind } = z.object({ kind: z.string() }).parse(req.params);
  if (!isTemplateKind(kind)) throw notFound();
  return kind;
}
function checkTemplate(kind: TemplateKind, d: { subject: string; body: string }) {
  const unknown = unknownVariables(kind, d.subject, d.body);
  if (unknown.length) throw new AppError(400, 'UNKNOWN_VARIABLE', `Variável desconhecida: ${unknown.map((v) => `{{${v}}}`).join(', ')}.`);
  const missing = missingRequired(kind, d.body);
  if (missing.length) throw new AppError(400, 'REQUIRED_VARIABLE', `O texto precisa conter ${missing.map((v) => `{{${v}}}`).join(', ')}.`);
}
const addressParam = (req: FastifyRequest) => address().parse(decodeURIComponent(z.object({ address: z.string().max(400) }).parse(req.params).address));

/** Dados para configurar a caixa num programa de e-mail (sem senha). */
const clientSetup = (protocols?: string[] | null) => ({
  server: config.SMTP_HOST ?? null,
  imap: { port: 993, security: 'SSL/TLS' },
  smtp: { port: 587, security: 'STARTTLS' },
  pop: protocols ? (protocols.includes('pop3') ? { port: 995, security: 'SSL/TLS' } : null) : undefined,
  webmail: config.EMAIL_WEBMAIL_URL ?? null,
});

export async function emailRoutes(app: FastifyInstance) {
  const hourly = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 hour' } } });
  const accounts = () => {
    if (!app.emailAccounts) throw new AppError(503, 'EMAIL_ACCOUNTS_OFF', 'A integração com o servidor de e-mail não está configurada (EMAIL_ACCOUNTS_SOCKET).');
    return app.emailAccounts;
  };
  /** Caixa que a loja usa para enviar: nao pode ser suspensa nem excluida pelo painel. */
  const isSender = (a: string) => a === app.mailer.fromAddress?.toLowerCase() || a === config.SMTP_USER?.toLowerCase();

  app.get('/', async (req) => {
    requirePermission(req, 'email.view');
    const s = await emailSettings();
    const m = app.mailer;
    return {
      smtp: {
        configured: m.configured,
        host: m.settings.host ?? null,
        port: m.settings.port,
        security: m.settings.secure ? 'TLS direto' : 'STARTTLS obrigatório',
        user: m.settings.user ?? null,
        passwordSet: Boolean(config.SMTP_PASS),
        from: m.settings.from ?? null,
      },
      settings: { senderName: s.sender_name ?? '', replyTo: s.reply_to ?? '' },
      templates: Object.entries(TEMPLATES).map(([kind, t]) => ({
        kind,
        label: t.label,
        description: t.description,
        variables: t.variables,
        required: t.required,
        subject: s.templates[kind]?.subject || t.subject,
        body: s.templates[kind]?.body || t.body,
        default: { subject: t.subject, body: t.body },
        customized: Boolean(s.templates[kind]),
      })),
      accountsIntegrated: Boolean(app.emailAccounts),
    };
  });

  // ---------------- Envio e modelos ----------------

  app.put('/settings', async (req) => {
    const auth = requirePermission(req, 'email.manage');
    const d = z.strictObject({ senderName: plain(80), replyTo: emailOrEmpty() }).parse(req.body);
    await tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT sender_name, reply_to FROM email_settings')).rows[0];
      await db.query('UPDATE email_settings SET sender_name = $1, reply_to = $2, updated_by = $3, updated_at = now()', [d.senderName || null, d.replyTo || null, auth.userId]);
      await audit(db, { actorId: auth.userId, action: 'email.settings_updated', entity: 'email_settings', before, after: { sender_name: d.senderName || null, reply_to: d.replyTo || null }, ip: req.ip });
    });
    return { ok: true };
  });

  app.put('/templates/:kind', async (req) => {
    const auth = requirePermission(req, 'email.manage');
    const kind = kindParam(req);
    const d = templateBody.parse(req.body);
    checkTemplate(kind, d);
    await tx(auth.userId, async (db) => {
      await db.query(`UPDATE email_settings SET templates = templates || jsonb_build_object($1::text, $2::jsonb), updated_by = $3, updated_at = now()`, [kind, JSON.stringify(d), auth.userId]);
      await audit(db, { actorId: auth.userId, action: 'email.template_updated', entity: 'email_template', entityId: kind, after: d, ip: req.ip });
    });
    return { ok: true };
  });

  app.delete('/templates/:kind', async (req) => {
    const auth = requirePermission(req, 'email.manage');
    const kind = kindParam(req);
    await tx(auth.userId, async (db) => {
      await db.query('UPDATE email_settings SET templates = templates - $1::text, updated_by = $2, updated_at = now()', [kind, auth.userId]);
      await audit(db, { actorId: auth.userId, action: 'email.template_restored', entity: 'email_template', entityId: kind, ip: req.ip });
    });
    return { ok: true };
  });

  // Previa com dados de exemplo (o link da previa nao e um token de verdade).
  app.post('/templates/:kind/preview', async (req) => {
    requirePermission(req, 'email.view');
    const kind = kindParam(req);
    const d = templateBody.parse(req.body);
    checkTemplate(kind, d);
    return renderTemplate(kind, TEMPLATES[kind].example(), d);
  });

  app.post('/verify', hourly(10), async (req) => {
    const auth = requirePermission(req, 'email.manage');
    const r = await app.mailer.verify();
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'email.connection_tested', metadata: { ok: r.ok }, ip: req.ip }));
    return r.ok ? { ok: true, message: `Conexão, STARTTLS e login aceitos por ${app.mailer.settings.host}.` } : { ok: false, message: r.reason };
  });

  // So para o e-mail de quem pediu: o teste nao serve para mandar mensagem a terceiros.
  app.post('/test', hourly(5), async (req) => {
    const auth = requirePermission(req, 'email.manage');
    const r = await sendTemplate(app.mailer, 'test', auth.email, {
      nome: auth.name.split(/\s+/)[0] ?? '',
      servidor: app.mailer.settings.host ?? '',
      data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    });
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'email.test_sent', metadata: { sent: r.sent }, ip: req.ip }));
    return r.sent ? { ok: true, message: `E-mail de teste enviado para ${auth.email}.` } : { ok: false, message: r.reason };
  });

  app.get('/sends', async (req) => {
    requirePermission(req, 'email.view');
    const q = z
      .object({ page: z.coerce.number().int().min(1).max(10_000).default(1), status: z.enum(['sent', 'failed', 'not_configured']).optional(), kind: z.string().regex(/^[a-z_]{2,40}$/).optional() })
      .parse(req.query);
    const where = 'WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)';
    const { rows } = await pool.query(
      `SELECT id, created_at, kind, to_domain, subject, status, error_code, error_detail FROM email_sends ${where} ORDER BY created_at DESC, id DESC LIMIT 30 OFFSET $3`,
      [q.status ?? null, q.kind ?? null, (q.page - 1) * 30],
    );
    return { sends: rows, page: q.page };
  });

  // ---------------- Caixas e apelidos ----------------

  app.get('/accounts', async (req) => {
    requirePermission(req, 'email.view');
    if (!app.emailAccounts) return { integrated: false, client: clientSetup() };
    try {
      const info = (await app.emailAccounts('info')) as {
        dominio: string;
        dominio_atendido: boolean;
        contas: { endereco: string; login: boolean; recebe: boolean; suspensa: boolean; uso_bytes: number }[];
        apelidos: { origem: string; destinos: string[] }[];
        protocolos: string[] | null;
      };
      const notes = new Map((await pool.query<{ address: string; name: string; note: string; created_at: Date }>('SELECT address, name, note, created_at FROM email_account_notes')).rows.map((r) => [r.address, r]));
      return {
        integrated: true,
        domain: info.dominio,
        domainServed: info.dominio_atendido,
        accounts: info.contas.map((c) => ({
          address: c.endereco,
          login: c.login,
          receives: c.recebe,
          suspended: c.suspensa,
          usageBytes: c.uso_bytes,
          sender: isSender(c.endereco),
          name: notes.get(c.endereco)?.name ?? '',
          note: notes.get(c.endereco)?.note ?? '',
          createdAt: notes.get(c.endereco)?.created_at ?? null,
        })),
        aliases: info.apelidos.map((a) => ({ address: a.origem, targets: a.destinos })),
        client: clientSetup(info.protocolos),
      };
    } catch (err) {
      // A tela continua util (envio, modelos, historico) mesmo com o script fora do ar.
      return { integrated: true, error: (err as Error).message, client: clientSetup() };
    }
  });

  app.post('/accounts', hourly(40), async (req, reply) => {
    const auth = requirePermission(req, 'email.accounts');
    const d = z.strictObject({ address: address(), name: plain(80), note: plain(200), password: mailboxPassword() }).parse(req.body);
    const r = (await accounts()('criar', { endereco: d.address, senha: d.password })) as { endereco: string };
    await tx(auth.userId, async (db) => {
      await db.query(
        `INSERT INTO email_account_notes (address, name, note, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now(), updated_at = now()`,
        [r.endereco, d.name, d.note, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'email.account_created', entity: 'email_account', entityId: r.endereco, after: { name: d.name }, ip: req.ip });
    });
    return reply.code(201).send({ ok: true, address: r.endereco, message: `Caixa ${r.endereco} criada. Entregue a senha à pessoa por um canal seguro: o painel não a guarda.` });
  });

  app.put('/accounts/:address', async (req) => {
    const auth = requirePermission(req, 'email.accounts');
    const target = addressParam(req);
    const d = z.strictObject({ name: plain(80), note: plain(200) }).parse(req.body);
    const info = (await accounts()('info')) as { contas: { endereco: string }[] };
    if (!info.contas.some((c) => c.endereco === target)) throw notFound();
    await tx(auth.userId, async (db) => {
      await db.query(
        `INSERT INTO email_account_notes (address, name, note, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, note = EXCLUDED.note, updated_at = now()`,
        [target, d.name, d.note, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'email.account_updated', entity: 'email_account', entityId: target, after: d, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/accounts/:address/password', hourly(40), async (req) => {
    const auth = requirePermission(req, 'email.accounts');
    const target = addressParam(req);
    const { password } = z.strictObject({ password: mailboxPassword() }).parse(req.body);
    await accounts()('senha', { endereco: target, senha: password });
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'email.account_password_changed', entity: 'email_account', entityId: target, ip: req.ip }));
    return { ok: true, message: 'Senha trocada. Programas de e-mail conectados vão pedir a senha nova.' };
  });

  for (const [path, action, auditAction] of [
    ['suspend', 'suspender', 'email.account_suspended'],
    ['reactivate', 'reativar', 'email.account_reactivated'],
  ] as const) {
    app.post(`/accounts/:address/${path}`, hourly(40), async (req) => {
      const auth = requirePermission(req, 'email.accounts');
      const target = addressParam(req);
      if (path === 'suspend' && isSender(target)) throw new AppError(400, 'SENDER_ACCOUNT', 'Esta é a caixa que a loja usa para enviar e-mails (SMTP_USER). Suspendê-la interrompe a recuperação de senha.');
      await accounts()(action, { endereco: target });
      await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: auditAction, entity: 'email_account', entityId: target, ip: req.ip }));
      return { ok: true };
    });
  }

  app.delete('/accounts/:address', hourly(40), async (req) => {
    const auth = requirePermission(req, 'email.accounts');
    const target = addressParam(req);
    if (isSender(target)) throw new AppError(400, 'SENDER_ACCOUNT', 'Esta é a caixa que a loja usa para enviar e-mails. Troque SMTP_USER/MAIL_FROM no .env antes de excluí-la.');
    const r = (await accounts()('excluir', { endereco: target })) as { mensagens_arquivadas_em: string | null };
    await tx(auth.userId, async (db) => {
      await db.query('DELETE FROM email_account_notes WHERE address = $1', [target]);
      await audit(db, { actorId: auth.userId, action: 'email.account_deleted', entity: 'email_account', entityId: target, metadata: { archived: Boolean(r.mensagens_arquivadas_em) }, ip: req.ip });
    });
    return {
      ok: true,
      message: r.mensagens_arquivadas_em ? `Caixa excluída. As mensagens foram guardadas no servidor em ${r.mensagens_arquivadas_em}.` : 'Caixa excluída (não havia mensagens guardadas).',
    };
  });

  const targets = z.preprocess(
    (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean),
    z.array(z.email('Destino inválido.').max(254).transform((s) => s.toLowerCase())).min(1, 'Informe ao menos um destino.').max(10),
  );

  app.post('/aliases', hourly(40), async (req, reply) => {
    const auth = requirePermission(req, 'email.accounts');
    const d = z.strictObject({ address: address(), targets }).parse(req.body);
    const r = (await accounts()('apelido', { origem: d.address, destinos: d.targets, novo: true })) as { origem: string; destinos: string[] };
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'email.alias_created', entity: 'email_alias', entityId: r.origem, after: { targets: r.destinos }, ip: req.ip }));
    return reply.code(201).send({ ok: true, address: r.origem, targets: r.destinos });
  });

  app.put('/aliases/:address', hourly(40), async (req) => {
    const auth = requirePermission(req, 'email.accounts');
    const origin = addressParam(req);
    const d = z.strictObject({ targets }).parse(req.body);
    const r = (await accounts()('apelido', { origem: origin, destinos: d.targets, novo: false })) as { origem: string; destinos: string[] };
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'email.alias_updated', entity: 'email_alias', entityId: origin, after: { targets: r.destinos }, ip: req.ip }));
    return { ok: true, address: r.origem, targets: r.destinos };
  });

  app.delete('/aliases/:address', hourly(40), async (req) => {
    const auth = requirePermission(req, 'email.accounts');
    const origin = addressParam(req);
    await accounts()('excluir_apelido', { origem: origin });
    await tx(auth.userId, (db) => audit(db, { actorId: auth.userId, action: 'email.alias_deleted', entity: 'email_alias', entityId: origin, ip: req.ip }));
    return { ok: true };
  });
}
