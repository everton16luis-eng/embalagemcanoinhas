'use client';

import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { LogisticsBadge } from '@/components/logistics';
import { CHANNEL_LABEL } from '@/components/orders';
import { SHIPMENT_KIND, ShipmentBadge } from '@/components/shipments';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

type Row = {
  id: string;
  order_id: string;
  seq: number;
  kind: string;
  status: string;
  created_at: string;
  shipped_at: string | null;
  tracking_code: string | null;
  warehouse_name: string | null;
  order_number: number;
  logistics_status: string | null;
  paid_at: string | null;
  channel: string;
  invoice_status: string;
  buyer_name: string | null;
  items: number;
  total_qty: string;
  picked_qty: string;
  checked_qty: string;
  has_backorder: boolean;
};
type Queue = { items: Row[]; total: number; counts: Record<string, number> };
type Settings = { multi_shipment_status: string; multi_validator_name: string | null; multi_validated_at: string | null; multi_validated_by_name: string | null; distinct_checker: boolean; version: number };

const TABS: [string, string][] = [
  ['open', 'Em aberto'],
  ['pending', 'A separar'],
  ['picking', 'Em separação'],
  ['checking', 'Em conferência'],
  ['packed', 'Embaladas'],
  ['shipped', 'Despachadas'],
  ['delivered', 'Entregues'],
  ['canceled', 'Canceladas'],
];
const invoiceOk = (s: string) => s === 'authorized' || s === 'not_required';

