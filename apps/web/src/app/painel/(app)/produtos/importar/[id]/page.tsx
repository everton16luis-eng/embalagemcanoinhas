'use client';

import { Download, ImagePlus } from 'lucide-react';
import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Guard } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api, upload } from '@/lib/api';
import { money, when } from '@/lib/format';
import { IMPORT_STATUS, ROW_RESULT, ROW_STATUS, type GuideColumn, type ImportSummary, type PendingCategory } from '@/lib/imports';

type Issue = { field?: string; level: 'missing' | 'error' | 'warning'; message: string };
type Match = { kind: 'sku' | 'ean' | 'name'; productId?: string; row?: number; name: string; sku?: string | null; score?: number; message: string };
type Row = {
  row_number: number;
  raw: Record<string, string>;
  formula_fields: string[];
  data: { name: string; priceCents: number; unit: string; categoryId: string | null; categoryPath: string[]; categoryCreate: boolean; stockQty: string | null } | null;
  status: string;
  issues: Issue[];
  matches: Match[];
  decision: 'approve' | 'skip' | null;
  sku: string | null;
  sku_generated: boolean;
  result: string | null;
  result_reason: string | null;
  product_id: string | null;
  without_image?: boolean;
};
type Category = { id: string; parent_id: string | null; name: string };

const FILTERS_REVIEW = [
  ['all', 'Todos'],
  ['new', 'Novos'],
  ['duplicate', 'Duplicados'],
  ['existing', 'Já existem'],
  ['error', 'Com erro'],
  ['review', 'Aguardando revisão'],
] as const;
const FILTERS_DONE = [
  ['all', 'Todos'],
  ['imported', 'Cadastrados'],
  ['skipped', 'Ignorados'],
  ['failed', 'Não cadastrados'],
] as const;

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2.5">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`num text-xl font-semibold ${tone ?? ''}`}>{value ?? 0}</p>
    </div>
  );
}

function RowEditor({ row, columns, onSave, onDecision, editable }: { row: Row; columns: GuideColumn[]; onSave: (values: Record<string, string>) => Promise<void>; onDecision: (d: 'approve' | 'skip' | null) => Promise<void>; editable: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(columns.map((c) => [c.key, row.raw[c.key] ?? ''])));
  const [busy, setBusy] = useState(false);
  const fieldIssues = (key: string) => row.issues.filter((i) => i.field === key && i.level !== 'warning');
  const nameMatches = row.matches.filter((m) => m.kind === 'name');
  const changed = columns.some((c) => (values[c.key] ?? '') !== (row.raw[c.key] ?? ''));
  return (
    <div className="space-y-4 bg-sunken/40 px-4 py-4">
      {row.matches.length > 0 && (
        <div className="space-y-2">
          {row.matches.map((m, i) => (
            <p key={i} className="text-sm">
              {m.message}
              {m.productId && <> <Link className="underline" href={`/painel/produtos/${m.productId}`} target="_blank">Abrir produto</Link></>}
              {m.score !== undefined && m.score < 1 && <span className="text-ink-faint"> (semelhança {Math.round(m.score * 100)}%)</span>}
            </p>
          ))}
          {editable && nameMatches.length > 0 && row.status !== 'existing' && (
            <div className="flex flex-wrap gap-2">
              <Button variant={row.decision === 'approve' ? 'primary' : 'secondary'} onClick={() => void onDecision(row.decision === 'approve' ? null : 'approve')}>
                {row.decision === 'approve' ? 'Aprovado: será cadastrado' : 'Não é duplicado: cadastrar'}
              </Button>
              <Button variant={row.decision === 'skip' ? 'primary' : 'secondary'} onClick={() => void onDecision(row.decision === 'skip' ? null : 'skip')}>
                {row.decision === 'skip' ? 'Ignorado' : 'É duplicado: ignorar'}
              </Button>
            </div>
          )}
        </div>
      )}
      {row.issues.filter((i) => !i.field || i.level === 'warning').map((i, k) => (
        <Notice key={k} tone="warn">{i.message}</Notice>
      ))}
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const diff = Object.fromEntries(columns.filter((c) => (values[c.key] ?? '') !== (row.raw[c.key] ?? '')).map((c) => [c.key, values[c.key] ?? '']));
            await onSave(diff);
          } finally {
            setBusy(false);
          }
        }}
      >
        {columns.map((c) => {
          const errs = fieldIssues(c.key);
          const formula = row.formula_fields.includes(c.key);
          return (
            <Field key={c.key} label={c.header} required={c.required} error={errs.map((x) => x.message).join(' ') || undefined} hint={formula ? 'A célula tinha fórmula e foi descartada.' : undefined} className={c.key === 'description' ? 'sm:col-span-2 lg:col-span-3' : ''}>
              {(id) =>
                c.key === 'description' ? (
                  <Textarea id={id} disabled={!editable} value={values[c.key] ?? ''} onChange={(e) => setValues({ ...values, [c.key]: e.target.value })} />
                ) : (
                  <Input id={id} disabled={!editable} value={values[c.key] ?? ''} placeholder={c.key === 'sku' ? (row.sku ?? 'gerado pelo sistema') : ''} onChange={(e) => setValues({ ...values, [c.key]: e.target.value })} aria-invalid={errs.length > 0} />
                )
              }
            </Field>
          );
        })}
        {editable && (
          <div className="flex items-end sm:col-span-2 lg:col-span-3">
            <Button type="submit" variant="primary" busy={busy} disabled={!changed}>Salvar correção e reanalisar</Button>
          </div>
        )}
      </form>
    </div>
  );
}

