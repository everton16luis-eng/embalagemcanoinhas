/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FakeProvider } from '../src/lib/payments.js';
import { FakeTypebot, HttpTypebot, markdownToWhatsApp, TypebotSessionGone } from '../src/lib/typebot.js';
import { FakeWhatsApp } from '../src/lib/whatsapp.js';
import { botTick } from '../src/modules/bot.js';
import { appRole, loggedAs, makeApp, owner, resetCatalog, uid } from './helpers.js';

/** Etapa 3 do bot: forma Typebot com o simulador. Nenhum teste chama um Typebot real. */

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
const wa = new FakeWhatsApp();
const tb = new FakeTypebot();
const PHONE = '5547988887777';

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', FakeWhatsApp.SECRET).update(raw).digest('hex')}` },
    payload: raw,
  });
};
const wrap = (message: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '1' },
            contacts: [{ wa_id: PHONE, profile: { name: 'Maria Confeiteira' } }],
            messages: [{ from: PHONE, id: `wamid.${uid()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
          },
        },
      ],
    },
  ],
});
async function send(message: Record<string, unknown>) {
  expect((await signed(wrap(message))).statusCode).toBe(200);
  await botTick(wa);
}
const sayText = (text: string) => send({ type: 'text', text: { body: text } });
const tap = (id: string, title: string) => send({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const botMessages = async () => (await owner.query(`SELECT kind, body, payload FROM whatsapp_messages WHERE source = 'bot' AND to_phone = $1 ORDER BY created_at, id`, [PHONE])).rows;
async function setBot(settings: Record<string, unknown>) {
  const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: {}, texts: {}, ...settings });
  expect(r.statusCode, r.body).toBe(200);
}

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { whatsapp: wa, typebot: tb });
  await resetCatalog();
  boss = await loggedAs(app, 'owner', { mfa: true });
});
beforeEach(async () => {
  await owner.query('TRUNCATE bot_runs, bot_pending_documents, bot_verify_failures, bot_test_sessions, whatsapp_conversations, whatsapp_optouts, whatsapp_inbound, whatsapp_messages');
  await owner.query(`UPDATE bot_settings SET audience = 'off', mode = 'menu', typebot_public_id = NULL, test_phones = '{}', hours = '{}', texts = '{}'`);
  tb.calls = [];
  tb.failNext = false;
  tb.sessions.clear();
});
afterAll(async () => {
  await owner.query(`UPDATE bot_settings SET audience = 'off', mode = 'menu', typebot_public_id = NULL`);
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('adaptador do Typebot', () => {
  it('chama startChat e continueChat da documentação e lê textos e opções', async () => {
    const seen: any[] = [];
    const replies = [
      {
        status: 200,
        body: {
          sessionId: 's1',
          messages: [
            { id: 'm1', type: 'text', content: { type: 'markdown', markdown: 'Olá **Maria**! Veja [a loja](https://loja.test).' } },
            { id: 'm2', type: 'image', content: { url: 'https://img.test/a.png' } },
          ],
          input: { id: 'i1', type: 'choice input', items: [{ id: 'a', content: 'Produtos' }, { id: 'b', content: 'Atendente', value: 'atendente' }, { id: 'c', content: '  ' }] },
        },
      },
      { status: 200, body: { messages: [{ id: 'm3', type: 'text', content: { type: 'markdown', markdown: 'Fim.' } }] } },
      { status: 404, body: { message: 'Session not found' } },
    ];
    const http = new HttpTypebot('http://127.0.0.1:3092/api/', async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      const r = replies.shift()!;
      return { status: r.status, text: async () => JSON.stringify(r.body) };
    });
    const t1 = await http.start('fluxo-loja', { nome: 'Maria' });
    expect(seen[0]).toEqual({ url: 'http://127.0.0.1:3092/api/v1/typebots/fluxo-loja/startChat', body: { prefilledVariables: { nome: 'Maria' }, textBubbleContentFormat: 'markdown' } });
    expect(t1).toEqual({
      sessionId: 's1',
      texts: ['Olá *Maria*! Veja a loja: https://loja.test.', 'https://img.test/a.png'],
      choices: [
        { id: 'a', content: 'Produtos', value: null },
        { id: 'b', content: 'Atendente', value: 'atendente' },
      ],
      ended: false,
    });
    const t2 = await http.continue('s1', 'Produtos');
    expect(seen[1]).toEqual({ url: 'http://127.0.0.1:3092/api/v1/sessions/s1/continueChat', body: { message: { type: 'text', text: 'Produtos' }, textBubbleContentFormat: 'markdown' } });
    expect(t2).toEqual({ sessionId: 's1', texts: ['Fim.'], choices: null, ended: true });
    await expect(http.continue('s1', 'oi')).rejects.toBeInstanceOf(TypebotSessionGone);
  });

  it('markdown vira formatação do WhatsApp', () => {
    expect(markdownToWhatsApp('**negrito**, *itálico*, ~~riscado~~\n## Título')).toBe('*negrito*, _itálico_, ~riscado~\nTítulo');
  });
});

describe('forma Typebot no WhatsApp', () => {
  it('precisa do ID do fluxo', async () => {
    const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: {}, texts: {}, mode: 'typebot' });
    expect(r.statusCode).toBe(400);
    expect((await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [], hours: {}, texts: {}, mode: 'typebot', typebotPublicId: 'x y' })).statusCode).toBe(400);
  });

  it('fluxo com botões, texto livre e fim; o nome vai como variável', async () => {
    await setBot({ mode: 'typebot', typebotPublicId: 'fluxo-loja' });
    await sayText('oi');
    expect(tb.calls[0]).toEqual({ op: 'start', arg: 'fluxo-loja', extra: { nome: 'Maria' } });
    let msgs = await botMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('interactive');
    expect(msgs[0].payload).toEqual({
      type: 'button',
      body: 'Olá, Maria! Fluxo simulado do Typebot.',
      buttons: [
        { id: 'tb:c1', title: 'Ver produtos' },
        { id: 'tb:c2', title: 'Acompanhar pedido' },
        { id: 'tb:c3', title: 'Falar com atendente' },
      ],
    });

    await tap('tb:c1', 'Ver produtos');
    expect(tb.calls[1]).toEqual({ op: 'continue', arg: 'sessao-1', extra: 'Ver produtos' });
    await sayText('copo 300 ml');
    msgs = await botMessages();
    expect(msgs.at(-1).body).toBe('Anotado: copo 300 ml. Veja na loja *virtual*.');
    // Fluxo acabou: a proxima mensagem comeca de novo.
    await sayText('oi de novo');
    expect(tb.calls.at(-1)).toMatchObject({ op: 'start' });
  });

  it('valores reservados chamam a loja: pedido (com CPF fora do Typebot) e atendente', async () => {
    await setBot({ mode: 'typebot', typebotPublicId: 'fluxo-loja' });
    await sayText('oi');
    await tap('tb:c2', 'Acompanhar pedido');
    expect((await botMessages()).at(-1).body).toBe('Digite o número do pedido.');
    await sayText('123456');
    expect((await botMessages()).at(-1).body).toContain('CPF ou CNPJ');
    await sayText('52998224725');
    // O Typebot so recebeu o inicio.
    expect(tb.calls).toHaveLength(1);
    expect(JSON.stringify(tb.calls)).not.toContain('52998224725');

    await sayText('oi');
    await tap('tb:c3', 'Falar com atendente');
    expect((await owner.query('SELECT state FROM whatsapp_conversations WHERE phone = $1', [PHONE])).rows[0].state).toBe('agent');
  });

  it('sessão perdida recomeça; Typebot fora do ar cai no menu', async () => {
    await setBot({ mode: 'typebot', typebotPublicId: 'fluxo-loja' });
    await sayText('oi');
    tb.sessions.clear();
    await tap('tb:c1', 'Ver produtos');
    expect(tb.calls.map((c) => c.op)).toEqual(['start', 'continue', 'start']);

    tb.failNext = true;
    await sayText('qualquer coisa');
    const last = (await botMessages()).at(-1);
    expect(last.kind).toBe('interactive');
    expect(last.payload.type).toBe('list'); // menu da loja
  });

  it('chat de teste usa o fluxo; o painel mostra a configuração', async () => {
    await setBot({ audience: 'off', mode: 'typebot', typebotPublicId: 'fluxo-loja' });
    const r = (await boss.post('/api/v1/admin/whatsapp/bot/test', { text: 'oi' })).json();
    expect(r.replies[0].i.buttons[0]).toEqual({ id: 'tb:c1', title: 'Ver produtos' });
    const r2 = (await boss.post('/api/v1/admin/whatsapp/bot/test', { replyId: 'tb:c1' })).json();
    expect(r2.replies).toEqual([{ kind: 'text', body: 'Qual produto você procura?' }]);
    const g = (await boss.get('/api/v1/admin/whatsapp/bot')).json();
    expect(g.settings).toMatchObject({ mode: 'typebot', typebotPublicId: 'fluxo-loja' });
    expect(g.typebot).toEqual({ configured: true, simulated: true });
  });
});