/** Travas da expedicao: remessas multiplas (validacao fiscal) e conferente diferente do separador. */
function ShippingSettings() {
  const { can } = useMe();
  const [s, setS] = useState<Settings | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const load = useCallback(() => api<{ settings: Settings }>('/admin/shipments/settings').then((r) => setS(r.settings), (e) => setMsg({ tone: 'bad', text: e.message })), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!s) return null;
  const multi = s.multi_shipment_status === 'enabled';
  const put = async (what: string, path: string, body: Record<string, unknown>, ok: string) => {
    setBusy(what);
    setMsg(null);
    try {
      await api(`/admin/shipments/settings/${path}`, { method: 'PUT', body: { ...body, version: s.version } });
      setMsg({ tone: 'good', text: ok });
      setName('');
      setConfirming(false);
      await load();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
      await load();
    } finally {
      setBusy('');
    }
  };
  return (
    <Panel title="Regras da expedição" description="Entrega parcial depende de validação fiscal; enquanto travada, cada pedido sai numa remessa só.">
      {msg && (
        <div className="mb-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium">
            Remessas múltiplas (entrega parcial) <Badge tone={multi ? 'warn' : 'neutral'}>{multi ? 'Liberadas' : 'Travadas'}</Badge>
          </p>
          {multi && s.multi_validated_at && (
            <p className="mt-1 text-ink-soft">
              Validado por {s.multi_validator_name}, registrado por {s.multi_validated_by_name} em {when(s.multi_validated_at)}.
            </p>
          )}
          {can('settings.manage') &&
            (multi ? (
              <Button className="mt-2" variant="danger" busy={busy === 'multi'} onClick={() => put('multi', 'multi-shipment', { status: 'blocked' }, 'Remessas múltiplas travadas.')}>
                Travar de novo
              </Button>
            ) : (
              <form
                className="mt-2 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!confirming) return setConfirming(true);
                  void put('multi', 'multi-shipment', { status: 'enabled', fiscalValidatorName: name.trim() }, 'Remessas múltiplas liberadas.');
                }}
              >
                <Field label="Quem validou o tratamento fiscal da entrega parcial" required>
                  {(fid) => <Input id={fid} required minLength={3} maxLength={120} value={name} onChange={(e) => { setName(e.target.value); setConfirming(false); }} />}
                </Field>
                {confirming && <Notice tone="warn">Confirme: só libere depois que o contador definir como emitir a NF-e numa entrega parcial. A liberação fica registrada com o seu nome.</Notice>}
                <Button type="submit" busy={busy === 'multi'}>
                  {confirming ? 'Confirmar liberação' : 'Liberar'}
                </Button>
              </form>
            ))}
        </div>
        <div className="border-t border-line pt-3">
          <p className="font-medium">
            Conferente diferente de quem separou <Badge tone={s.distinct_checker ? 'act' : 'neutral'}>{s.distinct_checker ? 'Exigido' : 'Não exigido'}</Badge>
          </p>
          {can('settings.manage') && (
            <Button className="mt-2" busy={busy === 'checker'} onClick={() => put('checker', 'distinct-checker', { enabled: !s.distinct_checker }, s.distinct_checker ? 'Conferente distinto desligado.' : 'Conferente distinto exigido.')}>
              {s.distinct_checker ? 'Deixar de exigir' : 'Exigir conferente distinto'}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ShippingQueue() {
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Queue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setPage(1), [status, search]);
  useEffect(() => {
    setError('');
    const qs = new URLSearchParams({ status, page: String(page), pageSize: '30', ...(search ? { q: search } : {}) });
    api<Queue>(`/admin/shipments?${qs}`).then(setData, (e) => setError(e.message));
  }, [status, page, search]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 30)) : 1;
  const c = data?.counts ?? {};

  return (
    <>
      <PageHeader title="Expedição" description="Remessas dos pedidos alocados: separar, conferir, embalar e despachar. Separar e conferir só registram; o estoque baixa no despacho." />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ['pending', 'A separar', 'warn'],
            ['picking', 'Em separação', 'act'],
            ['checking', 'Em conferência', 'act'],
            ['packed', 'Embaladas', 'good'],
          ] as const
        ).map(([k, label, tone]) => (
          <button key={k} onClick={() => setStatus(k)} className={`rounded-lg border bg-card px-3 py-2 text-left ${status === k ? 'border-act' : 'border-line'} hover:bg-sunken/40`}>
            <span className="block text-xs text-ink-soft">{label}</span>
            <span className="num text-xl font-semibold">{c[k] ?? 0}</span>
            {tone === 'good' && (c[k] ?? 0) > 0 && <span className="block text-[11px] text-good">prontas para sair</span>}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div role="tablist" aria-label="Situação" className="flex max-w-full gap-1 overflow-x-auto pb-1">
          {TABS.map(([k, v]) => (
            <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(k)} className={`shrink-0 rounded-md px-2.5 py-1.5 text-sm ${status === k ? 'bg-ink text-white' : 'text-ink-soft hover:bg-sunken'}`}>
              {v}
            </button>
          ))}
        </div>
        <form
          className="flex min-w-0 flex-1 gap-2 sm:max-w-xs"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
          }}
        >
          <Input aria-label="Buscar" placeholder="Pedido, cliente ou rastreio" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit">Buscar</Button>
        </form>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {!data && !error && <p className="py-8 text-center text-sm text-ink-faint">Carregando…</p>}
      {data && (
        <div className="mb-4 rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title={search ? 'Nenhuma remessa encontrada.' : 'Nenhuma remessa nesta situação.'}>
              {status === 'open' && !search && 'As remessas nascem quando a alocação do pedido é confirmada.'}
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((s) => {
                const total = Number(s.total_qty);
                const done = s.status === 'checking' ? Number(s.checked_qty) : Number(s.picked_qty);
                const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                const pend: string[] = [];
                if (s.logistics_status === 'analysis') pend.push('Pedido em análise');
                if (s.has_backorder && ['pending', 'picking'].includes(s.status)) pend.push('Tem encomenda');
                if (s.status === 'packed' && !invoiceOk(s.invoice_status)) pend.push('Aguardando NF-e');
                return (
                  <li key={s.id}>
                    <Link href={`/painel/logistica/expedicao/${s.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-sunken/40 sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">
                          Pedido nº {s.order_number} · remessa {s.seq}
                          <span className="font-normal text-ink-faint"> · {SHIPMENT_KIND[s.kind] ?? s.kind}</span>
                        </span>
                        <span className="block truncate text-xs text-ink-faint">
                          {s.buyer_name ?? CHANNEL_LABEL[s.channel] ?? s.channel} · {s.items} {s.items === 1 ? 'item' : 'itens'} ({qty(s.total_qty)}) · {s.warehouse_name}
                          {s.paid_at && ` · pago ${when(s.paid_at)}`}
                          {s.tracking_code && ` · ${s.tracking_code}`}
                        </span>
                        {['picking', 'checking'].includes(s.status) && (
                          <span className="mt-1 block h-1.5 w-full max-w-48 overflow-hidden rounded bg-sunken" aria-label={`${pct}% ${s.status === 'checking' ? 'conferido' : 'separado'}`}>
                            <span className="block h-full bg-act" style={{ width: `${pct}%` }} />
                          </span>
                        )}
                        {pend.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {pend.map((p) => (
                              <Badge key={p} tone="warn">
                                {p}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {s.logistics_status && s.logistics_status !== 'processing' && <LogisticsBadge status={s.logistics_status} />}
                        <ShipmentBadge status={s.status} />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {data && pages > 1 && (
        <div className="mb-4 flex items-center justify-end gap-2 text-sm">
          <button className="rounded px-2 py-1 hover:bg-sunken disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Anterior
          </button>
          <span className="text-ink-soft">
            {page} de {pages}
          </span>
          <button className="rounded px-2 py-1 hover:bg-sunken disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Próxima
          </button>
        </div>
      )}
      <ShippingSettings />
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="logistics.view">
      <ShippingQueue />
    </Guard>
  );
}
