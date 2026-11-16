'use client';

import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ProductEditor, toForm } from '@/components/product-form';
import { PHOTO_ISSUES_KEY, ProductImages } from '@/components/product-images';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Field, FISCAL_STATUS, Input, Notice, PageHeader, Panel, PRODUCT_STATUS, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money, ORIGINS, when } from '@/lib/format';

function PhotoIssues({ productId }: { productId: string }) {
  // Fotos escolhidas no cadastro que nao subiram (o produto ja tinha sido criado).
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    try {
      const key = `${PHOTO_ISSUES_KEY}:${productId}`;
      const raw = sessionStorage.getItem(key);
      if (raw) {
        setIssues(JSON.parse(raw));
        sessionStorage.removeItem(key);
      }
    } catch {}
  }, [productId]);
  if (!issues.length) return null;
  return (
    <Notice tone="warn">
      Produto criado, mas {issues.length === 1 ? 'uma foto não foi enviada' : `${issues.length} fotos não foram enviadas`}: {issues.join(' · ')}. Envie de novo abaixo.
    </Notice>
  );
}

function Fiscal({ product, reload }: { product: any; reload: () => void }) {
  const { can, me } = useMe();
  const f = product.fiscal ?? {};
  const [ncm, setNcm] = useState(f.ncm ?? '');
  const [cest, setCest] = useState(f.cest ?? '');
  const [origin, setOrigin] = useState(f.origin === null || f.origin === undefined ? '' : String(f.origin));
  const [taxUnit, setTaxUnit] = useState(f.tax_unit ?? '');
  const [notes, setNotes] = useState(f.notes ?? '');
  const [validator, setValidator] = useState('');
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const status = FISCAL_STATUS[f.status ?? 'pending']!;
  const canEdit = can('fiscal.manage') && me.user.mfaEnabled;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/admin/products/${product.id}/fiscal`, { method: 'PUT', body: { ncm: ncm || null, cest: cest || null, origin: origin === '' ? null : Number(origin), taxUnit: taxUnit || null, notes: notes || null } });
      setMsg({ tone: 'good', text: 'Dados fiscais gravados.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    }
  };
  const validate = async () => {
    try {
      await api(`/admin/products/${product.id}/fiscal/validate`, { method: 'POST', body: { validatorName: validator } });
      setMsg({ tone: 'good', text: 'Classificação validada.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    }
  };

  return (
    <Panel
      title="Classificação fiscal"
      description="Informada pela empresa e validada pelo contador. O sistema confere o formato, não o enquadramento. Mudar qualquer campo derruba a validação."
      actions={<Badge tone={status.tone}>{status.label}</Badge>}
    >
      {f.status === 'validated' && <p className="mb-3 text-sm text-good">Validado por {f.validator_name} em {when(f.validated_at)}.</p>}
      {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {!can('fiscal.view') ? (
        <p className="text-sm text-ink-soft">Sem permissão para ver os dados fiscais.</p>
      ) : (
        <form onSubmit={save}>
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-4">
            <Field label="NCM" hint="8 dígitos.">{(id) => <Input id={id} inputMode="numeric" maxLength={8} className="num" value={ncm} onChange={(e) => setNcm(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label="CEST" hint="Quando aplicável.">{(id) => <Input id={id} inputMode="numeric" maxLength={7} className="num" value={cest} onChange={(e) => setCest(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label="Origem" className="sm:col-span-2">
              {(id) => (
                <Select id={id} value={origin} onChange={(e) => setOrigin(e.target.value)}>
                  <option value="">Não informada</option>
                  {ORIGINS.map((o, i) => (
                    <option key={i} value={i}>{o}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Unidade tributável" hint="Código usado na NF-e, se diferente da comercial.">{(id) => <Input id={id} maxLength={6} value={taxUnit} onChange={(e) => setTaxUnit(e.target.value.toUpperCase())} />}</Field>
            <Field label="Observações para o contador" className="sm:col-span-3">{(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
            {canEdit && (
              <div className="sm:col-span-4">
                <Button type="submit">Gravar dados fiscais</Button>
              </div>
            )}
          </fieldset>
          {!canEdit && can('fiscal.manage') && <p className="mt-2 text-[13px] text-ink-faint">Ative a verificação em duas etapas para alterar.</p>}
        </form>
      )}
      {can('fiscal.validate') && f.status === 'informed' && (
        <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-4">
          <Field label="Validado por (nome do contador)" className="min-w-64 flex-1">{(id) => <Input id={id} value={validator} onChange={(e) => setValidator(e.target.value)} />}</Field>
          <Button type="button" variant="primary" disabled={validator.trim().length < 3} onClick={validate}>Validar classificação</Button>
        </div>
      )}
      <p className="mt-4 text-[13px] text-ink-faint">CFOP, CST/CSOSN, ICMS, PIS, COFINS e IPI são definidos por regra de operação na Fase 5, com o contador.</p>
    </Panel>
  );
}

function ProductPage() {
  const { can } = useMe();
  const canManage = can('catalog.manage');
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ product: any; priceHistory: any[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api(`/admin/products/${id}`).then(setData, (e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  const form = useMemo(() => (data ? toForm(data.product) : null), [data]);
  const labels = useMemo(() => new Map<string, string>(data?.product.variants.flatMap((v: any) => v.packagings.map((k: any) => [k.id, `${v.sku} · ${k.label}`])) ?? []), [data]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data || !form) return <p className="text-sm text-ink-faint">Carregando…</p>;
  const p = data.product;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/painel/produtos" className="text-ink-soft hover:underline">← Produtos</Link>
      </p>
      <PageHeader title={p.name} actions={<Badge tone={PRODUCT_STATUS[p.status]!.tone}>{PRODUCT_STATUS[p.status]!.label}</Badge>} />
      <div className="space-y-4">
        <PhotoIssues productId={p.id} />
        <ProductImages key={p.id} productId={p.id} images={p.images} editable={canManage} />
        <ProductEditor initial={form} onSaved={() => void load()} />
        <Fiscal key={p.fiscal?.informed_at ?? 'f'} product={p} reload={load} />
        <Panel title="Histórico de preços">
          {data.priceHistory.length === 0 ? (
            <p className="text-sm text-ink-soft">Sem registros.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {data.priceHistory.map((h, i) => (
                  <tr key={i}>
                    <td className="py-1.5">{labels.get(h.packaging_id) ?? 'Embalagem removida'}</td>
                    <td className="num py-1.5 text-right">{h.old_price_cents ? `${money(h.old_price_cents)} → ` : ''}{money(h.new_price_cents)}</td>
                    <td className="hidden py-1.5 pl-4 text-ink-soft sm:table-cell">{h.changed_by ?? '—'}</td>
                    <td className="num py-1.5 pl-4 text-right text-ink-soft">{when(h.changed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="catalog.view">
      <ProductPage />
    </Guard>
  );
}
