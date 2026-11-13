// Uso: npm run create-owner -w apps/api -- email@dominio "Nome"
// Cria o primeiro proprietario. A senha inicial aparece uma unica vez; no primeiro acesso,
// ative a verificacao em duas etapas em Minha conta.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, tx } from './pool.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../modules/auth.js';

const [email, name] = process.argv.slice(2);
const parsed = z.object({ email: z.email(), name: z.string().trim().min(2).max(120) }).safeParse({ email, name });
if (!parsed.success) {
  console.error('Uso: npm run create-owner -w apps/api -- email@dominio "Nome"');
  process.exit(1);
}
const password = `${randomBytes(12).toString('base64url')}9a`;
try {
  await tx(null, async (db) => {
    const { rows } = await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'owner', $3) RETURNING id`, [parsed.data.email, parsed.data.name, await hashPassword(password)]);
    await audit(db, { actorId: rows[0].id, action: 'users.owner_bootstrap', entity: 'user', entityId: rows[0].id });
  });
  console.log(`Proprietario criado: ${parsed.data.email}`);
  console.log(`Senha inicial (aparece so agora): ${password}`);
} catch (err) {
  console.error((err as { code?: string }).code === '23505' ? 'Ja existe um usuario com este e-mail.' : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
