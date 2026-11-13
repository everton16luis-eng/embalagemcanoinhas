import { z } from 'zod';
import { AppError } from './errors.js';

export const idParams = z.object({ id: z.uuid() });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Coluna pedida pela tela: `nome` em ordem crescente, `-nome` em decrescente. */
export const sortParam = z.string().regex(/^-?[a-z_]{1,40}$/).optional();

/**
 * Trecho do ORDER BY. So entra no SQL o que esta na lista fechada de cada rota; o texto do
 * pedido escolhe uma entrada e nunca e copiado para a consulta.
 */
export function orderBy(sort: string | undefined, columns: Record<string, string>, fallback: string) {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  if (!Object.hasOwn(columns, key)) throw new AppError(400, 'INVALID_SORT', 'Ordenação não disponível nesta lista.');
  return `${columns[key]} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
}

/** Escapa curingas do LIKE para a busca do usuario ser tratada como texto. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

/** Lista de ids sem repeticoes, com limite para nao gerar consultas enormes. */
export const idList = z
  .array(z.uuid())
  .max(200)
  .transform((ids) => [...new Set(ids)]);

export const isForeignKeyViolation = (err: unknown, constraint?: string) => {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23503' && (!constraint || e.constraint === constraint);
};

export const isUniqueViolation = (err: unknown, constraint?: string) => {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (!constraint || e.constraint === constraint);
};
