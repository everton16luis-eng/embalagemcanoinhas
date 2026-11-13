export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Dados para a tela resolver o erro, como os atendimentos em conflito. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'Você não tem permissão para esta ação.');
// Usado tambem para recursos de outro tenant: a resposta nao revela que eles existem.
export const notFound = () => new AppError(404, 'NOT_FOUND', 'Registro não encontrado.');
