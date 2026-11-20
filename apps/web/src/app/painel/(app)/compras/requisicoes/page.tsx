'use client';

// SGLog Fase 7 (D7-6, D7-7): requisicoes internas de compra. Quem precisa pede (purchases.request); quem compra
// consolida as abertas num rascunho de compra (purchases.manage), recusa com motivo ou cancela. As de encomenda nascem
// sozinhas (uma por encomenda) e viram vinculo da Fase 6 ao entrar na compra. Nada aqui mexe no estoque.
import Link from '@/components/painel-link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { WarehouseSelect } from '@/components/purchases';
import { Guard, useMe } from '@/components/shell';
import { packLabel, PackagingPicker, type PackagingHit } from '@/components/stock';
import { day, REQUEST_STATUS } from '@/components/supply';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { parseQty, qty, when } from '@/lib/format';

type Req = {
  id: string;
  number: number;
  source: 'manual' | 'backorder';
  status: string;
  variant_id: string;
  sku: string;
  product_name: string;
  base_unit: string;
  packaging_label: string | null;
  warehouse_id: string;
  warehouse_name: string;
  base_qty: string;
  reason: string;
  needed_by: string | null;
  order_number: number | null;
  purchase_order_id: string | null;
  purchase_order_number: number | null;
  decision_note: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  created_at: string;
  age_days: number;
  suggested_supplier_id: string | null;
  suggested_supplier_name: string | null;
};

