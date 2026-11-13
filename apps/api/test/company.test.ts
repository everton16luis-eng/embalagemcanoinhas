import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { isValidCnpj, isValidCpf, isValidGtin } from '../src/lib/br.js';
import { appRole, loggedAs, makeApp, owner } from './helpers.js';

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

describe('validadores', () => {
  it('CNPJ numérico e alfanumérico (exemplo oficial da Receita)', () => {
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12ABC34501DE36')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11111111111111')).toBe(false);
  });
  it('CPF e GTIN', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidGtin('7891000315507')).toBe(true);
    expect(isValidGtin('7891000315508')).toBe(false);
  });
});

// Dados de teste: CNPJ do exemplo oficial da Receita e valores ficticios. Nao sao da empresa.
const sample = { legalName: 'Empresa de Teste Ltda', cnpj: '12.ABC.345/01DE-35', uf: 'SC', cityIbge: '4200000', cep: '89460-000' };

describe('dados da empresa', () => {
  it('cada gravação cria uma versão; a anterior continua igual', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const v1 = (await boss.put('/api/v1/admin/company', sample)).json().company;
    expect(v1.cnpj).toBe('12ABC34501DE35');
    expect(v1.cep).toBe('89460000');
    const v2 = (await boss.put('/api/v1/admin/company', { ...sample, tradeName: 'Nome de Teste', changeNote: 'nome fantasia' })).json().company;
    expect(v2.version).toBe(v1.version + 1);
    const old = (await boss.get(`/api/v1/admin/company/versions/${v1.version}`)).json().company;
    expect(old.trade_name).toBeNull();
    expect((await boss.put('/api/v1/admin/company', { ...sample, tradeName: 'Nome de Teste' })).json().error.code).toBe('NO_CHANGES');
  });

  it('recusa CNPJ inválido e IBGE de outra UF', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    expect((await boss.put('/api/v1/admin/company', { cnpj: '12ABC34501DE36' })).statusCode).toBe(400);
    const res = await boss.put('/api/v1/admin/company', { ...sample, cityIbge: '4100000' });
    expect(res.json().error.issues[0].field).toBe('cityIbge');
  });
});

describe('configuração fiscal', () => {
  it('começa em homologação e não vai para produção sem a liberação', async () => {
    const fiscal = await loggedAs(app, 'fiscal', { mfa: true });
    const s = (await fiscal.get('/api/v1/admin/fiscal/settings')).json().settings;
    expect(s.environment).toBe('homologacao');
    const res = await fiscal.patch('/api/v1/admin/fiscal/settings', { environment: 'producao' });
    expect(res.json().error.code).toBe('PRODUCTION_LOCKED');
    expect((await fiscal.patch('/api/v1/admin/fiscal/settings', { nfeSeries: 1, accreditationStatus: 'in_progress' })).json().settings.nfe_series).toBe(1);
  });

  it('o banco também impede produção sem liberação registrada', async () => {
    await expect(appRole.query(`UPDATE fiscal_settings SET environment = 'producao'`)).rejects.toThrow(/fiscal_settings_production/);
  });
});

describe('assistente de configuração', () => {
  it('lista o que falta, quem informa e o que fica para fases seguintes', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const { groups, summary } = (await boss.get('/api/v1/admin/setup')).json();
    const company = groups.find((g: { key: string }) => g.key === 'company');
    expect(company.items.find((i: { key: string }) => i.key === 'cnpj').status).toBe('done');
    expect(company.items.find((i: { key: string }) => i.key === 'state_registration').status).toBe('missing');
    const fiscal = groups.find((g: { key: string }) => g.key === 'fiscal');
    expect(fiscal.items.find((i: { key: string }) => i.key === 'certificate').status).toBe('later');
    expect(summary.done).toBeLessThan(summary.required);
  });
});

describe('marca da loja', () => {
  it('nome, cores e textos são configuráveis', async () => {
    const boss = await loggedAs(app, 'owner', { mfa: true });
    const res = await boss.patch('/api/v1/admin/store-settings', { storeName: 'Loja de Teste', colors: { primary: '#123456' }, pages: { returns: 'Texto' } });
    expect(res.json().settings).toMatchObject({ store_name: 'Loja de Teste', colors: { primary: '#123456' } });
    expect((await boss.patch('/api/v1/admin/store-settings', { colors: { primary: 'azul' } })).statusCode).toBe(400);
  });
});
