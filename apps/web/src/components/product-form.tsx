'use client';

import { Plus, Star, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { centsToInput, money, parseMoney, parseQty, qty, qtyToInput } from '@/lib/format';

type Unit = { code: string; name: string; allows_fraction: boolean };
type Category = { id: string; name: string; parent_id: string | null };
type Tier = { minPacks: string; price: string };
type Pack = { id?: string; kind: 'sale' | 'purchase'; label: string; unitCode: string; baseQty: string; price: string; barcode: string; isDefault: boolean; tiers: Tier[] };
type Variant = { id?: string; sku: string; barcode: string; attrs: { key: string; value: string }[]; weightG: string; packagings: Pack[] };
export type ProductForm = {
  id?: string;
  version?: number;
  name: string;
  slug: string;
  categoryId: string;
  summary: string;
  description: string;
  brand: string;
  status: 'draft' | 'active' | 'inactive';
  baseUnit: string;
  turnover: string;
  availabilityMode: 'stock' | 'made_to_order';
  leadTimeDays: string;
  minStock: string;
  specs: { label: string; value: string }[];
  variants: Variant[];
};

export const emptyProduct = (): ProductForm => ({
  name: '',
  slug: '',
  categoryId: '',
  summary: '',
  description: '',
  brand: '',
  status: 'draft',
  baseUnit: 'UN',
  turnover: '',
  availabilityMode: 'stock',
  leadTimeDays: '',
  minStock: '0',
  specs: [],
  variants: [{ sku: '', barcode: '', attrs: [], weightG: '', packagings: [{ kind: 'sale', label: 'Unidade', unitCode: 'UN', baseQty: '1', price: '', barcode: '', isDefault: true, tiers: [] }] }],
});

/** Produto da API para o formulario. */
export function toForm(p: any): ProductForm {
  return {
    id: p.id,
    version: p.version,
    name: p.name,
    slug: p.slug,
    categoryId: p.category_id ?? '',
    summary: p.summary ?? '',
    description: p.description ?? '',
    brand: p.brand ?? '',
    status: p.status,
    baseUnit: p.base_unit,
    turnover: p.turnover ?? '',
    availabilityMode: p.availability_mode,
    leadTimeDays: p.lead_time_days ? String(p.lead_time_days) : '',
    minStock: qtyToInput(p.min_stock),
    specs: p.specs,
    variants: p.variants
      .filter((v: any) => v.active)
      .map((v: any) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode ?? '',
        attrs: Object.entries(v.attributes as Record<string, string>).map(([key, value]) => ({ key, value })),
        weightG: v.weight_g ? String(v.weight_g) : '',
        packagings: v.packagings.map((k: any) => ({ id: k.id, kind: k.kind, label: k.label, unitCode: k.unit_code, baseQty: qtyToInput(k.base_qty), price: centsToInput(k.price_cents), barcode: k.barcode ?? '', isDefault: k.is_default, tiers: (k.tiers ?? []).map((t: any) => ({ minPacks: String(t.minPacks), price: centsToInput(t.priceCents) })) })),
      })),
  };
}

function toPayload(f: ProductForm) {
  return {
    ...(f.version ? { version: f.version } : {}),
    name: f.name,
    ...(f.slug ? { slug: f.slug } : {}),
    categoryId: f.categoryId || null,
    summary: f.summary || null,
    description: f.description || null,
    brand: f.brand || null,
    status: f.status,
    baseUnit: f.baseUnit,
    turnover: f.turnover || null,
    availabilityMode: f.availabilityMode,
    leadTimeDays: f.availabilityMode === 'made_to_order' && f.leadTimeDays ? Number(f.leadTimeDays) : null,
    minStock: parseQty(f.minStock || '0'),
    specs: f.specs.filter((s) => s.label.trim() && s.value.trim()),
    variants: f.variants.map((v) => ({
      ...(v.id ? { id: v.id } : {}),
      sku: v.sku.trim(),
      barcode: v.barcode.trim() || null,
      attributes: Object.fromEntries(v.attrs.filter((a) => a.key.trim() && a.value.trim()).map((a) => [a.key.trim(), a.value.trim()])),
      weightG: v.weightG ? Number(v.weightG) : null,
      packagings: v.packagings.map((k) => ({
        ...(k.id ? { id: k.id } : {}),
        kind: k.kind,
        label: k.label.trim(),
        unitCode: k.unitCode,
        baseQty: parseQty(k.baseQty),
        priceCents: k.kind === 'sale' ? parseMoney(k.price) : null,
        barcode: k.barcode.trim() || null,
        isDefault: k.isDefault,
        tiers: k.kind === 'sale' ? k.tiers.filter((t) => t.minPacks && t.price).map((t) => ({ minPacks: Number(t.minPacks), priceCents: parseMoney(t.price) })) : [],
      })),
    })),
  };
}

