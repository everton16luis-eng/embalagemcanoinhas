'use client';

import { Trash2 } from 'lucide-react';
import Link from '@/components/painel-link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { newKey, packLabel, PackagingPicker, PO_STATUS } from '@/components/stock';
import { ApprovalPanel, EventsPanel, IssuesPanel, LinksPanel, PURPOSE, RULE, ShippingPanel, WarehouseSelect, type ApprovalInfo, type PoConversion, type PoEvent, type PoIssue, type PoLink } from '@/components/purchases';
import { SupplierComparisonCompact } from '@/components/suppliers';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { centsToInput, money, parseMoney, parseQty, qty, qtyToInput, unitMoney, when } from '@/lib/format';

type Item = {
  id: string;
  variant_id: string;
  packaging_id: string;
  packaging_label: string;
  base_qty_per_pack: string;
  packs: string;
  pack_cost_cents: string;
  received_packs: string;
  rejected_packs: string;
  linked_qty: string;
  sku: string;
  product_name: string;
  base_unit: string;
  base_qty: string;
  min_order_packs: string | null;
  order_multiple_packs: string | null;
  min_exception_reason: string | null;
};
type Order = ApprovalInfo & {
  id: string;
  purpose: string;
  warehouse_id: string;
  warehouse_name: string;
  created_by: string;
  carrier: string | null;
  tracking_code: string | null;
  events: PoEvent[];
  issues: PoIssue[];
  links: PoLink[];
  conversions: PoConversion[];
  number: number;
  supplier_id: string;
  supplier_name: string;
  status: string;
  expected_at: string | null;
  freight_cents: string;
  other_costs_cents: string;
  notes: string | null;
  created_at: string;
  sent_at: string | null;
  closed_at: string | null;
  cancel_reason: string | null;
  version: number;
  goods_cents: string;
  created_by_name: string;
  items: Item[];
  receipts: {
    id: string;
    invoice_ref: string | null;
    notes: string | null;
    received_at: string;
    received_by_name: string;
    items: { itemId: string; packs: string; baseQty: string; unitCostCents: string; allocatedExtraCents: string; rejectedPacks: string; rejectedBaseQty: string; rejectedDestination: string | null; invoicedPackCostCents: string | null }[];
  }[];
};
type Line = { packagingId: string; variantId: string; label: string; productName: string; sku: string; baseQty: string; baseUnit: string; packs: string; cost: string; reason: string };
type OfferTerms = { cost: string; min: string | null; multiple: string | null };

/** Abaixo do minimo ou fora do multiplo do fornecedor: so aviso; para seguir, a justificativa (D2-11). */
function minIssue(l: Line, t: OfferTerms | undefined) {
  const packs = Number(parseQty(l.packs) || 0);
  if (!t || !packs) return null;
  const min = t.min ? Number(t.min) : null;
  const mult = t.multiple ? Number(t.multiple) : null;
  if (min && packs < min) return `abaixo do mínimo do fornecedor (${qty(min)} embalagens)`;
  if (mult && Math.abs(packs / mult - Math.round(packs / mult)) > 1e-9) return `fora do múltiplo do fornecedor (${qty(mult)} em ${qty(mult)})`;
  return null;
}
type Supplier = { id: string; name: string };

const toLines = (o: Order): Line[] =>
  o.items.map((i) => ({ packagingId: i.packaging_id, variantId: i.variant_id, label: i.packaging_label, productName: i.product_name, sku: i.sku, baseQty: i.base_qty_per_pack, baseUnit: i.base_unit, packs: qtyToInput(i.packs), cost: centsToInput(i.pack_cost_cents), reason: i.min_exception_reason ?? '' }));

