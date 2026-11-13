import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { ibgeMatchesUf, isValidCnpj, normalizeCnpj, onlyDigits, UFS } from '../lib/br.js';
import { AppError, notFound } from '../lib/errors.js';
import { requirePermission } from './auth.js';

// Todos os campos sao opcionais: a empresa preenche aos poucos e o assistente mostra o que falta.
// Nada e completado automaticamente; o sistema so confere formato e digito verificador.
const digits = (min: number, max: number, msg: string) =>
  z
    .string()
    .trim()
    .transform(onlyDigits)
    .refine((v) => v.length >= min && v.length <= max, msg);
const opt = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === '' ? null : v), s.nullable().optional());

export const companySchema = z
  .strictObject({
    legalName: opt(z.string().trim().min(2).max(150)),
    tradeName: opt(z.string().trim().min(2).max(150)),
    cnpj: opt(z.string().trim().transform(normalizeCnpj).refine(isValidCnpj, 'CNPJ inválido: confira os dígitos.')),
    stateRegistration: opt(digits(2, 14, 'Inscrição Estadual: informe só os números.')),
    municipalRegistration: opt(z.string().trim().min(1).max(20)),
    street: opt(z.string().trim().min(2).max(120)),
    number: opt(z.string().trim().min(1).max(20)),
    complement: opt(z.string().trim().max(60)),
    district: opt(z.string().trim().min(2).max(60)),
    city: opt(z.string().trim().min(2).max(60)),
    cityIbge: opt(digits(7, 7, 'Código IBGE do município tem 7 dígitos.')),
    uf: opt(z.enum(UFS)),
    cep: opt(digits(8, 8, 'CEP tem 8 dígitos.')),
    phone: opt(digits(10, 13, 'Telefone: DDD e número.')),
    email: opt(z.email().max(254)),
    cnaeMain: opt(digits(7, 7, 'CNAE tem 7 dígitos.')),
    cnaesSecondary: z.array(digits(7, 7, 'CNAE tem 7 dígitos.')).max(99).default([]),
    taxRegime: opt(z.enum(['mei', 'simples_nacional', 'simples_excesso_sublimite', 'lucro_presumido', 'lucro_real'])),
    accountantName: opt(z.string().trim().min(2).max(120)),
    accountantCrc: opt(z.string().trim().min(3).max(30)),
    accountantFirm: opt(z.string().trim().min(2).max(150)),
    accountantEmail: opt(z.email().max(254)),
    accountantPhone: opt(digits(10, 13, 'Telefone do contador: DDD e número.')),
    changeNote: opt(z.string().trim().max(300)),
  })
  .superRefine((c, ctx) => {
    if (c.cityIbge && c.uf && !ibgeMatchesUf(c.cityIbge, c.uf)) ctx.addIssue({ code: 'custom', path: ['cityIbge'], message: 'O código IBGE não corresponde à UF informada.' });
  });

const COLUMNS: Record<string, string> = {
  legalName: 'legal_name', tradeName: 'trade_name', cnpj: 'cnpj', stateRegistration: 'state_registration', municipalRegistration: 'municipal_registration',
  street: 'street', number: 'number', complement: 'complement', district: 'district', city: 'city', cityIbge: 'city_ibge', uf: 'uf', cep: 'cep',
  phone: 'phone', email: 'email', cnaeMain: 'cnae_main', cnaesSecondary: 'cnaes_secondary', taxRegime: 'tax_regime',
  accountantName: 'accountant_name', accountantCrc: 'accountant_crc', accountantFirm: 'accountant_firm', accountantEmail: 'accountant_email', accountantPhone: 'accountant_phone',
  changeNote: 'change_note',
};

export const currentCompany = async (db: Pick<typeof pool, 'query'>) =>
  (await db.query('SELECT * FROM company_profiles ORDER BY version DESC LIMIT 1')).rows[0] ?? null;