export function ProductEditor({ initial, onSaved }: { initial: ProductForm; onSaved?: (p: any) => void }) {
  const router = useRouter();
  const { can, me } = useMe();
  const [f, setF] = useState<ProductForm>(initial);
  const [units, setUnits] = useState<Unit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const editable = can('catalog.manage');
  // Preco existente so muda com a permissao de precos (e MFA). Preco novo acompanha o cadastro.
  const canPrice = can('prices.manage') && me.user.mfaEnabled;

  useEffect(() => setF(initial), [initial]);
  useEffect(() => {
    api('/admin/products/units').then((r) => setUnits(r.units));
    api('/admin/categories').then((r) => setCategories(r.categories));
  }, []);

  const base = units.find((u) => u.code === f.baseUnit);
  const categoryOptions = useMemo(() => {
    const byParent = (pid: string | null, depth: number): { id: string; label: string }[] =>
      categories.filter((c) => c.parent_id === pid).flatMap((c) => [{ id: c.id, label: `${'— '.repeat(depth)}${c.name}` }, ...byParent(c.id, depth + 1)]);
    return byParent(null, 0);
  }, [categories]);

  const set = <K extends keyof ProductForm>(k: K, v: ProductForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const setVariant = (i: number, patch: Partial<Variant>) => setF((s) => ({ ...s, variants: s.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
  const setPack = (vi: number, pi: number, patch: Partial<Pack>) =>
    setF((s) => ({
      ...s,
      variants: s.variants.map((v, j) =>
        j !== vi
          ? v
          : {
              ...v,
              packagings: v.packagings.map((k, n) => {
                if (n === pi) return { ...k, ...patch };
                // Uma embalagem padrao por tipo.
                if (patch.isDefault && k.kind === v.packagings[pi]!.kind) return { ...k, isDefault: false };
                return k;
              }),
            },
      ),
    }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const body = toPayload(f);
      const res = f.id ? await api(`/admin/products/${f.id}`, { method: 'PUT', body }) : await api('/admin/products', { method: 'POST', body });
      setSaved('Produto salvo.');
      if (!f.id) router.replace(`/painel/produtos/${res.product.id}`);
      else {
        setF(toForm(res.product));
        onSaved?.(res.product);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={!editable} className="space-y-4">
        <Panel title="Dados do produto">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" required className="sm:col-span-2">
              {(id) => <Input id={id} required maxLength={150} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Forminha de papel nº 5" />}
            </Field>
            <Field label="Categoria">
              {(id) => (
                <Select id={id} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                  <option value="">Sem categoria</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Marca">{(id) => <Input id={id} maxLength={80} value={f.brand} onChange={(e) => set('brand', e.target.value)} />}</Field>
            <Field label="Resumo" hint="Uma linha, aparece na vitrine e na busca." className="sm:col-span-2">
              {(id) => <Input id={id} maxLength={300} value={f.summary} onChange={(e) => set('summary', e.target.value)} />}
            </Field>
            <Field label="Descrição" className="sm:col-span-2">{(id) => <Textarea id={id} maxLength={10000} rows={5} value={f.description} onChange={(e) => set('description', e.target.value)} />}</Field>
            <Field label="Situação">
              {(id) => (
                <Select id={id} value={f.status} onChange={(e) => set('status', e.target.value as ProductForm['status'])}>
                  <option value="draft">Rascunho (não aparece na loja)</option>
                  <option value="active">Ativo</option>
                  <option value="inactive">Inativo</option>
                </Select>
              )}
            </Field>
            <Field label="Endereço na loja (slug)" hint="Gerado do nome quando vazio.">
              {(id) => <Input id={id} maxLength={160} value={f.slug} onChange={(e) => set('slug', e.target.value)} placeholder="forminha-de-papel-n-5" />}
            </Field>
          </div>
        </Panel>

        <Panel title="Estoque e disponibilidade" description="O estoque é contado na unidade base. Cada embalagem informa quantas unidades base contém.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Unidade base" required hint={f.id && initial.status !== 'draft' ? 'Só muda enquanto o produto é rascunho.' : base?.allows_fraction ? 'Aceita quantidades fracionadas.' : 'Somente quantidades inteiras.'}>
              {(id) => (
                <Select id={id} value={f.baseUnit} onChange={(e) => set('baseUnit', e.target.value)} disabled={Boolean(f.id && initial.status !== 'draft')}>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>{u.name} ({u.code})</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Estoque mínimo" hint={`Em ${f.baseUnit}. Gera alerta na Fase 3.`}>
              {(id) => <Input id={id} inputMode="decimal" value={f.minStock} onChange={(e) => set('minStock', e.target.value)} />}
            </Field>
            <Field label="Giro" hint="Orienta a reposição.">
              {(id) => (
                <Select id={id} value={f.turnover} onChange={(e) => set('turnover', e.target.value)}>
                  <option value="">Ainda não definido</option>
                  <option value="high">Alto: manter estoque de segurança</option>
                  <option value="medium">Médio: repor conforme demanda</option>
                  <option value="low">Baixo: comprar sob encomenda</option>
                </Select>
              )}
            </Field>
            <Field label="Disponibilidade">
              {(id) => (
                <Select id={id} value={f.availabilityMode} onChange={(e) => set('availabilityMode', e.target.value as ProductForm['availabilityMode'])}>
                  <option value="stock">Pronta entrega (conforme estoque)</option>
                  <option value="made_to_order">Sob encomenda</option>
                </Select>
              )}
            </Field>
            {f.availabilityMode === 'made_to_order' && (
              <Field label="Prazo estimado (dias)" hint="Só informe com estimativa confiável do fornecedor. Vazio: a loja diz que o prazo é confirmado depois.">
                {(id) => <Input id={id} type="number" min={1} max={180} value={f.leadTimeDays} onChange={(e) => set('leadTimeDays', e.target.value)} />}
              </Field>
            )}
          </div>
        </Panel>

        {f.variants.map((v, vi) => (
          <Panel
            key={v.id ?? `n${vi}`}
            title={f.variants.length > 1 ? `Variação ${vi + 1}` : 'SKU e embalagens'}
            description="Venda: como o cliente compra (unidade, pacote, caixa), cada uma com preço. Compra: como chega do fornecedor."
            actions={
              f.variants.length > 1 && (
                <Button type="button" variant="ghost" onClick={() => set('variants', f.variants.filter((_, j) => j !== vi))} aria-label={`Remover variação ${vi + 1}`}>
                  <Trash2 size={15} /> Remover
                </Button>
              )
            }
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="SKU" required hint="Código interno único.">
                {(id) => <Input id={id} required className="font-mono uppercase" value={v.sku} onChange={(e) => setVariant(vi, { sku: e.target.value.toUpperCase() })} />}
              </Field>
              <Field label="Código de barras (GTIN)" hint="Quando houver.">{(id) => <Input id={id} inputMode="numeric" value={v.barcode} onChange={(e) => setVariant(vi, { barcode: e.target.value.replace(/\D/g, '') })} />}</Field>
              <Field label="Peso da unidade base (g)" hint="Para o cálculo do frete.">{(id) => <Input id={id} type="number" min={1} value={v.weightG} onChange={(e) => setVariant(vi, { weightG: e.target.value })} />}</Field>
            </div>

            {f.variants.length > 1 || v.attrs.length > 0 ? (
              <div className="mt-4">
                <p className="mb-1.5 text-sm font-medium">Atributos da variação</p>
                <div className="space-y-2">
                  {v.attrs.map((a, ai) => (
                    <div key={ai} className="flex gap-2">
                      <Input aria-label="Atributo" placeholder="Cor" value={a.key} onChange={(e) => setVariant(vi, { attrs: v.attrs.map((x, j) => (j === ai ? { ...x, key: e.target.value } : x)) })} className="max-w-40" />
                      <Input aria-label="Valor" placeholder="Branco" value={a.value} onChange={(e) => setVariant(vi, { attrs: v.attrs.map((x, j) => (j === ai ? { ...x, value: e.target.value } : x)) })} />
                      <Button type="button" variant="ghost" aria-label="Remover atributo" onClick={() => setVariant(vi, { attrs: v.attrs.filter((_, j) => j !== ai) })}>
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <Button type="button" variant="ghost" className="mt-2 -ml-2" onClick={() => setVariant(vi, { attrs: [...v.attrs, { key: '', value: '' }] })}>
              <Plus size={15} /> Atributo (cor, tamanho…)
            </Button>

            {(['sale', 'purchase'] as const).map((kind) => (
              <div key={kind} className="mt-5">
                <p className="mb-2 text-sm font-semibold">{kind === 'sale' ? 'Embalagens de venda' : 'Embalagens de compra'}</p>
                <div className="space-y-2">
                  {v.packagings.map((k, pi) =>
                    k.kind !== kind ? null : (
                      <div key={k.id ?? `n${pi}`} className="rounded-md border border-line p-2.5">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.4fr_0.9fr_0.8fr_0.9fr_auto] sm:items-end">
                        <Field label="Nome">{(id) => <Input id={id} required value={k.label} onChange={(e) => setPack(vi, pi, { label: e.target.value })} placeholder={kind === 'sale' ? 'Pacote com 50' : 'Caixa do fornecedor'} />}</Field>
                        <Field label="Unidade">
                          {(id) => (
                            <Select id={id} value={k.unitCode} onChange={(e) => setPack(vi, pi, { unitCode: e.target.value })}>
                              {units.map((u) => (
                                <option key={u.code} value={u.code}>{u.code}</option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        <Field label={`Contém (${f.baseUnit})`}>{(id) => <Input id={id} required inputMode="decimal" value={k.baseQty} onChange={(e) => setPack(vi, pi, { baseQty: e.target.value })} />}</Field>
                        {kind === 'sale' ? (
                          <Field
                            label="Preço (R$)"
                            hint={
                              parseMoney(k.price) && Number(parseQty(k.baseQty)) > 0
                                ? `${money(parseMoney(k.price)! / Number(parseQty(k.baseQty)))}/${f.baseUnit}`
                                : undefined
                            }
                          >
                            {(id) => <Input id={id} required inputMode="decimal" className="num" value={k.price} disabled={Boolean(k.id) && !canPrice} onChange={(e) => setPack(vi, pi, { price: e.target.value })} />}
                          </Field>
                        ) : (
                          <p className="self-center text-[13px] text-ink-faint sm:pb-2">
                            {Number(parseQty(k.baseQty)) > 0 ? `1 ${k.unitCode} = ${qty(parseQty(k.baseQty))} ${f.baseUnit}` : ''}
                          </p>
                        )}
                        <div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
                          <Button type="button" variant="ghost" aria-pressed={k.isDefault} title="Embalagem padrão" onClick={() => setPack(vi, pi, { isDefault: true })}>
                            <Star size={15} className={k.isDefault ? 'fill-act text-act' : ''} />
                            <span className="sm:sr-only">Padrão</span>
                          </Button>
                          <Button type="button" variant="ghost" aria-label="Remover embalagem" onClick={() => setVariant(vi, { packagings: v.packagings.filter((_, j) => j !== pi) })}>
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      </div>
                      {kind === 'sale' && (
                        <TierEditor
                          tiers={k.tiers}
                          listPrice={parseMoney(k.price)}
                          disabled={Boolean(k.id) && !canPrice}
                          onChange={(tiers) => setPack(vi, pi, { tiers })}
                        />
                      )}
                      </div>
                    ),
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-1.5 -ml-2"
                  onClick={() => setVariant(vi, { packagings: [...v.packagings, { kind, label: '', unitCode: kind === 'sale' ? 'PCT' : 'CX', baseQty: '', price: '', barcode: '', isDefault: !v.packagings.some((x) => x.kind === kind), tiers: [] }] })}
                >
                  <Plus size={15} /> {kind === 'sale' ? 'Embalagem de venda' : 'Embalagem de compra'}
                </Button>
              </div>
            ))}
            {v.packagings.some((k) => k.id && k.kind === 'sale') && !canPrice && (
              <p className="mt-3 text-[13px] text-ink-faint">Preços já gravados só mudam com a permissão de preços e a verificação em duas etapas ativa.</p>
            )}
          </Panel>
        ))}

        <Button type="button" variant="secondary" onClick={() => set('variants', [...f.variants, { sku: '', barcode: '', attrs: [{ key: '', value: '' }], weightG: '', packagings: [{ kind: 'sale', label: 'Unidade', unitCode: f.baseUnit, baseQty: '1', price: '', barcode: '', isDefault: true, tiers: [] }] }])}>
          <Plus size={15} /> Adicionar variação (cor, tamanho…)
        </Button>

        <Panel title="Ficha técnica" description="Medidas, material, capacidade, uso indicado.">
          <div className="space-y-2">
            {f.specs.map((s, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label="Característica" placeholder="Material" value={s.label} onChange={(e) => set('specs', f.specs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="max-w-48" />
                <Input aria-label="Valor" placeholder="Papel cartão 300 g" value={s.value} onChange={(e) => set('specs', f.specs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <Button type="button" variant="ghost" aria-label="Remover característica" onClick={() => set('specs', f.specs.filter((_, j) => j !== i))}>
                  <Trash2 size={15} />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="ghost" className="mt-2 -ml-2" onClick={() => set('specs', [...f.specs, { label: '', value: '' }])}>
            <Plus size={15} /> Característica
          </Button>
        </Panel>
      </fieldset>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-page/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
        {error && <span className="mr-auto text-sm text-bad" role="alert">{error}</span>}
        {saved && !error && <span className="mr-auto"><Badge tone="good">{saved}</Badge></span>}
        {editable && (
          <Button type="submit" variant="primary" busy={busy}>
            {f.id ? 'Salvar alterações' : 'Cadastrar produto'}
          </Button>
        )}
      </div>
      {!editable && <Notice>Você pode consultar, mas não alterar o catálogo.</Notice>}
    </form>
  );
}

/** Preco por quantidade: a partir de N embalagens, cada uma sai por R$ X. */
function TierEditor({ tiers, listPrice, disabled, onChange }: { tiers: Tier[]; listPrice: number | null; disabled: boolean; onChange: (t: Tier[]) => void }) {
  const set = (i: number, patch: Partial<Tier>) => onChange(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="mt-2 border-t border-dashed border-line pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[13px] text-ink-soft">Preço por quantidade</span>
        {tiers.map((t, i) => {
          const price = parseMoney(t.price);
          const off = listPrice && price ? Math.round((1 - price / listPrice) * 100) : null;
          return (
            <span key={i} className="inline-flex items-center gap-1.5 rounded border border-line bg-sunken/40 px-2 py-1 text-[13px]">
              <span>a partir de</span>
              <Input aria-label="Quantidade mínima de embalagens" inputMode="numeric" className="h-7 w-16 num" value={t.minPacks} disabled={disabled} onChange={(e) => set(i, { minPacks: e.target.value.replace(/\D/g, '') })} />
              <span>emb., R$</span>
              <Input aria-label="Preço de cada embalagem nesta faixa" inputMode="decimal" className="h-7 w-20 num" value={t.price} disabled={disabled} onChange={(e) => set(i, { price: e.target.value })} />
              {off !== null && off > 0 && <span className="text-xs text-good">−{off}%</span>}
              {!disabled && (
                <button type="button" aria-label="Remover faixa" className="text-ink-faint hover:text-bad" onClick={() => onChange(tiers.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </button>
              )}
            </span>
          );
        })}
        {!disabled && tiers.length < 6 && (
          <Button type="button" variant="ghost" className="h-7 px-2 text-[13px]" onClick={() => onChange([...tiers, { minPacks: '', price: '' }])}>
            <Plus size={14} /> Faixa
          </Button>
        )}
        {tiers.length === 0 && disabled && <span className="text-[13px] text-ink-faint">nenhuma</span>}
      </div>
    </div>
  );
}
