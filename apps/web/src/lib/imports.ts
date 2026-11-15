// Rotulos da importacao de produtos por planilha (docs/14-importacao-produtos.md).
type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'act';

export type ImportSummary = {
  id: string;
  file_name: string;
  file_bytes: number;
  status: 'analyzed' | 'importing' | 'done' | 'canceled';
  totals: Record<string, number>;
  warnings: string[];
  pending_categories: PendingCategory[];
  category_decisions: Record<string, { action: 'map'; categoryId: string } | { action: 'create' }>;
  results: { imported: number; skipped: number; failed: number; pending: number; withoutImage: number };
  created_at: string;
  confirmed_at: string | null;
  finished_at: string | null;
  created_by_name: string;
  confirmed_by_name: string | null;
};

export type PendingCategory = { key: string; category: string; subcategory: string | null; parentId: string | null; rows: number; decision: { action: 'map'; categoryId: string } | { action: 'create' } | null };

export type GuideColumn = { key: string; header: string; required: boolean; format: string; example: string };

export const IMPORT_STATUS: Record<string, { label: string; tone: Tone }> = {
  analyzed: { label: 'Aguardando revisão', tone: 'warn' },
  importing: { label: 'Em andamento', tone: 'act' },
  done: { label: 'Concluída', tone: 'good' },
  canceled: { label: 'Descartada', tone: 'neutral' },
};

export const ROW_STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'Novo', tone: 'good' },
  existing: { label: 'Já existe', tone: 'neutral' },
  duplicate: { label: 'Possível duplicado', tone: 'warn' },
  error: { label: 'Com erro', tone: 'bad' },
  incomplete: { label: 'Incompleto', tone: 'bad' },
  category: { label: 'Categoria pendente', tone: 'warn' },
};

export const ROW_RESULT: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Na fila', tone: 'act' },
  imported: { label: 'Cadastrado', tone: 'good' },
  skipped: { label: 'Ignorado', tone: 'neutral' },
  failed: { label: 'Não cadastrado', tone: 'bad' },
};
