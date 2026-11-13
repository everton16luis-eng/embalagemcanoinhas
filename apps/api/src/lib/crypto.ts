import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const key = Buffer.from(config.ENC_KEY, 'hex');
const TAG_BYTES = 16;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

/** Resumo com chave: busca e duplicidade de dado pessoal sem guardar o dado em claro. */
const hmacKey = createHash('sha256').update(Buffer.concat([key, Buffer.from('hmac-dados-pessoais')])).digest();
export const keyedHash = (value: string) => createHmac('sha256', hmacKey).update(value).digest('hex');

/** AES-256-GCM. Formato: iv.tag.dados, em base64. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !data) throw new Error('payload cifrado invalido');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
