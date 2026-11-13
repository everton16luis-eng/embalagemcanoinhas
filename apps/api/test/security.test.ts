import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { appRole, client, loggedAs, makeApp, owner } from './helpers.js';

const routes: { method: string; url: string }[] = [];
let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp(routes);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await appRole.end();
});

const ID = '00000000-0000-4000-8000-000000000000';
const fill = (url: string) => url.replace(/:[a-zA-Z]+/g, (p) => (p === ':version' ? '1' : p === ':key' ? ID : p === ':size' ? '320.webp' : ID));
// Rotas abertas de proposito.
const PUBLIC = new Set(['/health', '/ready', '/api/v1/auth/login', '/api/v1/auth/password/forgot', '/api/v1/auth/password/reset', '/api/v1/public/images/:key/:size']);

describe('varredura de rotas', () => {
  it('toda rota administrativa exige sessão', async () => {
    const admin = routes.filter((r) => !PUBLIC.has(r.url));
    expect(admin.length).toBeGreaterThan(25);
    for (const r of admin) {
      const res = await client(app).send(r.method as never, fill(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('atendente não altera catálogo, empresa, fiscal, usuários nem configurações', async () => {
    const sales = await loggedAs(app, 'sales');
    const forbidden = routes.filter((r) => r.method !== 'GET' && /\/admin\/(categories|products|company|fiscal|users|store-settings)/.test(r.url));
    expect(forbidden.length).toBeGreaterThan(8);
    for (const r of forbidden) {
      const res = await sales.send(r.method as never, fill(r.url), r.method === 'DELETE' ? undefined : {});
      // 400 seria validacao antes da permissao: nunca pode acontecer.
      expect([403], `${r.method} ${r.url} → ${res.statusCode}`).toContain(res.statusCode);
    }
    // Atendente consulta saldo, mas nao movimenta estoque nem compra.
    const stockWrites = routes.filter((r) => r.method !== 'GET' && /\/admin\/(stock|suppliers|purchase-orders|inventory-counts)/.test(r.url));
    expect(stockWrites.length).toBeGreaterThan(12);
    for (const r of stockWrites) expect((await sales.send(r.method as never, fill(r.url), {})).statusCode, `${r.method} ${r.url}`).toBe(403);
    expect((await sales.get('/api/v1/admin/stock')).statusCode).toBe(200);
    for (const url of ['/api/v1/admin/suppliers', '/api/v1/admin/purchase-orders', '/api/v1/admin/stock-reports/replenishment', '/api/v1/admin/stock-reports/summary']) {
      expect((await sales.get(url)).statusCode, url).toBe(403);
    }
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/audit', '/api/v1/admin/company', '/api/v1/admin/store-settings']) {
      expect((await sales.get(url)).statusCode, url).toBe(403);
    }
  });

  it('permissão sensível exige a verificação em duas etapas', async () => {
    const noMfa = await loggedAs(app, 'owner');
    const res = await noMfa.put('/api/v1/admin/company', { legalName: 'Teste' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MFA_REQUIRED');
    const withMfa = await loggedAs(app, 'owner', { mfa: true });
    expect((await withMfa.get('/api/v1/admin/users')).statusCode).toBe(200);
  });
});

describe('papel do banco da aplicação', () => {
  it('não lê o hash da senha nem o segredo do MFA', async () => {
    await expect(appRole.query('SELECT password_hash FROM users LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(appRole.query('SELECT totp_secret_enc FROM users LIMIT 1')).rejects.toThrow(/permission denied/);
  });

  it('não altera nem apaga a auditoria, as versões da empresa ou o histórico de preços', async () => {
    await expect(appRole.query('UPDATE audit_logs SET action = $1', ['x.y'])).rejects.toThrow();
    await expect(appRole.query('DELETE FROM audit_logs')).rejects.toThrow();
    await expect(appRole.query('DELETE FROM company_profiles')).rejects.toThrow();
    await expect(appRole.query('UPDATE price_history SET new_price_cents = 1')).rejects.toThrow();
    await expect(appRole.query('DELETE FROM price_history')).rejects.toThrow();
  });

  it('nem o dono das tabelas altera a auditoria', async () => {
    await expect(owner.query(`UPDATE audit_logs SET action = 'x.y' WHERE id = (SELECT min(id) FROM audit_logs)`)).rejects.toThrow(/nao permitido/);
    await expect(owner.query('TRUNCATE audit_logs')).rejects.toThrow(/nao permitido/);
  });
});

describe('usuários', () => {
  it('cria usuário com senha temporária, que entra', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const res = await boss.post('/api/v1/admin/users', { email: `novo-${Date.now()}@teste.local`, name: 'Pessoa Nova', role: 'stock' });
    expect(res.statusCode).toBe(201);
    const { user, temporaryPassword } = res.json();
    const login = await client(app).post('/api/v1/auth/login', { email: user.email, password: temporaryPassword });
    expect(login.statusCode).toBe(200);
  });

  it('gerente não cria proprietário; ninguém altera o próprio papel', async () => {
    const manager = await loggedAs(app, 'manager', { mfa: true });
    // gerente nao tem users.manage por padrao
    expect((await manager.post('/api/v1/admin/users', { email: `x-${Date.now()}@teste.local`, name: 'X Y', role: 'owner' })).statusCode).toBe(403);
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const self = await boss.patch(`/api/v1/admin/users/${boss.user.id}`, { role: 'sales' });
    expect(self.json().error.code).toBe('SELF_CHANGE');
  });

  it('concede e retira permissão individual; desativar derruba a sessão', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const sales = await loggedAs(app, 'sales');
    expect((await sales.get('/api/v1/admin/audit')).statusCode).toBe(403);
    expect((await boss.patch(`/api/v1/admin/users/${sales.user.id}`, { overrides: { 'audit.view': true, 'sales_desk.use': false } })).statusCode).toBe(200);
    expect((await sales.get('/api/v1/admin/audit')).statusCode).toBe(200);
    const me = (await sales.get('/api/v1/auth/me')).json();
    expect(me.permissions).not.toContain('sales_desk.use');
    await boss.patch(`/api/v1/admin/users/${sales.user.id}`, { isActive: false });
    expect((await sales.get('/api/v1/auth/me')).statusCode).toBe(401);
  });
});