function ImagesBySku() {
  const input = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<{ file: string; message: string; ok: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const list = [...files].map((f) => {
      const stem = f.name.replace(/\.[^.]+$/, '').trim();
      // Mais de uma foto do mesmo produto: SKU_2.jpg, SKU_3.jpg.
      return { file: f, sku: stem.replace(/_\d{1,2}$/, '').toUpperCase() };
    });
    const out: typeof log = [];
    try {
      const { targets } = await api<{ targets: { sku: string; product_id: string; name: string; image_count: number }[] }>('/admin/product-imports/image-targets', { method: 'POST', body: { skus: [...new Set(list.map((l) => l.sku))].filter((s) => s.length >= 2).slice(0, 500) } });
      const bySku = new Map(targets.map((t) => [t.sku.toUpperCase(), t]));
      for (const l of list) {
        const t = bySku.get(l.sku);
        if (!t) out.push({ file: l.file.name, message: `SKU ${l.sku} não encontrado. Nada foi enviado.`, ok: false });
        else if (t.image_count > 0) out.push({ file: l.file.name, message: `"${t.name}" já tinha foto; nada foi trocado.`, ok: false });
        else {
          try {
            await upload(`/admin/products/${t.product_id}/images`, l.file);
            out.push({ file: l.file.name, message: `Enviada para "${t.name}".`, ok: true });
          } catch (e) {
            out.push({ file: l.file.name, message: e instanceof Error ? e.message : 'Falha no envio.', ok: false });
          }
        }
        setLog([...out]);
      }
    } catch (e) {
      out.push({ file: '', message: e instanceof Error ? e.message : 'Falha.', ok: false });
      setLog(out);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Panel title="Imagens em lote por SKU" description="Nomeie cada foto com o SKU do produto (COP-DES-300ML.jpg; mais fotos: COP-DES-300ML_2.jpg). Só recebe foto o produto que ainda não tem nenhuma.">
      <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void run(e.target.files)} />
      <Button busy={busy} onClick={() => input.current?.click()}><ImagePlus size={16} aria-hidden /> Escolher fotos</Button>
      {log.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {log.map((l, i) => (
            <li key={i} className={l.ok ? 'text-good' : 'text-ink-soft'}>{l.file && <span className="font-mono text-xs">{l.file}: </span>}{l.message}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ImportDetail() {
  const { id } = useParams<{ id: string }>();
  const [imp, setImp] = useState<ImportSummary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [columns, setColumns] = useState<GuideColumn[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const pageSize = 50;

  const load = useCallback(async () => {
    const r = await api<{ import: ImportSummary; rows: Row[]; total: number }>(`/admin/product-imports/${id}?filter=${filter}&page=${page}&pageSize=${pageSize}`);
    setImp(r.import);
    setRows(r.rows);
    setTotal(r.total);
  }, [id, filter, page]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    api<{ columns: GuideColumn[]; categories: Category[] }>('/admin/product-imports/guide').then((g) => {
      setColumns(g.columns);
      setCategories(g.categories);
    }, () => undefined);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha.');
    }
  };

  const process = async () => {
    setRunning(true);
    setError('');
    try {
      for (;;) {
        const r = await api<{ import: ImportSummary; progress: { total: number; processed: number; done: boolean } }>(`/admin/product-imports/${id}/process`, { method: 'POST', body: { batchSize: 50 } });
        setImp(r.import);
        setProgress(r.progress);
        if (r.progress.done) break;
      }
      setFilter('all');
      setPage(1);
      await load();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : 'Falha.'} O lote que estava em andamento foi desfeito por inteiro; clique em continuar para retomar de onde parou.`);
      await load().catch(() => undefined);
    } finally {
      setRunning(false);
    }
  };

  if (!imp) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-soft">Carregando…</p>;

  const t = imp.totals;
  const res = imp.results;
  const reviewing = imp.status === 'analyzed';
  const pathOf = (c: Category): string => {
    const p = c.parent_id ? categories.find((x) => x.id === c.parent_id) : undefined;
    return p ? `${pathOf(p)} › ${c.name}` : c.name;
  };
  const ready = t.new ?? 0;
  const pct = progress && progress.total ? Math.round((progress.processed / progress.total) * 100) : imp.status === 'done' ? 100 : 0;
  const filters = reviewing ? FILTERS_REVIEW : FILTERS_DONE;

  return (
    <>
      <PageHeader
        title={imp.file_name}
        description={<>Enviada em {when(imp.created_at)} por {imp.created_by_name}{imp.confirmed_at && <> · confirmada em {when(imp.confirmed_at)} por {imp.confirmed_by_name}</>}</>}
        actions={
          <>
            <Link href="/painel/produtos/importar"><Button variant="ghost">Voltar</Button></Link>
            <a href={`/api/v1/admin/product-imports/${id}/report.xlsx`}><Button><Download size={16} aria-hidden /> Relatório .xlsx</Button></a>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={IMPORT_STATUS[imp.status]!.tone}>{IMPORT_STATUS[imp.status]!.label}</Badge>
        {reviewing && <span className="text-sm text-ink-soft">Nada foi cadastrado ainda. Revise e confirme.</span>}
      </div>
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {imp.warnings.map((w, i) => (
        <div key={i} className="mb-2"><Notice tone="warn">{w}</Notice></div>
      ))}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Linhas" value={t.rows} />
        <Stat label="Novos" value={t.new} tone="text-good" />
        <Stat label="Já existem" value={t.existing} />
        <Stat label="Possíveis duplicados" value={t.duplicate} tone="text-warn" />
        <Stat label="Com erro" value={t.error} tone="text-bad" />
        <Stat label="Incompletos" value={t.incomplete} tone="text-bad" />
        <Stat label="Categoria pendente" value={t.category} tone="text-warn" />
      </div>
      {!reviewing && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Cadastrados" value={res.imported} tone="text-good" />
          <Stat label="Ignorados" value={res.skipped} />
          <Stat label="Não cadastrados" value={res.failed} tone="text-bad" />
          <Stat label="Cadastrados sem imagem" value={res.withoutImage} tone="text-warn" />
        </div>
      )}

      {reviewing && imp.pending_categories.length > 0 && (
        <Panel className="mb-4" title="Categorias que não existem" description="Escolha uma categoria existente ou autorize criar. Nada é criado antes da confirmação.">
          <ul className="space-y-3">
            {imp.pending_categories.map((p: PendingCategory) => {
              const label = p.subcategory ? `${p.category} › ${p.subcategory}` : p.category;
              const value = p.decision ? (p.decision.action === 'create' ? 'create' : p.decision.categoryId) : '';
              return (
                <li key={p.key} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-48 text-sm"><span className="font-medium">{label}</span> <span className="text-ink-faint">({p.rows} linha{p.rows > 1 ? 's' : ''})</span></span>
                  <Select
                    aria-label={`Destino de ${label}`}
                    className="max-w-sm"
                    value={value}
                    onChange={(e) => {
                      const v = e.target.value;
                      void act(() => api(`/admin/product-imports/${id}/categories`, { method: 'PUT', body: { decisions: { [p.key]: v === '' ? null : v === 'create' ? { action: 'create' } : { action: 'map', categoryId: v } } } }));
                    }}
                  >
                    <option value="">Decidir…</option>
                    <option value="create">Criar {p.parentId ? `“${p.subcategory}” dentro da existente` : `“${label}”`}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>Usar: {pathOf(c)}</option>
                    ))}
                  </Select>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {(reviewing || imp.status === 'importing') && (
        <Panel className="mb-4" title={imp.status === 'importing' ? 'Importação em andamento' : 'Confirmar importação'}>
          {running || imp.status === 'importing' ? (
            <div className="space-y-2">
              <div className="h-2.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-act transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-sm text-ink-soft">{progress ? `${progress.processed} de ${progress.total} linhas processadas` : `${res.imported} cadastrado(s), ${res.pending} na fila`}</p>
              {!running && <Button variant="primary" onClick={() => void process()}>Continuar importação</Button>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={!ready}
                onClick={() => {
                  if (window.confirm(`Cadastrar ${ready} produto(s) novo(s)? Linhas com erro, já existentes, duplicados não aprovados e categorias sem decisão serão ignoradas.`)) void process();
                }}
              >
                Confirmar e cadastrar {ready} produto(s)
              </Button>
              <Button variant="ghost" onClick={() => window.confirm('Descartar esta análise? Nada foi cadastrado.') && void act(() => api(`/admin/product-imports/${id}/cancel`, { method: 'POST', body: {} }))}>Descartar</Button>
              <span className="text-sm text-ink-soft">O cadastro é feito em lotes; um lote interrompido é desfeito por inteiro e pode ser retomado.</span>
            </div>
          )}
        </Panel>
      )}

      {imp.status === 'done' && (
        <div className="mb-4 space-y-4">
          <Notice tone="good">
            Importação concluída: {res.imported} cadastrado(s), {res.skipped} ignorado(s), {res.failed} não cadastrado(s).
            {res.withoutImage > 0 && ` ${res.withoutImage} produto(s) sem imagem.`} <Link className="underline" href="/painel/produtos">Ver produtos</Link>
          </Notice>
          {res.withoutImage > 0 && <ImagesBySku />}
        </div>
      )}

      <div className="mb-2 flex flex-wrap gap-1" role="tablist">
        {filters.map(([k, label]) => (
          <Button key={k} variant={filter === k ? 'primary' : 'ghost'} role="tab" aria-selected={filter === k} onClick={() => { setFilter(k); setPage(1); setOpen(null); }}>
            {label}
          </Button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-card">
        {rows.length === 0 ? (
          <Empty title="Nenhuma linha neste filtro." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Linha</th>
                  <th className="py-2 font-medium">Produto</th>
                  <th className="py-2 font-medium">SKU</th>
                  <th className="py-2 font-medium">Categoria</th>
                  <th className="py-2 text-right font-medium">Preço</th>
                  <th className="py-2 pl-4 font-medium">Situação</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const st = r.result ? ROW_RESULT[r.result] : ROW_STATUS[r.status];
                  const first = r.issues.find((i) => i.level !== 'warning')?.message ?? r.matches[0]?.message ?? r.issues[0]?.message;
                  const cat = r.data?.categoryPath?.join(' › ') ?? [r.raw.category, r.raw.subcategory].filter(Boolean).join(' › ');
                  return (
                    <FragmentRow key={r.row_number} open={open === r.row_number}>
                      <tr className="align-top hover:bg-sunken/40">
                        <td className="num py-2 pl-4 text-ink-soft">{r.row_number}</td>
                        <td className="py-2 pr-3">
                          <span className="block font-medium">{r.data?.name ?? r.raw.name ?? <span className="text-ink-faint">(sem nome)</span>}</span>
                          {(r.result_reason || first) && <span className="block text-xs text-ink-soft">{r.result_reason ?? first}</span>}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {r.sku ?? '—'}
                          {r.sku_generated && <span className="ml-1"><Badge>gerado</Badge></span>}
                        </td>
                        <td className="py-2 pr-3 text-ink-soft">{cat || '—'}{r.data?.categoryCreate && <span className="ml-1"><Badge tone="act">nova</Badge></span>}</td>
                        <td className="num py-2 text-right">{r.data ? money(r.data.priceCents) : (r.raw.price ?? '—')}</td>
                        <td className="py-2 pl-4">
                          <span className="flex flex-wrap gap-1">
                            {st && <Badge tone={st.tone}>{st.label}</Badge>}
                            {r.decision === 'approve' && <Badge tone="act">aprovado</Badge>}
                            {r.decision === 'skip' && <Badge>ignorar</Badge>}
                            {r.without_image && <Badge tone="warn">sem imagem</Badge>}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {r.product_id ? (
                            <Link className="text-sm underline" href={`/painel/produtos/${r.product_id}`}>Abrir</Link>
                          ) : (
                            <Button variant="ghost" onClick={() => setOpen(open === r.row_number ? null : r.row_number)}>{open === r.row_number ? 'Fechar' : reviewing ? 'Ver e corrigir' : 'Ver'}</Button>
                          )}
                        </td>
                      </tr>
                      {open === r.row_number && columns.length > 0 && (
                        <tr>
                          <td colSpan={7} className="p-0">
                            <RowEditor
                              key={JSON.stringify(r.raw)}
                              row={r}
                              columns={columns}
                              editable={reviewing}
                              onSave={(values) => act(() => api(`/admin/product-imports/${id}/rows/${r.row_number}`, { method: 'PATCH', body: { values } }))}
                              onDecision={(decision) => act(() => api(`/admin/product-imports/${id}/rows/${r.row_number}`, { method: 'PATCH', body: { decision } }))}
                            />
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {total > pageSize && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</Button>
          <span className="text-ink-soft">Página {page} de {Math.ceil(total / pageSize)} · {total} linhas</span>
          <Button variant="ghost" disabled={page * pageSize >= total} onClick={() => setPage(page + 1)}>Próxima</Button>
        </div>
      )}
    </>
  );
}

function FragmentRow({ children }: { open: boolean; children: React.ReactNode }) {
  return <>{children}</>;
}

export default function Page() {
  return (
    <Guard perm="catalog.import">
      <ImportDetail />
    </Guard>
  );
}