function OrderForm({ order, onSaved }: { order: Order | null; onSaved: (o: Order) => void }) {
  const search = useSearchParams();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState(order?.supplier_id ?? search.get('fornecedor') ?? '');
  const [terms, setTerms] = useState<Record<string, OfferTerms>>({});
  const offerCost = Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, v.cost]));
  const [lines, setLines] = useState<Line[]>(order ? toLines(order) : []);
  const [freight, setFreight] = useState(order ? centsToInput(order.freight_cents) : '');
  const [other, setOther] = useState(order ? centsToInput(order.other_costs_cents) : '');
  const [expectedAt, setExpectedAt] = useState(order?.expected_at ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [purpose, setPurpose] = useState(order?.purpose ?? 'replenishment');
  const [warehouseId, setWarehouseId] = useState(order?.warehouse_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Comparacao por linha (so informativa; exige suppliers.view, como no produto).
  const canCompare = useMe().can('suppliers.view');
  const [compare, setCompare] = useState<string | null>(null);

  useEffect(() => {
    api('/admin/suppliers?active=true&pageSize=100').then((r) => setSuppliers(r.items), () => null);
  }, []);
  useEffect(() => {
    if (!supplierId) return;
    api(`/admin/suppliers/${supplierId}`).then(
      (r) =>
        setTerms(
          Object.fromEntries(
            r.supplier.offers
              .filter((o: { active: boolean }) => o.active)
              .map((o: { packaging_id: string; cost_cents: string; min_order_packs: string | null; order_multiple_packs: string | null }) => [
                o.packaging_id,
                { cost: centsToInput(o.cost_cents), min: o.min_order_packs, multiple: o.order_multiple_packs },
              ]),
          ),
        ),
      () => setTerms({}),
    );
  }, [supplierId]);

  const goods = lines.reduce((s, l) => s + (parseMoney(l.cost) ?? 0) * Number(parseQty(l.packs) || 0), 0);
  const extras = (parseMoney(freight) ?? 0) + (parseMoney(other) ?? 0);
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!lines.length) return setError('Adicione ao menos um item.');
    setBusy(true);
    const body = {
      supplierId,
      purpose,
      warehouseId: warehouseId || null,
      expectedAt: expectedAt || null,
      freightCents: parseMoney(freight) ?? 0,
      otherCostsCents: parseMoney(other) ?? 0,
      notes: notes.trim() || null,
      items: lines.map((l) => ({
        packagingId: l.packagingId,
        packs: parseQty(l.packs),
        packCostCents: l.cost.trim() ? parseMoney(l.cost) : null,
        ...(minIssue(l, terms[l.packagingId]) && l.reason.trim().length >= 3 ? { minExceptionReason: l.reason.trim() } : {}),
      })),
      ...(order ? { version: order.version } : {}),
    };
    try {
      const r = await api<{ order: Order }>(order ? `/admin/purchase-orders/${order.id}` : '/admin/purchase-orders', { method: order ? 'PUT' : 'POST', body });
      onSaved(r.order);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fornecedor" required>
          {(id) => (
            <Select id={id} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required disabled={Boolean(order && order.status !== 'draft')}>
              <option value="">Escolha…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Previsão de entrega">{(id) => <Input id={id} type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />}</Field>
        <Field label="Finalidade">
          {(id) => (
            <Select id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={order?.status === 'sent'}>
              {Object.entries(PURPOSE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} disabled={order?.status === 'sent'} />
      </div>
      {order && order.status !== 'draft' && order.status !== 'sent' && <Notice tone="warn">Salvar alterações devolve o pedido para rascunho: a aprovação anterior deixa de valer.</Notice>}
      {order?.status === 'sent' && <Notice>Pedido enviado: só a previsão e as observações mudam. Para mudar itens ou valores, cancele e faça outro pedido.</Notice>}

      <div>
        <PackagingPicker
          onPick={(h) => {
            if (lines.some((l) => l.packagingId === h.id)) return;
            setLines([...lines, { packagingId: h.id, variantId: h.variant_id, label: h.label, productName: h.product_name, sku: h.sku, baseQty: h.base_qty, baseUnit: h.base_unit, packs: terms[h.id]?.min ? qtyToInput(terms[h.id]!.min!) : '1', cost: offerCost[h.id] ?? '', reason: '' }]);
          }}
        />
        {lines.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-3 font-medium">Item</th>
                  <th className="py-2 pl-3 font-medium">Embalagens</th>
                  <th className="py-2 pl-3 font-medium">Custo da embalagem (R$)</th>
                  <th className="py-2 pl-3 text-right font-medium">Subtotal</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {lines.map((l, i) => {
                  const packs = Number(parseQty(l.packs) || 0);
                  return (
                    <Fragment key={l.packagingId}>
                    <tr>
                      <td className="py-2 pl-3">
                        <span className="block font-medium">{l.productName}</span>
                        <span className="block text-xs text-ink-faint">
                          {packLabel(l.label, l.baseQty, l.baseUnit)} · total {qty(packs * Number(l.baseQty))} {l.baseUnit}
                        </span>
                        {minIssue(l, terms[l.packagingId]) && (
                          <span className="mt-1 block">
                            <span className="block text-xs text-warn">⚠ {minIssue(l, terms[l.packagingId])}. Para seguir assim, justifique:</span>
                            <Input aria-label="Justificativa da compra abaixo do mínimo" className="mt-1 max-w-xs" maxLength={300} placeholder="Ex.: fornecedor aceitou nesta compra" value={l.reason} onChange={(e) => setLine(i, { reason: e.target.value })} />
                          </span>
                        )}
                        {canCompare && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-act hover:underline"
                            aria-expanded={compare === l.packagingId}
                            onClick={() => setCompare(compare === l.packagingId ? null : l.packagingId)}
                          >
                            {compare === l.packagingId ? 'Fechar comparação' : 'Comparar fornecedores'}
                          </button>
                        )}
                      </td>
                      <td className="py-2 pl-3">
                        <Input aria-label="Quantidade de embalagens" className="w-20" inputMode="decimal" value={l.packs} onChange={(e) => setLine(i, { packs: e.target.value })} />
                      </td>
                      <td className="py-2 pl-3">
                        <Input aria-label="Custo da embalagem" className="w-28" inputMode="decimal" value={l.cost} placeholder={offerCost[l.packagingId] ? 'da lista' : 'obrigatório'} onChange={(e) => setLine(i, { cost: e.target.value })} />
                      </td>
                      <td className="num py-2 pl-3 text-right">{money((parseMoney(l.cost) ?? 0) * packs)}</td>
                      <td className="py-2 pr-1 text-right">
                        <Button type="button" variant="ghost" aria-label="Remover item" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                          <Trash2 size={16} />
                        </Button>
                      </td>
                    </tr>
                    {canCompare && compare === l.packagingId && (
                      <tr>
                        <td colSpan={5} className="bg-sunken/40 px-3 py-2">
                          <SupplierComparisonCompact variantId={l.variantId} needBase={packs * Number(l.baseQty)} currentSupplierId={supplierId} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Frete da compra (R$)" hint="Rateado no custo dos itens pelo valor.">
          {(id) => <Input id={id} inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} />}
        </Field>
        <Field label="Outras despesas (R$)" hint="Seguro, taxa de boleto etc.">
          {(id) => <Input id={id} inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} />}
        </Field>
        <div className="flex flex-col justify-center rounded-md bg-sunken px-3 py-2 text-sm">
          <span className="text-ink-soft">Mercadoria {money(goods)}</span>
          <span className="num text-base font-semibold">Total {money(goods + extras)}</span>
        </div>
      </div>
      <Field label="Observações">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}</Field>
      {error && <Notice tone="bad">{error}</Notice>}
      <Button variant="primary" busy={busy}>
        {order ? 'Salvar alterações' : 'Criar pedido'}
      </Button>
    </form>
  );
}

type Extra = { rejected: string; destination: string; reason: string; invoiced: string; justification: string; shortNote: string; open: boolean };
const blankExtra: Extra = { rejected: '', destination: 'damaged', reason: '', invoiced: '', justification: '', shortNote: '', open: false };
type ReceiptResult = { order: Order; conversions?: { variantId: string; converted: { orderNumber: number; qty: string; rule: string }[]; stoppedAt: { orderNumber: number; qty: string; free: string } | null }[] };

function ReceiveForm({ order, onDone }: { order: Order; onDone: (o: Order, summary: string | null) => void }) {
  const pending = (i: Item) => Math.max(0, Number(i.packs) - Number(i.received_packs));
  const [packs, setPacks] = useState<Record<string, string>>(() => Object.fromEntries(order.items.map((i) => [i.id, pending(i) ? qtyToInput(String(pending(i))) : ''])));
  const [extra, setExtra] = useState<Record<string, Extra>>({});
  // Vindo da conferencia da nota de compra (?nf=numero), o numero da NF ja vem preenchido.
  const nf = useSearchParams().get('nf') ?? '';
  const [invoiceRef, setInvoiceRef] = useState(nf.slice(0, 60));
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ex = (id: string) => extra[id] ?? blankExtra;
  const setEx = (id: string, patch: Partial<Extra>) => setExtra({ ...extra, [id]: { ...ex(id), ...patch } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const items = order.items
      .map((i) => {
        const x = ex(i.id);
        const p = parseQty(packs[i.id] ?? '');
        if (!p || Number(p) <= 0) return null;
        const rejected = parseQty(x.rejected);
        const invoiced = x.invoiced.trim() ? parseMoney(x.invoiced) : null;
        return {
          itemId: i.id,
          packs: p,
          ...(rejected && Number(rejected) > 0 ? { rejectedPacks: rejected, rejectedDestination: x.destination, rejectedReason: x.reason.trim() || null } : {}),
          ...(invoiced !== null ? { invoicedPackCostCents: invoiced } : {}),
          ...(x.justification.trim() ? { priceJustification: x.justification.trim() } : {}),
        };
      })
      .filter(Boolean);
    if (!items.length) return setError('Informe o que chegou.');
    const issues = order.items
      .filter((i) => ex(i.id).shortNote.trim().length >= 3)
      .map((i) => ({ itemId: i.id, kind: 'quantity', expected: pending(i), found: Number(parseQty(packs[i.id] ?? '') || 0), note: ex(i.id).shortNote.trim() }));
    setBusy(true);
    try {
      const r = await api<ReceiptResult>(`/admin/purchase-orders/${order.id}/receipts`, { method: 'POST', body: { requestKey: key, invoiceRef: invoiceRef.trim() || null, items, issues } });
      setKey(newKey());
      const conv = (r.conversions ?? []).flatMap((c) => c.converted);
      const stopped = (r.conversions ?? []).map((c) => c.stoppedAt).filter(Boolean) as { orderNumber: number; qty: string; free: string }[];
      const parts = [
        conv.length ? `Encomendas atendidas: ${conv.map((c) => `nº ${c.orderNumber} (${RULE[c.rule] ?? c.rule})`).join(', ')}.` : '',
        stopped.length ? `Aguardando: ${stopped.map((s) => `nº ${s.orderNumber} precisa de ${qty(s.qty)}, livre ${qty(s.free)}`).join('; ')} (sem atendimento parcial).` : '',
      ].filter(Boolean);
      onDone(r.order, parts.length ? parts.join(' ') : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-ink-soft">
        Destino: <span className="font-medium text-ink">{order.warehouse_name}</span>. O recebimento só entra neste depósito.
      </p>
      <ul className="divide-y divide-line">
        {order.items.map((i) => {
          const x = ex(i.id);
          return (
            <li key={i.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">{i.product_name}</span>
                  <span className="block text-xs text-ink-faint">
                    {i.packaging_label} · pendente {qty(pending(i))} de {qty(i.packs)}
                  </span>
                </span>
                <Input aria-label={`Recebido de ${i.product_name}`} className="w-24" inputMode="decimal" disabled={!pending(i)} value={packs[i.id] ?? ''} onChange={(e) => setPacks({ ...packs, [i.id]: e.target.value })} />
              </div>
              {pending(i) > 0 && (
                <button type="button" className="mt-1 text-xs text-act hover:underline" aria-expanded={x.open} onClick={() => setEx(i.id, { open: !x.open })}>
                  {x.open ? 'Fechar divergências' : 'Recusa, preço da nota ou falta'}
                </button>
              )}
              {x.open && (
                <div className="mt-2 grid gap-2 rounded-md bg-sunken/50 p-2 sm:grid-cols-2">
                  <Field label="Recusadas (embalagens)" hint="Parte do que chegou. Não fica disponível para venda.">
                    {(id) => <Input id={id} inputMode="decimal" value={x.rejected} onChange={(e) => setEx(i.id, { rejected: e.target.value })} />}
                  </Field>
                  <Field label="Destino do recusado">
                    {(id) => (
                      <Select id={id} value={x.destination} onChange={(e) => setEx(i.id, { destination: e.target.value })}>
                        <option value="damaged">Avariado</option>
                        <option value="blocked">Bloqueado (quarentena)</option>
                      </Select>
                    )}
                  </Field>
                  <Field label="Motivo da recusa">{(id) => <Input id={id} value={x.reason} maxLength={500} onChange={(e) => setEx(i.id, { reason: e.target.value })} />}</Field>
                  <Field label="Custo da embalagem na nota (R$)" hint={`Pedido: ${money(i.pack_cost_cents)}.`}>
                    {(id) => <Input id={id} inputMode="decimal" value={x.invoiced} onChange={(e) => setEx(i.id, { invoiced: e.target.value })} />}
                  </Field>
                  <Field label="Justificativa do preço" hint="Obrigatória acima da tolerância.">
                    {(id) => <Input id={id} value={x.justification} maxLength={500} onChange={(e) => setEx(i.id, { justification: e.target.value })} />}
                  </Field>
                  <Field label="Falta frente à nota" hint="Descreva se chegou menos do que a nota diz.">
                    {(id) => <Input id={id} value={x.shortNote} maxLength={500} onChange={(e) => setEx(i.id, { shortNote: e.target.value })} />}
                  </Field>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Field label="Nota fiscal do fornecedor" hint="Número ou chave, para conferência.">
        {(id) => <Input id={id} value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} maxLength={60} />}
      </Field>
      {error && <Notice tone="bad">{error}</Notice>}
      <Button variant="primary" busy={busy}>
        Dar entrada no estoque
      </Button>
    </form>
  );
}

function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'novo';
  const router = useRouter();
  const { can, me } = useMe();
  const [order, setOrder] = useState<Order | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!isNew) api(`/admin/purchase-orders/${id}`).then((r) => setOrder(r.order), (e) => setError(e.message));
  }, [id, isNew]);
  useEffect(load, [load]);

  if (isNew) {
    return (
      <>
        <PageHeader title="Novo pedido de compra" />
        <Panel>
          <OrderForm order={null} onSaved={(o) => router.replace(`/painel/compras/${o.id}`)} />
        </Panel>
      </>
    );
  }
  if (!order) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-faint">Carregando…</p>;

  const manage = can('purchases.manage');
  const approve = can('purchases.approve');
  const receive = can('purchases.receive');
  // D6-4: quem criou ou enviou para aprovacao nao aprova; o proprietario pode, com justificativa (o servidor confere).
  const own = order.created_by === me.user.id;
  const action = async (path: string, needsReason?: string, field: 'reason' | 'note' = 'reason') => {
    let reason: string | null = null;
    if (needsReason) {
      reason = window.prompt(needsReason);
      if (!reason) return;
    }
    setError('');
    setSummary(null);
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/${path}`, { method: 'POST', body: reason ? { [field]: reason } : {} });
      setOrder(r.order);
      if (r.pendingOrders?.length) setSummary(`Encomendas que continuam aguardando (vínculo desfeito, pedido não cancelado): ${r.pendingOrders.map((p: { order_number: number }) => `nº ${p.order_number}`).join(', ')}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const status = PO_STATUS[order.status]!;
  const extras = Number(order.freight_cents) + Number(order.other_costs_cents);
  const itemById = Object.fromEntries(order.items.map((i) => [i.id, i]));

  return (
    <>
      <PageHeader
        title={`Pedido de compra nº ${order.number}`}
        description={
          <>
            <Link href={`/painel/fornecedores/${order.supplier_id}`} className="underline underline-offset-2">
              {order.supplier_name}
            </Link>{' '}
            · criado por {order.created_by_name} em {when(order.created_at)}
          </>
        }
        actions={
          (manage || approve) && (
            <>
              {manage && ['draft', 'pending_approval', 'approved', 'sent'].includes(order.status) && !editing && <Button onClick={() => setEditing(true)}>Editar</Button>}
              {manage && order.status === 'draft' && (
                <Button variant="primary" onClick={() => action('submit')}>
                  Enviar para aprovação
                </Button>
              )}
              {approve && order.status === 'pending_approval' && (
                <>
                  <Button variant="primary" onClick={() => (own ? action('approve', 'Você criou esta compra. Justifique a aprovação (só o proprietário pode):', 'note') : action('approve'))}>
                    Aprovar
                  </Button>
                  <Button onClick={() => action('reject-approval', 'Por que devolver sem aprovar?')}>Devolver</Button>
                </>
              )}
              {manage && order.status === 'approved' && (
                <Button variant="primary" onClick={() => action('send')}>
                  Marcar como enviado
                </Button>
              )}
              {manage && ['draft', 'pending_approval', 'approved', 'sent'].includes(order.status) && (
                <Button variant="danger" onClick={() => action('cancel', 'Motivo do cancelamento:')}>
                  Cancelar
                </Button>
              )}
              {manage && order.status === 'partial' && <Button onClick={() => action('close', 'Por que encerrar sem receber o restante?')}>Encerrar saldo pendente</Button>}
            </>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-ink-soft">
          {PURPOSE[order.purpose] ?? order.purpose} · destino {order.warehouse_name}
        </span>
        {order.expected_at && <span className="text-ink-soft">Previsão {new Date(`${order.expected_at}T12:00:00`).toLocaleDateString('pt-BR')}</span>}
        {order.cancel_reason && <span className="text-ink-soft">· {order.cancel_reason}</span>}
      </div>
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {summary && (
        <div className="mb-4" data-testid="po-summary">
          <Notice tone="good">{summary}</Notice>
        </div>
      )}

      {editing ? (
        <Panel title="Editar pedido" actions={<Button variant="ghost" onClick={() => setEditing(false)}>Fechar</Button>}>
          <OrderForm
            order={order}
            onSaved={(o) => {
              setOrder(o);
              setEditing(false);
            }}
          />
        </Panel>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-5">
            <Panel title="Itens">
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-ink-soft">
                    <tr className="border-b border-line">
                      <th className="py-2 pl-4 font-medium sm:pl-5">Item</th>
                      <th className="py-2 pl-3 text-right font-medium">Pedido</th>
                      <th className="py-2 pl-3 text-right font-medium">Recebido</th>
                      <th className="py-2 pr-4 pl-3 text-right font-medium sm:pr-5">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {order.items.map((i) => (
                      <tr key={i.id}>
                        <td className="py-2 pl-4 sm:pl-5">
                          <span className="block font-medium">{i.product_name}</span>
                          <span className="block text-xs text-ink-faint">
                            <span className="font-mono">{i.sku}</span> · {packLabel(i.packaging_label, i.base_qty_per_pack, i.base_unit)} · {money(i.pack_cost_cents)} cada
                          </span>
                          {i.min_exception_reason && <span className="block text-xs text-warn">Abaixo do mínimo ou fora do múltiplo do fornecedor: {i.min_exception_reason}</span>}
                        </td>
                        <td className="num py-2 pl-3 text-right">{qty(i.packs)}</td>
                        <td className={`num py-2 pl-3 text-right ${Number(i.received_packs) >= Number(i.packs) ? 'text-good' : ''}`}>
                          {qty(i.received_packs)}
                          {Number(i.rejected_packs) > 0 && <span className="block text-xs text-warn">{qty(i.rejected_packs)} recusada(s)</span>}
                        </td>
                        <td className="num py-2 pr-4 pl-3 text-right sm:pr-5">{money(Math.round(Number(i.packs) * Number(i.pack_cost_cents)))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-soft">Mercadoria</dt>
                  <dd className="num">{money(order.goods_cents)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-soft">Frete e despesas</dt>
                  <dd className="num">{money(extras)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Total</dt>
                  <dd className="num">{money(Number(order.goods_cents) + extras)}</dd>
                </div>
              </dl>
              {order.notes && <p className="mt-3 text-sm whitespace-pre-line text-ink-soft">{order.notes}</p>}
            </Panel>

            <Panel title="Recebimentos" description="Custo de entrada por unidade base, já com a parte do frete e das despesas.">
              {order.receipts.length === 0 ? (
                <p className="text-sm text-ink-soft">Nada recebido ainda.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {order.receipts.map((r) => (
                    <li key={r.id} className="py-3 first:pt-0">
                      <p className="text-sm font-medium">
                        {when(r.received_at)} · {r.received_by_name}
                        {r.invoice_ref && <span className="font-normal text-ink-soft"> · NF {r.invoice_ref}</span>}
                      </p>
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {r.items.map((ri) => {
                          const it = itemById[ri.itemId];
                          return (
                            <li key={ri.itemId} className="flex flex-wrap justify-between gap-x-3 text-ink-soft">
                              <span>
                                {it?.product_name}: {qty(ri.packs)} × {it?.packaging_label} = {qty(ri.baseQty)} {it?.base_unit}
                              </span>
                              <span className="num">
                                {unitMoney(ri.unitCostCents)}/{it?.base_unit}
                              </span>
                              {Number(ri.rejectedBaseQty) > 0 && (
                                <span className="w-full text-xs text-warn">
                                  Recusado: {qty(ri.rejectedBaseQty)} {it?.base_unit} para {ri.rejectedDestination === 'damaged' ? 'avariado' : 'bloqueado'}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <div className="min-w-0 space-y-5">
            {receive && ['sent', 'partial'].includes(order.status) && (
              <Panel title="Receber mercadoria" description="Confira com a nota. Quantidade em embalagens do pedido; pode receber em partes.">
                <ReceiveForm
                  key={order.version}
                  order={order}
                  onDone={(o, s) => {
                    setOrder(o);
                    setSummary(s);
                  }}
                />
              </Panel>
            )}
            {['draft', 'pending_approval', 'approved'].includes(order.status) && (
              <Notice>
                {order.status === 'draft'
                  ? 'Rascunho: envie para aprovação. Depois de aprovado, marque como enviado ao mandar o pedido ao fornecedor; só então o recebimento fica disponível.'
                  : order.status === 'pending_approval'
                    ? 'Aguardando aprovação de outra pessoa com a permissão.'
                    : 'Aprovado: marque como enviado depois de mandar o pedido ao fornecedor.'}
              </Notice>
            )}
            <ApprovalPanel order={order} canPay={can('purchases.pay')} onChange={(o: Order) => setOrder(o)} />
            <ShippingPanel order={order} canEdit={manage} onChange={(o: Order) => setOrder(o)} />
            <LinksPanel order={order} canManage={manage} onChange={(o: Order) => setOrder(o)} />
            <IssuesPanel issues={order.issues} items={order.items} />
            <EventsPanel events={order.events} />
          </div>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <Suspense>
        <OrderPage />
      </Suspense>
    </Guard>
  );
}
