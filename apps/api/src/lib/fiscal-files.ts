import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import { config } from '../config.js';
import type { Db, pool } from '../db/pool.js';
import { AppError, notFound } from './errors.js';
import type { FileKind } from './fiscal.js';

/**
 * Guarda dos arquivos fiscais (XML e DANFE). O XML assinado e o documento fiscal: fica no armazenamento
 * com o SHA-256 no banco, e o hash e conferido a cada leitura. Nada aqui apaga arquivo.
 */
const root = path.resolve(process.cwd(), config.STORAGE_DIR, 'fiscal');
const KEY = /^[0-9]{4}\/[a-f0-9-]{36}\.(xml|pdf)$/;

export const FILE_EXT: Record<FileKind, 'xml' | 'pdf'> = { nfe_xml: 'xml', danfe_pdf: 'pdf', cancel_xml: 'xml', cce_xml: 'xml', cce_pdf: 'pdf', inut_xml: 'xml' };
const CONTENT_TYPE = { xml: 'application/xml', pdf: 'application/pdf' } as const;

export async function saveFiscalFile(buf: Buffer, kind: FileKind) {
  const ext = FILE_EXT[kind];
  // Confere o conteudo minimo: XML comeca com '<', PDF com '%PDF'.
  const head = buf.subarray(0, 8).toString('latin1').replace(/^﻿/, '').trimStart();
  if (ext === 'xml' ? !head.startsWith('<') : !head.startsWith('%PDF')) throw new AppError(502, 'FISCAL_FILE_INVALID', 'O provedor devolveu um arquivo fiscal em formato inesperado.');
  const key = `${new Date().getUTCFullYear()}/${randomUUID()}.${ext}`;
  await mkdir(path.join(root, key.slice(0, 4)), { recursive: true });
  // wx: nunca sobrescreve um arquivo existente.
  await writeFile(path.join(root, key), buf, { flag: 'wx' });
  return { key, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

export async function readFiscalFile(key: string, sha256: string) {
  if (!KEY.test(key)) throw notFound();
  const buf = await readFile(path.join(root, key)).catch(() => null);
  if (!buf) throw new AppError(500, 'FISCAL_FILE_MISSING', 'Arquivo fiscal não encontrado no armazenamento. Restaure o backup.');
  if (createHash('sha256').update(buf).digest('hex') !== sha256) throw new AppError(500, 'FISCAL_FILE_CORRUPTED', 'O arquivo fiscal não confere com o registro (hash diferente). Restaure o backup.');
  return buf;
}

type FileRow = { storage_key: string; sha256: string; kind: FileKind; sequence: number };

export async function sendFiscalFile(reply: FastifyReply, f: FileRow, name: string) {
  const buf = await readFiscalFile(f.storage_key, f.sha256);
  const ext = f.storage_key.endsWith('.pdf') ? 'pdf' : 'xml';
  return reply
    .header('Content-Type', CONTENT_TYPE[ext])
    .header('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}.${ext}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .send(buf);
}

/** Nota do pedido para o cliente: a autorizada (ou cancelada) mais recente, sem dados internos. */
export async function invoiceSummary(db: Db | typeof pool, orderId: string) {
  const doc = (
    await db.query(
      `SELECT d.id, d.status, d.number, d.series, d.access_key, d.authorized_at, d.canceled_at, d.environment,
              coalesce((SELECT array_agg(f.kind) FROM fiscal_files f WHERE f.document_id = d.id AND f.kind IN ('nfe_xml', 'danfe_pdf')), '{}') AS files
       FROM fiscal_documents d WHERE d.order_id = $1 AND d.status IN ('authorized', 'canceled') ORDER BY d.created_at DESC LIMIT 1`,
      [orderId],
    )
  ).rows[0];
  if (!doc) return null;
  const { id: _id, ...rest } = doc;
  return rest;
}

/** Envia o DANFE ou o XML da nota autorizada do pedido (cliente ou link do pedido). */
export async function sendOrderInvoice(db: Db | typeof pool, reply: FastifyReply, orderId: string, which: 'danfe' | 'xml') {
  const kind = which === 'danfe' ? 'danfe_pdf' : 'nfe_xml';
  const f = (
    await db.query<FileRow & { number: string }>(
      `SELECT f.storage_key, f.sha256, f.kind, f.sequence, d.number FROM fiscal_files f JOIN fiscal_documents d ON d.id = f.document_id
       WHERE d.order_id = $1 AND d.status IN ('authorized', 'canceled') AND f.kind = $2 ORDER BY d.created_at DESC LIMIT 1`,
      [orderId, kind],
    )
  ).rows[0];
  if (!f) throw notFound();
  return sendFiscalFile(reply, f, `nfe-${f.number}${which === 'danfe' ? '-danfe' : ''}`);
}
