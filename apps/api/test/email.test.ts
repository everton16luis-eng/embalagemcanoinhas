import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { commandRunner } from '../src/lib/email-accounts.js';
import type { MailMessage, MailTransport } from '../src/lib/email.js';
import { buildApp } from '../src/app.js';
import { appRole, client, createUser, loggedAs, owner, PASSWORD } from './helpers.js';

const E = '/api/v1/admin/email';
const DOMAIN = 'loja.teste.localhost';
const OTHER = 'portal.teste.localhost';

// Transporte simulado: guarda as mensagens, nunca abre conexao.
const outbox: MailMessage[] = [];
let failNext = false;
const transport: MailTransport = {
  async sendMail(m) {
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('550 mailbox unavailable for fulano@exemplo.com'), { code: 'EENVELOPE', responseCode: 550 });
    }
    outbox.push(m);
    return { messageId: `<${outbox.length}@teste>` };
  },
  async verify() {
    return true;
  },
};
const mailSettings = { host: 'smtp.teste.localhost', port: 587, secure: false, user: `nao-responda@${DOMAIN}`, from: `Loja de Teste <nao-responda@${DOMAIN}>` };

// Script do servidor rodando numa pasta temporaria (precisa de Python 3 e openssl; no Windows, o openssl do Git).
const python = process.platform === 'win32' ? 'python' : 'python3';
const opensslWin = 'C:/Program Files/Git/mingw64/bin/openssl.exe';
if (process.platform === 'win32' && fs.existsSync(opensslWin)) process.env.LOJA_CONTAS_OPENSSL = opensslWin;
const hasScript = spawnSync(python, ['--version']).status === 0 && spawnSync(process.env.LOJA_CONTAS_OPENSSL || 'openssl', ['version']).status === 0;
const script = path.resolve(import.meta.dirname, '../../../deploy/email/loja-contas-email.py');
let root: string;
const file = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let app: FastifyInstance;
let offApp: FastifyInstance;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loja-contas-email-'));
  for (const d of ['etc/dovecot', 'etc/postfix', `var/mail/vhosts/${OTHER}/contato/cur`, `var/mail/vhosts/${DOMAIN}/nao-responda/cur`]) fs.mkdirSync(path.join(root, d), { recursive: true });
  // Servidor compartilhado: o dominio do portal ja existe e nao pode aparecer nem ser alterado pela loja.
  fs.writeFileSync(path.join(root, 'etc/dovecot/users'), `contato@${OTHER}:{SHA512-CRYPT}$6$sal$hashportal\nnao-responda@${DOMAIN}:{SHA512-CRYPT}$6$sal$hashloja\n`);
  fs.writeFileSync(path.join(root, 'etc/postfix/virtual_domains'), `${OTHER} OK\n${DOMAIN} OK\n`);
  fs.writeFileSync(path.join(root, 'etc/postfix/virtual_mailboxes'), `contato@${OTHER} ${OTHER}/contato/\nnao-responda@${DOMAIN} ${DOMAIN}/nao-responda/\n`);
  fs.writeFileSync(path.join(root, 'etc/postfix/virtual_aliases'), `abuse@${OTHER} contato@${OTHER}\n`);
  app = await buildApp({
    notifier: undefined,
    payments: null,
    fiscal: null,
    marketplaces: { mercadolivre: null, shopee: null },
    whatsapp: null,
    carrier: null,
    mailTransport: transport,
    mailSettings,
    emailAccounts: hasScript ? commandRunner(python, [script, '--raiz', root, '--sem-postmap', '--dominio', DOMAIN]) : null,
  });
  offApp = await buildApp({ payments: null, fiscal: null, marketplaces: { mercadolivre: null, shopee: null }, whatsapp: null, carrier: null, mailTransport: null, emailAccounts: null });
});
afterAll(async () => {
  await app.close();
  await offApp.close();
  await owner.query(`UPDATE email_settings SET sender_name = NULL, reply_to = NULL, templates = '{}'`);
  await owner.query('DELETE FROM email_account_notes');
  fs.rmSync(root, { recursive: true, force: true });
  await pool.end();
  await owner.end();
  await appRole.end();
});

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('recuperação de senha do painel por e-mail', () => {
  it('envia o link pelo SMTP; o link redefine a senha; o histórico guarda só o domínio', async () => {
    const user = await createUser('sales');
    const before = outbox.length;
    const res = await client(app).post('/api/v1/auth/password/forgot', { email: user.email });
    expect(res.statusCode).toBe(202);
    await waitFor(() => outbox.length > before);
    const msg = outbox.at(-1)!;
    expect(msg.to).toBe(user.email);
    expect(msg.from).toBe(mailSettings.from);
    const token = msg.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(msg.text).toContain('30 minutos');
    const reset = await client(app).post('/api/v1/auth/password/reset', { token, newPassword: 'Outra-senha-forte-1' });
    expect(reset.statusCode).toBe(200);
    const sent = (await owner.query(`SELECT * FROM email_sends WHERE kind = 'password_reset' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(sent).toMatchObject({ status: 'sent', to_domain: '***@teste.local' });
    expect(JSON.stringify(sent)).not.toContain(token!);
  });

  it('e-mail que não existe: mesma resposta e nada enviado', async () => {
    const before = outbox.length;
    const res = await client(app).post('/api/v1/auth/password/forgot', { email: 'ninguem-aqui@teste.local' });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 150));
    expect(outbox.length).toBe(before);
  });

  it('sem SMTP: resposta igual, envio registrado como não configurado', async () => {
    const user = await createUser('sales');
    expect((await client(offApp).post('/api/v1/auth/password/forgot', { email: user.email })).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 150));
    const last = (await owner.query(`SELECT status FROM email_sends ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(last.status).toBe('not_configured');
  });

  it('falha do servidor fica no histórico sem o endereço do destinatário', async () => {
    const user = await createUser('sales');
    failNext = true;
    await client(app).post('/api/v1/auth/password/forgot', { email: user.email });
    await new Promise((r) => setTimeout(r, 200));
    const last = (await owner.query(`SELECT status, error_code, error_detail FROM email_sends ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(last).toMatchObject({ status: 'failed', error_code: '550' });
    expect(last.error_detail).toContain('***@exemplo.com');
    expect(last.error_detail).not.toContain('fulano');
  });
});

describe('envio e modelos', () => {
  it('quem não gerencia e-mail não altera nada; gerenciar exige verificação em duas etapas', async () => {
    const sales = await loggedAs(app, 'sales');
    expect((await sales.get(E)).statusCode).toBe(403);
    const manager = await loggedAs(app, 'manager');
    expect((await manager.get(E)).statusCode).toBe(200);
    expect((await manager.put(`${E}/settings`, { senderName: 'X', replyTo: '' })).statusCode).toBe(403);
    const ownerNoMfa = await loggedAs(app, 'owner');
    expect((await ownerNoMfa.put(`${E}/settings`, { senderName: 'X', replyTo: '' })).json().error.code).toBe('MFA_REQUIRED');
  });

  it('modelo: recusa variável desconhecida e falta do link; salva, mostra prévia e restaura o padrão', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const k = `${E}/templates/password_reset`;
    expect((await boss.put(k, { subject: 'Senha {{loja}}', body: 'Olá {{nome}} {{senha}} {{link}}' })).json().error.code).toBe('UNKNOWN_VARIABLE');
    expect((await boss.put(k, { subject: 'Senha {{loja}}', body: 'Olá {{nome}}, sem link aqui.' })).json().error.code).toBe('REQUIRED_VARIABLE');
    expect((await boss.put(k, { subject: 'Nova senha — {{loja}}', body: 'Oi {{nome}}!\nLink: {{link}}' })).statusCode).toBe(200);
    expect((await boss.put(`${E}/settings`, { senderName: 'Embalagens Teste', replyTo: 'contato@loja.teste.localhost' })).statusCode).toBe(200);

    const preview = (await boss.post(`${k}/preview`, { subject: 'Nova senha — {{loja}}', body: 'Oi {{nome}}!\nLink: {{link}}' })).json();
    expect(preview.text).toContain('EXEMPLO-SEM-VALIDADE');

    const user = await createUser('sales');
    const before = outbox.length;
    await client(app).post('/api/v1/auth/password/forgot', { email: user.email });
    await waitFor(() => outbox.length > before);
    const msg = outbox.at(-1)!;
    expect(msg.subject.startsWith('Nova senha — ')).toBe(true);
    expect(msg.from).toEqual({ name: 'Embalagens Teste', address: `nao-responda@${DOMAIN}` });
    expect(msg.replyTo).toBe('contato@loja.teste.localhost');

    expect((await boss.del(k)).statusCode).toBe(200);
    const tpl = (await boss.get(E)).json().templates.find((t: { kind: string }) => t.kind === 'password_reset');
    expect(tpl.customized).toBe(false);
    const actions = (await owner.query(`SELECT action FROM audit_logs WHERE actor_id = $1`, [boss.user.id])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['email.template_updated', 'email.settings_updated', 'email.template_restored']));
  });

  it('teste de envio vai só para quem pediu; verificação confere a conexão', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const res = (await boss.post(`${E}/test`)).json();
    expect(res.ok).toBe(true);
    expect(outbox.at(-1)!.to).toBe(boss.user.email);
    expect((await boss.post(`${E}/verify`)).json().ok).toBe(true);
    const hist = (await boss.get(`${E}/sends?kind=test`)).json().sends;
    expect(hist[0]).toMatchObject({ kind: 'test', status: 'sent' });
    expect(hist[0].to_domain).toBe('***@teste.local');
  });

  it('o histórico de envios não pode ser alterado nem apagado', async () => {
    await expect(appRole.query('DELETE FROM email_sends')).rejects.toThrow();
    await expect(appRole.query(`UPDATE email_sends SET status = 'sent'`)).rejects.toThrow();
  });
});

describe('caixas de e-mail pelo script do servidor', () => {
  it('sem a integração, a tela explica e não cria nada', async () => {
    const boss = await loggedAs(offApp, 'owner', { mfa: true });
    expect((await boss.get(`${E}/accounts`)).json().integrated).toBe(false);
    expect((await boss.post(`${E}/accounts`, { address: `fulano@${DOMAIN}`, name: '', note: '', password: PASSWORD })).statusCode).toBe(503);
  });

  it.skipIf(!hasScript)('mostra só o domínio da loja; cria, troca senha, suspende, apelida e exclui; nunca toca no outro domínio', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const info = (await boss.get(`${E}/accounts`)).json();
    expect(info).toMatchObject({ integrated: true, domain: DOMAIN, domainServed: true });
    expect(info.accounts.map((a: { address: string }) => a.address)).toEqual([`nao-responda@${DOMAIN}`]);
    expect(info.accounts[0].sender).toBe(true);
    expect(info.aliases).toEqual([]);

    // Outro dominio do servidor: recusado em todas as acoes.
    const portalUsers = file('etc/dovecot/users');
    expect((await boss.post(`${E}/accounts`, { address: `novo@${OTHER}`, name: '', note: '', password: PASSWORD })).json().error.message).toContain(`@${DOMAIN}`);
    expect((await boss.post(`${E}/accounts/${encodeURIComponent(`contato@${OTHER}`)}/password`, { password: 'Outra-senha-forte-1' })).statusCode).toBe(400);
    expect((await boss.post(`${E}/accounts/${encodeURIComponent(`contato@${OTHER}`)}/suspend`)).statusCode).toBe(400);
    expect((await boss.del(`${E}/accounts/${encodeURIComponent(`contato@${OTHER}`)}`)).statusCode).toBe(400);
    expect((await boss.del(`${E}/aliases/${encodeURIComponent(`abuse@${OTHER}`)}`)).statusCode).toBe(400);
    expect(file('etc/dovecot/users')).toBe(portalUsers);
    expect(file('etc/postfix/virtual_aliases')).toContain(`abuse@${OTHER}`);

    // Caixa nova: a senha vira hash e nao aparece em lugar nenhum.
    const created = await boss.post(`${E}/accounts`, { address: `Vendas@${DOMAIN}`, name: 'Vendas', note: 'Atendimento', password: 'Senha-da-caixa-123' });
    expect(created.statusCode).toBe(201);
    expect(file('etc/dovecot/users')).toMatch(new RegExp(`^vendas@${DOMAIN.replace(/\./g, '\\.')}:\\{SHA512-CRYPT\\}\\$6\\$`, 'm'));
    expect(file('etc/dovecot/users')).not.toContain('Senha-da-caixa-123');
    expect(file('etc/postfix/virtual_mailboxes')).toContain(`vendas@${DOMAIN} ${DOMAIN}/vendas/`);
    expect(fs.existsSync(path.join(root, 'etc/dovecot/users.loja-bak'))).toBe(true);
    const audits = (await owner.query(`SELECT action, after, metadata FROM audit_logs WHERE actor_id = $1`, [boss.user.id])).rows;
    expect(JSON.stringify(audits)).not.toContain('Senha-da-caixa-123');

    const v = encodeURIComponent(`vendas@${DOMAIN}`);
    const hash1 = file('etc/dovecot/users');
    expect((await boss.post(`${E}/accounts/${v}/password`, { password: 'Senha-nova-da-caixa-9' })).statusCode).toBe(200);
    expect(file('etc/dovecot/users')).not.toBe(hash1);
    expect((await boss.post(`${E}/accounts/${v}/suspend`)).statusCode).toBe(200);
    expect(file('etc/dovecot/users')).toContain('nologin=y');
    expect((await boss.post(`${E}/accounts/${v}/reactivate`)).statusCode).toBe(200);
    expect(file('etc/dovecot/users')).not.toContain('nologin=y');

    // Caixa que envia: protegida.
    const sender = encodeURIComponent(`nao-responda@${DOMAIN}`);
    expect((await boss.post(`${E}/accounts/${sender}/suspend`)).json().error.code).toBe('SENDER_ACCOUNT');
    expect((await boss.del(`${E}/accounts/${sender}`)).json().error.code).toBe('SENDER_ACCOUNT');

    // Apelido para a caixa e para fora (ex.: Gmail).
    expect((await boss.post(`${E}/aliases`, { address: `contato@${DOMAIN}`, targets: `vendas@${DOMAIN}, dono@gmail.com` })).statusCode).toBe(201);
    expect(file('etc/postfix/virtual_aliases')).toContain(`contato@${DOMAIN} vendas@${DOMAIN}, dono@gmail.com`);
    expect((await boss.del(`${E}/accounts/${v}`)).json().error.message).toContain(`contato@${DOMAIN}`);
    expect((await boss.put(`${E}/aliases/${encodeURIComponent(`contato@${DOMAIN}`)}`, { targets: ['dono@gmail.com'] })).statusCode).toBe(200);

    const list = (await boss.get(`${E}/accounts`)).json();
    expect(list.accounts.find((a: { address: string }) => a.address === `vendas@${DOMAIN}`)).toMatchObject({ name: 'Vendas', note: 'Atendimento' });
    expect(list.aliases).toEqual([{ address: `contato@${DOMAIN}`, targets: ['dono@gmail.com'] }]);

    // Excluir guarda as mensagens.
    fs.mkdirSync(path.join(root, `var/mail/vhosts/${DOMAIN}/vendas/cur`), { recursive: true });
    fs.writeFileSync(path.join(root, `var/mail/vhosts/${DOMAIN}/vendas/cur/1`), 'mensagem');
    expect((await boss.del(`${E}/accounts/${v}`)).json().message).toContain('guardadas');
    expect(fs.readdirSync(path.join(root, `var/mail/vhosts-excluidas/${DOMAIN}`)).some((n) => n.startsWith('vendas-'))).toBe(true);
    expect(file('etc/dovecot/users')).not.toContain(`vendas@${DOMAIN}`);
    expect(file('etc/dovecot/users')).toContain(`contato@${OTHER}`);
  });

  it.skipIf(!hasScript)('senha fraca da caixa é recusada antes de chegar ao servidor; só quem tem a permissão mexe', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    expect((await boss.post(`${E}/accounts`, { address: `x@${DOMAIN}`, name: '', note: '', password: 'curta' })).statusCode).toBe(400);
    const manager = await loggedAs(app, 'manager', { mfa: true });
    expect((await manager.get(`${E}/accounts`)).statusCode).toBe(200);
    expect((await manager.post(`${E}/accounts`, { address: `x@${DOMAIN}`, name: '', note: '', password: 'Senha-da-caixa-123' })).statusCode).toBe(403);
  });
});
