import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { config } from '../config.js';
import { AppError } from './errors.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
// Tamanhos gerados: miniatura de lista, vitrine e pagina do produto (ampliacao).
export const IMAGE_SIZES = [320, 800, 1600] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

const root = path.resolve(process.cwd(), config.STORAGE_DIR, 'images');
const KEY = /^[a-f0-9-]{36}$/;

/**
 * Le o conteudo real do arquivo (nao confia na extensao), remove metadados (EXIF, GPS),
 * corrige a rotacao e grava em WebP nos tamanhos da loja. Devolve a chave e as medidas.
 */
export async function storeImage(buffer: Buffer) {
  let meta: Metadata;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', 'Arquivo não é uma imagem válida.');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw new AppError(422, 'INVALID_IMAGE', 'Use JPG, PNG ou WebP.');
  if (!meta.width || !meta.height || meta.width < 400 || meta.height < 400) throw new AppError(422, 'IMAGE_TOO_SMALL', 'A imagem precisa ter ao menos 400 × 400 pixels.');

  const key = randomUUID();
  const dir = path.join(root, key);
  await mkdir(dir, { recursive: true });
  try {
    let largest = { width: 0, height: 0, bytes: 0 };
    for (const size of IMAGE_SIZES) {
      const out = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: size === 320 ? 72 : 80 })
        .toBuffer({ resolveWithObject: true });
      await writeFile(path.join(dir, `${size}.webp`), out.data);
      largest = { width: out.info.width, height: out.info.height, bytes: out.info.size };
    }
    return { key, ...largest };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

export async function readImage(key: string, size: ImageSize) {
  if (!KEY.test(key)) return null;
  return readFile(path.join(root, key, `${size}.webp`)).catch(() => null);
}

export async function removeImage(key: string) {
  if (KEY.test(key)) await rm(path.join(root, key), { recursive: true, force: true });
}