export async function companyRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'company.view');
    const versions = (
      await pool.query(`SELECT c.version, c.created_at, c.change_note, u.name AS created_by FROM company_profiles c JOIN users u ON u.id = c.created_by ORDER BY c.version DESC LIMIT 50`)
    ).rows;
    return { company: await currentCompany(pool), versions };
  });

  app.get('/versions/:version', async (req) => {
    requirePermission(req, 'company.view');
    const { version } = z.object({ version: z.coerce.number().int().positive() }).parse(req.params);
    const { rows } = await pool.query('SELECT * FROM company_profiles WHERE version = $1', [version]);
    if (!rows[0]) throw notFound();
    return { company: rows[0] };
  });

  // Cada gravacao e uma versao nova. As anteriores ficam como estavam (notas ja emitidas apontam para elas).
  app.put('/', async (req) => {
    const auth = requirePermission(req, 'company.manage');
    const c = companySchema.parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = await currentCompany(db);
      const keys = Object.keys(COLUMNS);
      const values = keys.map((k) => (c as Record<string, unknown>)[k] ?? (k === 'cnaesSecondary' ? [] : null));
      const changed = !before || keys.some((k, i) => k !== 'changeNote' && JSON.stringify(before[COLUMNS[k]!] ?? (k === 'cnaesSecondary' ? [] : null)) !== JSON.stringify(values[i]));
      if (!changed) throw new AppError(409, 'NO_CHANGES', 'Nenhum dado foi alterado.');
      const cols = keys.map((k) => COLUMNS[k]).join(', ');
      const params = keys.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await db.query(`INSERT INTO company_profiles (${cols}, created_by) VALUES (${params}, $${keys.length + 1}) RETURNING *`, [...values, auth.userId]);
      await audit(db, { actorId: auth.userId, action: 'company.updated', entity: 'company', entityId: String(rows[0].version), before, after: rows[0], ip: req.ip });
      return { company: rows[0] };
    });
  });
}

export async function fiscalSettingsRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'fiscal.view');
    return { settings: (await pool.query('SELECT * FROM fiscal_settings')).rows[0] };
  });

  app.patch('/', async (req) => {
    const auth = requirePermission(req, 'fiscal.manage');
    const b = z
      .strictObject({
        environment: z.enum(['homologacao', 'producao']).optional(),
        nfeSeries: z.number().int().min(0).max(999).nullable().optional(),
        nfeNextNumber: z.number().int().min(1).max(999_999_999).nullable().optional(),
        accreditationStatus: z.enum(['not_started', 'in_progress', 'accredited']).optional(),
        accreditationNotes: z.string().trim().max(1000).nullable().optional(),
      })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM fiscal_settings FOR UPDATE')).rows[0];
      // Producao so com o provedor fiscal homologado e a liberacao registrada (Fase 5).
      if (b.environment === 'producao' && !before.production_released_at) {
        throw new AppError(409, 'PRODUCTION_LOCKED', 'A emissão em produção só é liberada depois da homologação com o provedor fiscal e da validação do contador.');
      }
      const { rows } = await db.query(
        `UPDATE fiscal_settings SET environment = $1, nfe_series = $2, nfe_next_number = $3, accreditation_status = $4, accreditation_notes = $5, updated_by = $6, updated_at = now() RETURNING *`,
        [
          b.environment ?? before.environment,
          b.nfeSeries === undefined ? before.nfe_series : b.nfeSeries,
          b.nfeNextNumber === undefined ? before.nfe_next_number : b.nfeNextNumber,
          b.accreditationStatus ?? before.accreditation_status,
          b.accreditationNotes === undefined ? before.accreditation_notes : b.accreditationNotes,
          auth.userId,
        ],
      );
      await audit(db, { actorId: auth.userId, action: 'fiscal.settings_updated', entity: 'fiscal_settings', before, after: rows[0], ip: req.ip });
      return { settings: rows[0] };
    });
  });
}

export async function storeSettingsRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    requirePermission(req, 'settings.manage');
    return { settings: (await pool.query('SELECT * FROM store_settings')).rows[0] };
  });

  app.patch('/', async (req) => {
    const auth = requirePermission(req, 'settings.manage');
    const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
    const b = z
      .strictObject({
        storeName: opt(z.string().trim().min(2).max(60)),
        tagline: opt(z.string().trim().max(120)),
        domain: opt(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{3,253}$/)),
        colors: z.partialRecord(z.enum(['primary', 'accent', 'ink', 'surface']), hex).optional(),
        whatsappNumber: opt(digits(12, 13, 'WhatsApp com DDI 55, DDD e número.')),
        supportEmail: opt(z.email().max(254)),
        pages: z.partialRecord(z.enum(['about', 'returns', 'privacy', 'shipping', 'terms']), z.string().max(20000)).optional(),
      })
      .parse(req.body);
    return tx(auth.userId, async (db) => {
      const before = (await db.query('SELECT * FROM store_settings FOR UPDATE')).rows[0];
      const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
      const { rows } = await db.query(
        `UPDATE store_settings SET store_name = $1, tagline = $2, domain = $3, colors = $4, whatsapp_number = $5, support_email = $6, pages = $7, updated_by = $8, updated_at = now() RETURNING *`,
        [pick(b.storeName, before.store_name), pick(b.tagline, before.tagline), pick(b.domain, before.domain), b.colors ?? before.colors, pick(b.whatsappNumber, before.whatsapp_number), pick(b.supportEmail, before.support_email), b.pages ? { ...before.pages, ...b.pages } : before.pages, auth.userId],
      );
      await audit(db, { actorId: auth.userId, action: 'settings.store_updated', entity: 'store_settings', before, after: rows[0], ip: req.ip });
      return { settings: rows[0] };
    });
  });
}
