'use client';

// SGLog Fase 7 (D7-5, D7-8, D7-12): compras sem confirmacao, atrasos, mercadoria a caminho, encomendas afetadas
// (so o numero do pedido) e desempenho dos fornecedores. Somente leitura; as acoes ficam na compra.
import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { useWarehouses } from '@/components/stock';
import { day, SUPPLY } from '@/components/supply';
import { Badge, Empty, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

type OrderRow = {
  id: string;
  number: number;
  status: string;
  supplier_name: string;
  warehouse_name: string;
  sent_at: string | null;
  confirmation_due: string | null;
  followup_on: string | null;
  category: string;
  ref_date: string | null;
  days_late: number | null;
  items: { item_id: string; sku: string; product_name: string; packaging_label: string; pending_packs: string; ref_date: string | null; late: boolean }[];
};
type Overview = {
  counts: Record<string, number> & { requestsOpen: number; backordersWithoutPurchase: number };
  orders: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
  inbound: { variantId: string; sku: string; productName: string; pendingBase: string; orders: number[]; nextDate: string | null; late: boolean }[];
  affected: {
    linked: { orderNumber: number; baseQty: string; sku: string; productName: string; purchaseNumber: number; purchaseOrderId: string; category: string; refDate: string | null }[];
    withoutPurchase: { order_number: number; unlinked: string; sku: string; product_name: string; warehouse_name: string; request_number: number | null; request_status: string | null }[];
  };
};
type Perf = {
  supplier_id: string;
  supplier_name: string;
  registered_lead_days: number | null;
  sent: number;
  tracked: number;
  confirmed: number;
  confirmation_rate_pct: number | null;
  avg_confirm_hours: string | null;
  avg_lead_days: string | null;
  on_time_pct: number | null;
  due_samples: number;
  confirmations_changed: number;
  confirmations_refused: number;
  issues_quantity: number;
  issues_price: number;
  issues_quality: number;
  issues_wrong_item: number;
  suggested_lead_days: number | null;
};

const CARDS = ['delivery_late', 'confirmation_late', 'price_approval', 'refused', 'no_date', 'awaiting_confirmation', 'delivery_expected', 'untracked'];

function Warehouses({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { active } = useWarehouses();
  if (active.length < 2) return null;
  return (
    <Select aria-label="Depósito" className="w-auto" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Todos os depósitos</option>
      {active.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </Select>
  );
}

function Page() {
  const { can } = useMe();
  const [warehouseId, setWarehouseId] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Overview | null>(null);
  const [perf, setPerf] = useState<{ days: number; suppliers: Perf[] } | null>(null);
  const [days, setDays] = useState(90);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: '25', ...(warehouseId ? { warehouseId } : {}), ...(category ? { category } : {}) });
    api<Overview>(`/admin/supply/overview?${q}`).then(setData, (e) => setError(e.message));
  }, [warehouseId, category, page]);
  useEffect(load, [load]);
  useEffect(() => {
    api(`/admin/supply/performance?days=${days}`).then(setPerf, () => setPerf(null));
  }, [days]);

  return (
    <>
      <PageHeader
        title="Abastecimento"
        description="Compras enviadas: confirmação do fornecedor, prazos, o que está a caminho e as encomendas afetadas. Compras enviadas antes deste acompanhamento aparecem sem alerta."
        actions={can('stock.view') ? <Warehouses value={warehouseId} onChange={(v) => (setWarehouseId(v), setPage(1))} /> : undefined}
      />
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="supply-counts">
            {CARDS.map((k) => {
              const on = category === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => (setCategory(on ? '' : k), setPage(1))}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${on ? 'border-act bg-act/5' : 'border-line bg-card hover:bg-sunken/50'}`}
                >
                  <span className="num block text-2xl font-semibold">{data.counts[k] ?? 0}</span>
                  <span className="block text-xs text-ink-soft">{SUPPLY[k]?.label ?? k}</span>
                </button>
              );
            })}
          </div>
          <div className="mb-5 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <Link href="/painel/compras/requisicoes" className="text-act hover:underline">
              {data.counts.requestsOpen} requisição(ões) aberta(s)
            </Link>
            <span className="text-ink-soft">{data.counts.backordersWithoutPurchase} encomenda(s) sem compra vinculada</span>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
            <div className="min-w-0 space-y-5">
              <Panel title={category ? (SUPPLY[category]?.label ?? category) : 'Compras enviadas'} description={`${data.total} compra(s)`}>
                {data.orders.length === 0 ? (
                  <Empty title="Nada aqui">Nenhuma compra nesta situação.</Empty>
                ) : (
                  <ul className="divide-y divide-line" data-testid="supply-orders">
                    {data.orders.map((o) => {
                      const s = SUPPLY[o.category] ?? { label: o.category, tone: 'neutral' as const };
                      return (
                        <li key={o.id} className="py-3 first:pt-0">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Link href={`/painel/compras/${o.id}`} className="font-medium hover:underline">
                              Compra nº {o.number} · {o.supplier_name}
                            </Link>
                            <Badge tone={s.tone}>
                              {s.label}
                              {o.days_late ? ` há ${o.days_late} dia(s)` : ''}
                            </Badge>
                          </div>
                          <p className="text-xs text-ink-faint">
                            {o.warehouse_name} · enviada {when(o.sent_at)}
                            {o.category === 'awaiting_confirmation' && o.confirmation_due ? ` · confirmar até ${when(o.confirmation_due)}` : ''}
                            {o.ref_date ? ` · referência ${day(o.ref_date)}` : ''}
                            {o.followup_on ? ` · retorno ${day(o.followup_on)}` : ''}
                          </p>
                          <ul className="mt-1 text-xs text-ink-soft">
                            {o.items.map((i) => (
                              <li key={i.item_id} className={i.late ? 'text-bad' : ''}>
                                {i.product_name} ({i.sku}) · {qty(i.pending_packs)} × {i.packaging_label}
                                {i.ref_date ? ` · ${day(i.ref_date)}` : ' · sem previsão'}
                              </li>
                            ))}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {data.total > data.pageSize && (
                  <div className="mt-3 flex items-center gap-3 text-sm">
                    <button type="button" className="text-act disabled:text-ink-faint" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Anterior
                    </button>
                    <span className="text-ink-soft">
                      Página {page} de {Math.ceil(data.total / data.pageSize)}
                    </span>
                    <button type="button" className="text-act disabled:text-ink-faint" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
                      Próxima
                    </button>
                  </div>
                )}
              </Panel>

              <Panel title="A caminho" description="Saldo pendente das compras enviadas, por produto.">
                {data.inbound.length === 0 ? (
                  <p className="text-sm text-ink-soft">Nada a caminho.</p>
                ) : (
                  <div className="-mx-4 overflow-x-auto sm:-mx-5">
                    <table className="w-full min-w-[480px] text-sm" data-testid="supply-inbound">
                      <thead className="text-left text-xs text-ink-soft">
                        <tr className="border-b border-line">
                          <th className="py-2 pl-4 font-medium sm:pl-5">Produto</th>
                          <th className="py-2 pl-3 text-right font-medium">Quantidade</th>
                          <th className="py-2 pl-3 font-medium">Próxima data</th>
                          <th className="py-2 pr-4 pl-3 font-medium sm:pr-5">Compras</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {data.inbound.map((i) => (
                          <tr key={i.variantId}>
                            <td className="py-2 pl-4 sm:pl-5">
                              {i.productName}
                              <span className="block font-mono text-xs text-ink-faint">{i.sku}</span>
                            </td>
                            <td className="num py-2 pl-3 text-right">{qty(i.pendingBase)}</td>
                            <td className={`py-2 pl-3 ${i.late ? 'text-bad' : ''}`}>{i.nextDate ? day(i.nextDate) : 'sem previsão'}</td>
                            <td className="py-2 pr-4 pl-3 text-xs sm:pr-5">{i.orders.map((n) => `nº ${n}`).join(', ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>

            <div className="min-w-0 space-y-5">
              <Panel title="Encomendas afetadas" description="Só o número do pedido. Nada é avisado ao cliente nesta fase.">
                {data.affected.linked.length === 0 && data.affected.withoutPurchase.length === 0 ? (
                  <p className="text-sm text-ink-soft">Nenhuma encomenda afetada.</p>
                ) : (
                  <ul className="divide-y divide-line text-sm" data-testid="supply-affected">
                    {data.affected.linked.map((a) => (
                      <li key={`${a.orderNumber}-${a.purchaseOrderId}-${a.sku}`} className="py-2">
                        <span className="font-medium">Pedido nº {a.orderNumber}</span> · {a.productName} · {qty(a.baseQty)}
                        <span className="block text-xs text-ink-faint">
                          <Link href={`/painel/compras/${a.purchaseOrderId}`} className="hover:underline">
                            compra nº {a.purchaseNumber}
                          </Link>{' '}
                          · {SUPPLY[a.category]?.label ?? a.category}
                          {a.refDate ? ` · ${day(a.refDate)}` : ''}
                        </span>
                      </li>
                    ))}
                    {data.affected.withoutPurchase.map((a) => (
                      <li key={`${a.order_number}-${a.sku}`} className="py-2">
                        <span className="font-medium">Pedido nº {a.order_number}</span> · {a.product_name} · {qty(a.unlinked)}
                        <span className="block text-xs text-ink-faint">
                          Sem compra · {a.warehouse_name}
                          {a.request_number ? ` · requisição nº ${a.request_number} (${a.request_status === 'open' ? 'aberta' : a.request_status === 'rejected' ? 'recusada' : a.request_status})` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel
                title="Desempenho dos fornecedores"
                description="Compras enviadas no período. O prazo sugerido é só uma referência: o cadastro não muda sozinho."
                actions={
                  <Select aria-label="Período" className="w-auto" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value="30">30 dias</option>
                    <option value="90">90 dias</option>
                    <option value="180">180 dias</option>
                  </Select>
                }
              >
                {!perf || perf.suppliers.length === 0 ? (
                  <p className="text-sm text-ink-soft">Sem compras enviadas no período.</p>
                ) : (
                  <ul className="divide-y divide-line text-sm" data-testid="supply-performance">
                    {perf.suppliers.map((p) => (
                      <li key={p.supplier_id} className="py-2">
                        <p className="font-medium">{p.supplier_name}</p>
                        <p className="text-xs text-ink-soft">
                          {p.sent} enviada(s) · confirmação {p.confirmation_rate_pct ?? '—'}%
                          {p.avg_confirm_hours ? ` em ${Number(p.avg_confirm_hours).toLocaleString('pt-BR')} h` : ''} · no prazo {p.on_time_pct ?? '—'}%
                          {p.due_samples ? ` (${p.due_samples})` : ''}
                        </p>
                        <p className="text-xs text-ink-soft">
                          Prazo médio {p.avg_lead_days ? `${Number(p.avg_lead_days).toLocaleString('pt-BR')} dia(s)` : '—'} · cadastrado {p.registered_lead_days ?? '—'}
                          {p.suggested_lead_days !== null ? ` · sugerido ${p.suggested_lead_days}` : ''}
                        </p>
                        {p.confirmations_changed + p.confirmations_refused + p.issues_quantity + p.issues_price + p.issues_quality + p.issues_wrong_item > 0 && (
                          <p className="text-xs text-warn">
                            Alterações {p.confirmations_changed} · recusas {p.confirmations_refused} · divergências: quantidade {p.issues_quantity}, preço {p.issues_price}, qualidade{' '}
                            {p.issues_quality}, item errado {p.issues_wrong_item}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function AbastecimentoPage() {
  return (
    <Guard perm="logistics.view|purchases.view">
      <Page />
    </Guard>
  );
}
