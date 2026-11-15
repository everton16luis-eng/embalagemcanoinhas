/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { FakeAi, type AiPart } from '../src/lib/gemini.js';
import { FakeProvider } from '../src/lib/payments.js';
import { FakeWhatsApp } from '../src/lib/whatsapp.js';
import { botTick } from '../src/modules/bot.js';
import { appRole, loggedAs, makeApp, owner, resetCatalog, uid } from './helpers.js';

/**
 * Continuidade da conversa com a IA no WhatsApp: o cenário real em que, depois de uma recomendação com links,
 * a resposta do cliente ("Vai ser uns 40 convidados") recebia o menu com "Não entendi".
 */

let app: FastifyInstance;
let boss: Awaited<ReturnType<typeof loggedAs>>;
const wa = new FakeWhatsApp();
let ai = new FakeAi();
const PHONE = '5547988881111';
const link = (slug: string) => `${config.APP_ORIGIN}/p/${slug}`;

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', FakeWhatsApp.SECRET).update(raw).digest('hex')}` },
    payload: raw,
  });
};
const hook = (text: string, wamid = `wamid.${uid()}`) => ({
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
            contacts: [{ wa_id: PHONE, profile: { name: 'Ana' } }],
            messages: [{ from: PHONE, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});
async function client(text: string) {
  expect((await signed(hook(text))).statusCode).toBe(200);
  await botTick(wa);
}
const botMessages = async () => (await owner.query(`SELECT kind, body FROM whatsapp_messages WHERE source = 'bot' AND to_phone = $1 ORDER BY created_at, id`, [PHONE])).rows;
const lastBot = async () => (await botMessages()).at(-1);
const routes = async () => (await owner.query(`SELECT r.route FROM bot_runs r JOIN whatsapp_inbound i ON i.id = r.inbound_id WHERE i.from_phone = $1 ORDER BY i.id`, [PHONE])).rows.map((r) => r.route);
const conversation = async () => (await owner.query('SELECT state, step FROM whatsapp_conversations WHERE phone = $1', [PHONE])).rows[0];

const call = (name: string, args: Record<string, unknown>) => ({ parts: [{ functionCall: { name, args }, thoughtSignature: `sig-${name}` }] as AiPart[], inputTokens: 1000, outputTokens: 50 });
const answer = (text: string) => ({ parts: [{ text }] as AiPart[], inputTokens: 1200, outputTokens: 120 });
/** Uma resposta do consultor como na loja: 3 buscas e a recomendação (4 chamadas à API). */
const consultant = (text: string, terms: string[]) => [...terms.map((t) => call('buscar_produtos', { termo: t })), answer(text)];
/** Texto da última mensagem do cliente e do histórico mandados ao Google na chamada mais recente. */
const lastRequest = () => ai.requests.at(-1)!;
const contentsText = (req = lastRequest()) => req.contents.map((c) => `${c.role}: ${c.parts.map((p: any) => p.text ?? '').join('')}`);

const RECOMMENDATION = [
  'Para refrigerante, indico o copo de 300 ml, que serve bem uma dose. Pacote com 100 por R$ 12,90, em estoque.',
  link('copo-300-ml'),
  'Alternativa mais econômica: copo de 200 ml, pacote com 100 por R$ 9,90, em estoque.',
  link('copo-200-ml'),
  'Quantos convidados estarão na festa?',
].join('\n');

beforeAll(async () => {
  app = await makeApp(undefined, new FakeProvider(), null, undefined, { whatsapp: wa, ai });
  await resetCatalog();
  boss = await loggedAs(app, 'owner', { mfa: true });
  await owner.query(`UPDATE store_settings SET store_name = 'Loja Teste'`);
});
beforeEach(async () => {
  await owner.query('TRUNCATE ai_calls, bot_security_events, bot_runs, bot_pending_documents, bot_verify_failures, bot_test_sessions, whatsapp_conversations, whatsapp_optouts, whatsapp_inbound, whatsapp_messages');
  const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [PHONE], hours: {}, texts: {}, mode: 'ai', aiPlan: 'free', aiMonthlyLimitUsd: 10, aiDailyPerPhone: 20 });
  expect(r.statusCode, r.body).toBe(200);
  ai.requests = [];
  ai.script = [];
  ai.failNext = false;
  ai.failCount = 0;
});
afterAll(async () => {
  await owner.query(`UPDATE bot_settings SET audience = 'off', mode = 'menu', ai_plan = 'free', test_phones = '{}'`);
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

/** O cenário real até a pergunta dos convidados: 4 mensagens, 10 chamadas à API em menos de 5 minutos. */
async function upToGuestsQuestion() {
  ai.script = [answer('Olá! Tudo bem? Como posso te ajudar hoje com embalagens, descartáveis ou artigos para festa?')];
  await client('Oi.');
  ai.script = [...consultant('Para ajudar a escolher o copo ideal, qual bebida será servida?', ['copo descartável', 'copo festa', 'copo plástico']).slice(1)];
  await client('Quero comprar copos para uma festinha de 15 anos.');
  ai.script = consultant(RECOMMENDATION, ['copo 300 ml', 'copo 200 ml', 'copo refrigerante']);
  await client('Vai ser só refrigerante.');
  expect((await lastBot()).body).toBe(RECOMMENDATION);
}

describe('continuidade da conversa com a IA', () => {
  it('1 continuidade após link: "Vai ser uns 40 convidados" continua com a IA, sem menu (cenário real)', async () => {
    await upToGuestsQuestion();
    // Antes da correção a rajada contava chamadas (12 em 5 min): aqui já seriam 10 e a próxima resposta estouraria.
    ai.script = consultant('Para 40 convidados, calculando 3 copos por pessoa, são 120 copos: 2 pacotes do copo de 300 ml.', ['copo 300 ml', 'copo 300 ml pacote', 'copo descartável']);
    await client('Vai ser uns 40 convidados, eu acho.');
    const last = await lastBot();
    expect(last.kind).toBe('text');
    expect(last.body).toContain('40 convidados');
    expect(last.body).not.toContain('Não entendi');
    // A IA recebeu a recomendação inteira (com os dois links) e a pergunta pendente no histórico.
    const sent = contentsText();
    expect(sent.some((t) => t.startsWith('model:') && t.includes(link('copo-300-ml')) && t.includes(link('copo-200-ml')) && t.includes('Quantos convidados'))).toBe(true);
    expect(sent.some((t) => t === 'user: Vai ser uns 40 convidados, eu acho.')).toBe(true);
    // Repetir a frase também segue com a IA.
    ai.script = [answer('Isso, 40 convidados. Quer que eu calcule com 2 ou 3 copos por pessoa?')];
    await client('Vai ser uns 40 convidados.');
    expect((await lastBot()).body).toContain('copos por pessoa');
    expect((await botMessages()).every((m) => m.kind === 'text')).toBe(true);
    expect(await routes()).toEqual(['ia', 'ia', 'ia', 'ia', 'ia']);
    expect(await conversation()).toEqual({ state: 'bot', step: 'ai' });
  });

  it('2 resposta numérica: "3" depois de "Quantos pacotes?" vai para a IA, não vira a opção 3 do menu', async () => {
    ai.script = [answer('O copo de 300 ml vem em pacote com 100. Quantos pacotes você deseja?')];
    await client('quero copo de 300 ml');
    ai.script = [answer('Perfeito: 3 pacotes do copo de 300 ml, 300 copos no total.')];
    await client('3');
    expect((await lastBot()).body).toBe('Perfeito: 3 pacotes do copo de 300 ml, 300 copos no total.');
    expect(contentsText().at(-1)).toBe('user: 3');
    expect(contentsText().at(-2)).toContain('Quantos pacotes você deseja?');
    // "4" também não é "Falar com atendente" no meio da conversa.
    ai.script = [answer('Certo, 4 pacotes então.')];
    await client('4');
    expect((await conversation()).state).toBe('bot');
    expect((await lastBot()).body).toBe('Certo, 4 pacotes então.');
  });

  it('3 mensagem curta: "Só refrigerante" é interpretada com a pergunta anterior', async () => {
    ai.script = [answer('Para ajudar a escolher o copo ideal, qual bebida será servida?')];
    await client('quero copos para festa');
    ai.script = [answer('Para refrigerante, o copo de 300 ml é o mais indicado.')];
    await client('Só refrigerante');
    expect((await lastBot()).body).toContain('refrigerante');
    const sent = contentsText();
    expect(sent.at(-2)).toBe('model: Para ajudar a escolher o copo ideal, qual bebida será servida?');
    expect(sent.at(-1)).toBe('user: Só refrigerante');
    // A instrução de continuidade vai no prompt.
    expect(lastRequest().system).toContain('Uma resposta curta');
  });

  it('4 novo assunto: pratos no meio da conversa sobre copos, com o histórico dos copos', async () => {
    await upToGuestsQuestion();
    ai.script = consultant('Para os 40 convidados, temos prato descartável de 15 cm.', ['prato descartável', 'prato festa', 'prato 15 cm']);
    await client('E pratos descartáveis, vocês têm?');
    expect((await lastBot()).body).toContain('prato');
    const sent = contentsText(ai.requests.at(-4)!);
    expect(sent.some((t) => t.includes('festinha de 15 anos'))).toBe(true);
    expect(sent.some((t) => t.includes(link('copo-300-ml')))).toBe(true);
    expect((await conversation()).step).toBe('ai');
  });

  it('5 transferência humana: pedido explícito passa para atendente e o histórico fica', async () => {
    await upToGuestsQuestion();
    const before = ai.requests.length;
    await client('Quero falar com um atendente');
    expect(ai.requests).toHaveLength(before);
    expect(await conversation()).toMatchObject({ state: 'agent' });
    // A conversa toda continua no banco para o atendente (caixa de entrada).
    const thread = (await boss.post('/api/v1/admin/whatsapp/conversations/view', { phone: PHONE })).json();
    expect(JSON.stringify(thread)).toContain('festinha de 15 anos');
    expect(JSON.stringify(thread)).toContain(link('copo-300-ml'));
    // "1 copo por pessoa" não é pedido de atendente.
    await owner.query(`UPDATE whatsapp_conversations SET state = 'bot', step = 'ai' WHERE phone = $1`, [PHONE]);
    ai.script = [answer('Com 1 copo por pessoa, 40 copos bastam.')];
    await client('acho que 1 copo por pessoa');
    expect((await conversation()).state).toBe('bot');
    expect((await lastBot()).body).toBe('Com 1 copo por pessoa, 40 copos bastam.');
  });

  it('6 links e retorno: a pergunta sobre "o segundo" chega à IA com os três links no histórico', async () => {
    const three = ['Opções de copo:', `1. Copo 200 ml\n${link('copo-200-ml')}`, `2. Copo 300 ml\n${link('copo-300-ml')}`, `3. Copo 500 ml\n${link('copo-500-ml')}`, 'Qual prefere?'].join('\n');
    ai.script = consultant(three, ['copo', 'copo descartável', 'copo plástico']);
    await client('quais copos vocês têm?');
    expect((await lastBot()).body).toBe(three);
    ai.script = [answer('O copo de 300 ml vem em pacote com 100 e tem tampa vendida à parte.')];
    await client('o segundo tem tampa?');
    const model = contentsText().find((t) => t.startsWith('model:'))!;
    for (const s of ['copo-200-ml', 'copo-300-ml', 'copo-500-ml']) expect(model).toContain(link(s));
    expect((await lastBot()).body).toContain('300 ml');
  });

  it('7 mensagens duplicadas: o mesmo webhook duas vezes é respondido uma vez', async () => {
    const wamid = `wamid.${uid()}`;
    ai.script = [answer('Olá! Como posso ajudar?')];
    expect((await signed(hook('Oi', wamid))).statusCode).toBe(200);
    expect((await signed(hook('Oi', wamid))).statusCode).toBe(200);
    await Promise.all([botTick(wa), botTick(wa)]);
    await botTick(wa);
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_inbound WHERE wamid = $1', [wamid])).rows[0].n).toBe(1);
    expect(await botMessages()).toHaveLength(1);
    expect(ai.requests).toHaveLength(1);
  });

  it('8 reinicialização: com um processo novo (IA sem memória), o contexto vem do banco e a conversa segue', async () => {
    await upToGuestsQuestion();
    // "Reinicia": outro simulador de IA, sem nada do anterior. O estado e o histórico estão só no banco.
    const fresh = new FakeAi();
    const app2 = await makeApp(undefined, new FakeProvider(), null, undefined, { whatsapp: wa, ai: fresh });
    try {
      ai = fresh;
      ai.script = [answer('Para 40 convidados, 2 pacotes do copo de 300 ml.')];
      await client('uns 40');
      expect((await lastBot()).body).toBe('Para 40 convidados, 2 pacotes do copo de 300 ml.');
      expect(fresh.requests).toHaveLength(1);
      expect(contentsText(fresh.requests[0]).some((t) => t.includes(link('copo-300-ml')))).toBe(true);
      expect(await conversation()).toEqual({ state: 'bot', step: 'ai' });
    } finally {
      await app2.close();
    }
  });

  it('falha da IA no meio da conversa: aviso natural (sem menu) e, na segunda seguida, atendente', async () => {
    await upToGuestsQuestion();
    ai.failCount = 2; // a primeira tentativa e a segunda falham
    await client('uns 40 convidados');
    expect((await lastBot()).body).toContain('instabilidade');
    expect((await lastBot()).kind).toBe('text');
    expect((await conversation()).step).toBe('ai');
    // Voltou: segue normalmente.
    ai.script = [answer('Para 40 convidados, 2 pacotes.')];
    await client('uns 40 convidados');
    expect((await lastBot()).body).toBe('Para 40 convidados, 2 pacotes.');
    // Duas falhas seguidas de verdade: atendente, com o histórico.
    ai.failCount = 4;
    await client('e entrega?');
    await client('e entrega?');
    expect((await conversation()).state).toBe('agent');
    expect((await routes()).slice(-2)).toEqual(['ia_falha', 'ia_falha:atendente']);
  });

  it('limite diário conta mensagens, não chamadas: 6 respostas com buscas cabem num limite de 6', async () => {
    const r = await boss.put('/api/v1/admin/whatsapp/bot', { audience: 'all', testPhones: [PHONE], hours: {}, texts: {}, mode: 'ai', aiPlan: 'free', aiMonthlyLimitUsd: 10, aiDailyPerPhone: 6 });
    expect(r.statusCode).toBe(200);
    for (let i = 0; i < 6; i++) {
      ai.script = consultant(`Resposta ${i}`, ['copo', 'prato', 'talher']);
      await client(`pergunta ${i}`);
      expect((await lastBot()).body).toBe(`Resposta ${i}`);
    }
    expect(ai.requests).toHaveLength(24);
    await client('mais uma');
    expect((await conversation()).state).toBe('agent');
  });
});
