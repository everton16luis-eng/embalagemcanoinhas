import type { FastifyInstance } from 'fastify';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { appRole, client, createUser, makeApp, owner, PASSWORD, sentResets } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

describe('login e sessão', () => {
  it('entra, consulta /me e sai', async () => {
    const u = await createUser('manager');
    const c = client(app);
    await c.login(u);
    const me = await c.get('/api/v1/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(u.email);
    expect(me.json().permissions).toContain('catalog.manage');
    expect((await c.post('/api/v1/auth/logout')).statusCode).toBe(200);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('recusa senha errada com a mesma mensagem de e-mail inexistente', async () => {
    const u = await createUser('sales');
    const wrong = await client(app).post('/api/v1/auth/login', { email: u.email, password: 'errada-123456' });
    const ghost = await client(app).post('/api/v1/auth/login', { email: 'ninguem@teste.local', password: 'errada-123456' });
    expect(wrong.statusCode).toBe(401);
    expect(ghost.json().error.message).toBe(wrong.json().error.message);
  });

  it('bloqueia o e-mail depois de 5 falhas, mesmo com a senha certa', async () => {
    const u = await createUser('sales');
    for (let i = 0; i < 5; i++) await client(app).post('/api/v1/auth/login', { email: u.email, password: 'errada-123456' });
    const res = await client(app).post('/api/v1/auth/login', { email: u.email, password: PASSWORD });
    expect(res.statusCode).toBe(429);
  });

  it('usuário desativado não entra e perde a sessão', async () => {
    const u = await createUser('sales');
    const c = client(app);
    await c.login(u);
    await owner.query('UPDATE users SET is_active = false WHERE id = $1', [u.id]);
    expect((await c.get('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await client(app).post('/api/v1/auth/login', { email: u.email, password: PASSWORD })).statusCode).toBe(401);
  });

  it('com MFA, exige o código e não aceita o mesmo código duas vezes', async () => {
    const u = await createUser('owner', { mfa: true });
    const noCode = await client(app).post('/api/v1/auth/login', { email: u.email, password: PASSWORD });
    expect(noCode.json().error.code).toBe('MFA_CODE_REQUIRED');
    const totp = await generate({ secret: u.secret! });
    expect((await client(app).post('/api/v1/auth/login', { email: u.email, password: PASSWORD, totp })).statusCode).toBe(200);
    expect((await client(app).post('/api/v1/auth/login', { email: u.email, password: PASSWORD, totp })).statusCode).toBe(401);
  });

  it('ativa o MFA pela conta', async () => {
    const u = await createUser('manager');
    const c = client(app);
    await c.login(u);
    const setup = await c.post('/api/v1/auth/mfa/setup');
    expect(setup.statusCode).toBe(200);
    const code = await generate({ secret: setup.json().secret });
    expect((await c.post('/api/v1/auth/mfa/confirm', { code })).statusCode).toBe(200);
    expect((await c.get('/api/v1/auth/me')).json().user.mfaEnabled).toBe(true);
  });

  it('troca de senha derruba as outras sessões', async () => {
    const u = await createUser('sales');
    const a = client(app);
    const b = client(app);
    await a.login(u);
    await b.login(u);
    const res = await a.post('/api/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: 'Nova-senha-4567' });
    expect(res.statusCode).toBe(200);
    expect((await a.get('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await b.get('/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('recuperação de senha: mesma resposta para qualquer e-mail, link de uso único', async () => {
    const u = await createUser('sales');
    const c = client(app);
    expect((await c.post('/api/v1/auth/password/forgot', { email: 'ninguem@teste.local' })).statusCode).toBe(202);
    expect((await c.post('/api/v1/auth/password/forgot', { email: u.email })).statusCode).toBe(202);
    const sent = sentResets.find((s) => s.email === u.email)!;
    expect(sent).toBeTruthy();
    expect((await c.post('/api/v1/auth/password/reset', { token: sent.token, newPassword: 'Outra-senha-890' })).statusCode).toBe(200);
    expect((await c.post('/api/v1/auth/password/reset', { token: sent.token, newPassword: 'Outra-senha-891' })).statusCode).toBe(400);
  });

  it('recusa alteração vinda de outra origem (CSRF)', async () => {
    const u = await createUser('manager');
    const c = client(app);
    await c.login(u);
    const res = await c.send('POST', '/api/v1/auth/logout', {}, { origin: 'https://site-malicioso.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INVALID_ORIGIN');
  });
});