function NewRequest({ onDone }: { onDone: () => void }) {
  const [pick, setPick] = useState<PackagingHit | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [forStock, setForStock] = useState(false);
  const [askStock, setAskStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!pick) return setError('Escolha o produto.');
    setBusy(true);
    try {
      await api(`/admin/purchase-requests`, {
        method: 'POST',
        body: {
          variantId: pick.variant_id,
          packagingId: pick.kind === 'purchase' ? pick.id : null,
          warehouseId: warehouseId || null,
          baseQty: parseQty(amount),
          reason: reason.trim(),
          neededBy: neededBy || null,
          ...(forStock ? { forStock: true } : {}),
        },
      });
      setPick(null);
      setAmount('');
      setReason('');
      setNeededBy('');
      setForStock(false);
      setAskStock('');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BACKORDER_REQUEST_EXISTS') setAskStock(err.message);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="new-request">
      {pick ? (
        <p className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-sunken/50 px-3 py-2 text-sm">
          <span>
            <span className="block font-medium">{pick.product_name}</span>
            <span className="block text-xs text-ink-faint">
              <span className="font-mono">{pick.sku}</span>
              {pick.kind === 'purchase' ? ` · ${packLabel(pick.label, pick.base_qty, pick.base_unit)}` : ''}
            </span>
          </span>
          <Button type="button" variant="ghost" onClick={() => setPick(null)}>
            Trocar
          </Button>
        </p>
      ) : (
        <PackagingPicker onPick={setPick} placeholder="Produto: nome, SKU ou código de barras" />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Quantidade${pick ? ` (${pick.base_unit})` : ''}`} required hint="Na unidade do produto; a compra arredonda para embalagens inteiras.">
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
        </Field>
        <Field label="Preciso até">{(id) => <Input id={id} type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />}</Field>
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        <Field label="Motivo" required>
          {(id) => <Input id={id} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: estoque acabando, evento da semana que vem" required />}
        </Field>
      </div>
      {askStock && (
        <Notice tone="warn">
          {askStock}
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={forStock} onChange={(e) => setForStock(e.target.checked)} />
            Sim, é para estoque, além da encomenda
          </label>
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <Button variant="primary" busy={busy} disabled={Boolean(askStock) && !forStock}>
        Pedir compra
      </Button>
    </form>
  );
}

type Supplier = { id: string; name: string };

function Convert({ selected, onDone }: { selected: Req[]; onDone: () => void }) {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [drafts, setDrafts] = useState<{ id: string; number: number; warehouse_id: string }[]>([]);
  const [target, setTarget] = useState('');
  const [minReason, setMinReason] = useState('');
  const [needMin, setNeedMin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/admin/suppliers?active=true&pageSize=100').then((r) => setSuppliers(r.items), () => null);
  }, []);
  const suggested = selected.find((r) => r.suggested_supplier_id)?.suggested_supplier_id ?? '';
  useEffect(() => {
    if (!supplierId && suggested) setSupplierId(suggested);
  }, [suggested, supplierId]);
  useEffect(() => {
    setTarget('');
    if (!supplierId) return setDrafts([]);
    api(`/admin/purchase-orders?status=draft&supplierId=${supplierId}&pageSize=50`).then((r) => setDrafts(r.items), () => setDrafts([]));
  }, [supplierId]);
  const warehouses = new Set(selected.map((r) => r.warehouse_id));
  const sameWarehouse = drafts.filter((d) => warehouses.size === 1 && warehouses.has(d.warehouse_id));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api('/admin/purchase-requests/convert', {
        method: 'POST',
        body: { requestIds: selected.map((x) => x.id), ...(target ? { purchaseOrderId: target } : { supplierId }), ...(minReason.trim().length >= 3 ? { minExceptionReason: minReason.trim() } : {}) },
      });
      onDone();
      router.push(`/painel/compras/${r.purchaseOrderId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BELOW_MINIMUM') setNeedMin(true);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="convert-requests">
      <p className="text-sm">
        {selected.length} requisição(ões) selecionada(s): {selected.map((r) => `nº ${r.number}`).join(', ')}.
      </p>
      {warehouses.size > 1 && <Notice tone="warn">Selecione requisições de um só depósito: a compra tem um só destino.</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fornecedor" required>
          {(id) => (
            <Select id={id} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Escolha…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id === suggested ? ' (principal)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Compra" hint="Rascunho novo ou um rascunho deste fornecedor para o mesmo depósito.">
          {(id) => (
            <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Novo rascunho</option>
              {sameWarehouse.map((d) => (
                <option key={d.id} value={d.id}>
                  Acrescentar ao rascunho nº {d.number}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {needMin && (
        <Field label="Justificativa (abaixo do mínimo ou fora do múltiplo do fornecedor)">
          {(id) => <Input id={id} maxLength={300} value={minReason} onChange={(e) => setMinReason(e.target.value)} />}
        </Field>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <Button variant="primary" busy={busy} disabled={!supplierId || warehouses.size > 1}>
        Gerar compra
      </Button>
      <p className="text-xs text-ink-faint">A compra nasce em rascunho e segue o caminho normal: aprovação, envio ao fornecedor e recebimento.</p>
    </form>
  );
}

function Page() {
  const { can, me } = useMe();
  const manage = can('purchases.manage');
  const request = can('purchases.request');
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState<Req[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(() => {
    api<{ items: Req[]; total: number }>(`/admin/purchase-requests?status=${status}&pageSize=100`).then(
      (r) => (setItems(r.items), setTotal(r.total)),
      (e) => setError(e.message),
    );
  }, [status]);
  useEffect(load, [load]);
  useEffect(() => setSelected(new Set()), [status]);

  const act = async (r: Req, kind: 'cancel' | 'reject') => {
    const reason = window.prompt(kind === 'cancel' ? 'Por que cancelar a requisição?' : 'Por que recusar a requisição?');
    if (!reason) return;
    setError('');
    try {
      await api(`/admin/purchase-requests/${r.id}/${kind}`, { method: 'POST', body: { reason } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const sync = async () => {
    setError('');
    try {
      const r = await api('/admin/purchase-requests/sync', { method: 'POST' });
      setNotice(r.result.created ? `${r.result.created} requisição(ões) de encomenda criada(s).` : 'Nenhuma encomenda nova sem compra.');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const chosen = (items ?? []).filter((r) => selected.has(r.id));
  const groups = new Map<string, Req[]>();
  for (const r of items ?? []) {
    const k = r.suggested_supplier_name ?? 'Sem fornecedor principal';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  return (
    <>
      <PageHeader
        title="Requisições de compra"
        description="Pedidos internos de compra e encomendas sem compra. Não reservam nem movimentam estoque; viram compra só quando o comprador gera."
        actions={
          <>
            {(manage || request) && <Button onClick={sync}>Atualizar encomendas</Button>}
            <Link href="/painel/logistica/abastecimento" className="text-sm font-medium text-act hover:underline">
              Abastecimento
            </Link>
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Notice tone="good">{notice}</Notice>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0">
          <Panel
            title="Requisições"
            description={`${total} no filtro`}
            actions={
              <Select aria-label="Situação" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="open">Abertas</option>
                <option value="in_purchase">Em compra</option>
                <option value="done">Atendidas</option>
                <option value="rejected">Recusadas</option>
                <option value="canceled">Canceladas</option>
                <option value="all">Todas</option>
              </Select>
            }
          >
            {!items ? (
              <p className="text-sm text-ink-faint">Carregando…</p>
            ) : items.length === 0 ? (
              <Empty title="Nenhuma requisição">Nada nesta situação.</Empty>
            ) : (
              <div className="space-y-4" data-testid="requests">
                {[...groups].map(([supplier, rows]) => (
                  <section key={supplier}>
                    <h3 className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">{supplier}</h3>
                    <ul className="divide-y divide-line rounded-md border border-line">
                      {rows.map((r) => {
                        const st = REQUEST_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
                        const canCancel = r.status === 'open' && r.source === 'manual' && (manage || r.requested_by === me.user.id);
                        return (
                          <li key={r.id} className="flex flex-wrap items-start gap-3 px-3 py-2 text-sm">
                            {manage && r.status === 'open' && (
                              <input type="checkbox" className="mt-1" aria-label={`Selecionar requisição ${r.number}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">Nº {r.number}</span>
                                <Badge tone={st.tone}>{st.label}</Badge>
                                {r.source === 'backorder' && <Badge tone="act">Encomenda</Badge>}
                                {r.status === 'open' && r.age_days >= 3 && <Badge tone="warn">Aberta há {r.age_days} dias</Badge>}
                              </p>
                              <p>
                                {r.product_name} · {qty(r.base_qty)} {r.base_unit}
                                {r.packaging_label ? ` · ${r.packaging_label}` : ''}
                              </p>
                              <p className="text-xs text-ink-faint">
                                {r.warehouse_name} · {r.source === 'backorder' ? `pedido nº ${r.order_number}` : `${r.requested_by_name} em ${when(r.created_at)}`}
                                {r.needed_by ? ` · precisa até ${day(r.needed_by)}` : ''} · {r.reason}
                              </p>
                              {r.purchase_order_id && (
                                <Link href={`/painel/compras/${r.purchase_order_id}`} className="text-xs text-act hover:underline">
                                  Compra nº {r.purchase_order_number}
                                </Link>
                              )}
                              {r.decision_note && <p className="text-xs text-ink-soft">{r.decision_note}</p>}
                            </div>
                            <div className="flex gap-1">
                              {canCancel && (
                                <Button variant="ghost" onClick={() => act(r, 'cancel')}>
                                  Cancelar
                                </Button>
                              )}
                              {manage && r.status === 'open' && (
                                <Button variant="ghost" onClick={() => act(r, 'reject')}>
                                  Recusar
                                </Button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Panel>
        </div>
        <div className="min-w-0 space-y-5">
          {manage && chosen.length > 0 && (
            <Panel title="Gerar compra">
              <Convert selected={chosen} onDone={load} />
            </Panel>
          )}
          {manage && chosen.length === 0 && status === 'open' && (items?.length ?? 0) > 0 && <Notice>Marque as requisições abertas que entram na mesma compra.</Notice>}
          {request && (
            <Panel title="Pedir compra" description="Para estoque ou para uma necessidade sua. Encomendas de clientes viram requisição sozinhas.">
              <NewRequest onDone={load} />
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

export default function RequisicoesPage() {
  return (
    <Guard perm="purchases.view|purchases.request">
      <Page />
    </Guard>
  );
}
