'use client';

import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Guard } from '@/components/shell';
import { Badge, Button, Empty, Notice, PageHeader, Panel } from '@/components/ui';
import { api, upload } from '@/lib/api';
import { when } from '@/lib/format';
import { IMPORT_STATUS, type ImportSummary } from '@/lib/imports';

type Guide = {
  columns: { key: string; header: string; required: boolean; format: string; example: string }[];
  units: { code: string; name: string; allows_fraction: boolean }[];
  categories: { id: string; parent_id: string | null; name: string; active: boolean }[];
  limits: { maxBytes: number; maxRows: number };
};

function ImportHome() {
  const router = useRouter();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [history, setHistory] = useState<ImportSummary[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Guide>('/admin/product-imports/guide').then(setGuide, (e) => setError(e.message));
    api<{ imports: ImportSummary[] }>('/admin/product-imports?pageSize=30').then((r) => setHistory(r.imports), () => setHistory([]));
  }, []);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!/\.xlsx$/i.test(file.name)) return setError('Envie um arquivo .xlsx (Excel). Arquivos .xls, .xlsm e .csv não são aceitos.');
    if (guide && file.size > guide.limits.maxBytes) return setError('A planilha deve ter no máximo 5 MB.');
    setBusy(true);
    try {
      const res = await upload<{ import: { id: string } }>('/admin/product-imports', file);
      router.push(`/painel/produtos/importar/${res.import.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao enviar.');
      setBusy(false);
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  const roots = guide?.categories.filter((c) => !c.parent_id) ?? [];
  const children = (id: string) => guide?.categories.filter((c) => c.parent_id === id) ?? [];

  return (
    <>
      <PageHeader
        title="Importar produtos via Excel"
        description="Cadastre muitos produtos de uma vez. Você envia a planilha, confere a prévia e só depois confirma: nada é cadastrado antes disso."
        actions={<Link href="/painel/produtos"><Button variant="ghost">Voltar aos produtos</Button></Link>}
      />
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="1. Baixe o modelo oficial" description="Já vem com as categorias e unidades atuais em listas suspensas e uma aba de instruções.">
          <a href="/api/v1/admin/product-imports/template.xlsx" download>
            <Button variant="secondary"><Download size={16} aria-hidden /> Baixar modelo .xlsx</Button>
          </a>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            <li>Linha 1: cabeçalhos (não altere). Linha 2: exemplo, ignorado. Produtos a partir da linha 3.</li>
            <li>Sem fórmulas: células com fórmula são descartadas. Cole como valores.</li>
            <li>SKU em branco: o sistema gera a partir do nome (Copo Descartável 300ml → COP-DES-300ML).</li>
          </ul>
        </Panel>
        <Panel title="2. Envie a planilha preenchida" description={`Arquivo .xlsx de até 5 MB e ${guide?.limits.maxRows ?? 2000} produtos.`}>
          <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" id="import-file" onChange={(e) => void send(e.target.files?.[0])} />
          <Button variant="primary" busy={busy} onClick={() => input.current?.click()}><Upload size={16} aria-hidden /> Escolher arquivo e analisar</Button>
          <p className="mt-3 text-sm text-ink-soft">A análise confere obrigatórios, formatos, SKU e EAN já cadastrados, nomes parecidos e categorias que não existem.</p>
        </Panel>
      </div>

      <Panel className="mt-4" title="Campos da planilha" description="Preço, custo, estoque, estoque mínimo e peso valem para a unidade de venda escolhida (por exemplo, o pacote).">
        {!guide ? (
          <p className="text-sm text-ink-soft">Carregando…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-ink-soft">
                <tr><th className="py-1.5 pr-3 font-medium">Coluna</th><th className="py-1.5 pr-3 font-medium">Obrigatória</th><th className="py-1.5 pr-3 font-medium">Formato</th><th className="py-1.5 font-medium">Exemplo</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {guide.columns.map((c) => (
                  <tr key={c.key}>
                    <td className="py-1.5 pr-3 font-medium">{c.header}</td>
                    <td className="py-1.5 pr-3">{c.required ? <Badge tone="warn">Sim</Badge> : <span className="text-ink-faint">Não</span>}</td>
                    <td className="py-1.5 pr-3 text-ink-soft">{c.format}</td>
                    <td className="py-1.5 text-ink-faint">{c.example.replace(/^Exemplo: /, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm text-ink-soft">Preço promocional, palavras-chave e observações internas não existem no cadastro atual e não fazem parte do modelo. Imagens são enviadas depois, pelo SKU.</p>
          </div>
        )}
      </Panel>

      {guide && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title="Unidades de venda">
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {guide.units.map((u) => (
                <li key={u.code}><span className="font-mono text-xs">{u.code}</span> {u.name}{u.allows_fraction && <span className="text-ink-faint"> (fração)</span>}</li>
              ))}
            </ul>
          </Panel>
          <Panel title="Categorias cadastradas" description="Categoria que não existir aparece na prévia para você escolher uma existente ou autorizar criar.">
            {roots.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma categoria ainda. <Link className="underline" href="/painel/categorias">Cadastrar categorias</Link></p>
            ) : (
              <ul className="space-y-1 text-sm">
                {roots.map((r) => (
                  <li key={r.id}>
                    <span className="font-medium">{r.name}</span>
                    {children(r.id).length > 0 && <span className="text-ink-soft"> › {children(r.id).map((s) => s.name).join(', ')}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      <Panel className="mt-4" title="Histórico de importações">
        {!history ? (
          <p className="text-sm text-ink-soft">Carregando…</p>
        ) : history.length === 0 ? (
          <Empty title="Nenhuma importação ainda." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Arquivo</th>
                  <th className="py-1.5 pr-3 font-medium">Enviado</th>
                  <th className="py-1.5 pr-3 font-medium">Usuário</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Cadastrados</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Ignorados</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Com erro</th>
                  <th className="py-1.5 pr-3 font-medium">Situação</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="py-2 pr-3">
                      <Link href={`/painel/produtos/importar/${h.id}`} className="inline-flex items-center gap-1.5 font-medium hover:underline"><FileSpreadsheet size={15} aria-hidden />{h.file_name}</Link>
                    </td>
                    <td className="py-2 pr-3 text-ink-soft">{when(h.created_at)}</td>
                    <td className="py-2 pr-3 text-ink-soft">{h.created_by_name}</td>
                    <td className="num py-2 pr-3 text-right">{h.results.imported}</td>
                    <td className="num py-2 pr-3 text-right">{h.results.skipped}</td>
                    <td className="num py-2 pr-3 text-right">{h.status === 'analyzed' ? (h.totals.error ?? 0) + (h.totals.incomplete ?? 0) : h.results.failed}</td>
                    <td className="py-2 pr-3"><Badge tone={IMPORT_STATUS[h.status]!.tone}>{IMPORT_STATUS[h.status]!.label}</Badge></td>
                    <td className="py-2 text-right"><a className="text-sm underline" href={`/api/v1/admin/product-imports/${h.id}/report.xlsx`}>Relatório</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="catalog.import">
      <ImportHome />
    </Guard>
  );
}
