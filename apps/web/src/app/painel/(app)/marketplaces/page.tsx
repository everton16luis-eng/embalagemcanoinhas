'use client';

import Link from '@/components/painel-link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, when } from '@/lib/format';

type Channel = 'mercadolivre' | 'shopee';
type Account = { id: string; channel: Channel; external_id: string; name: string; status: string; last_error: string | null; refresh_expires_at: string | null; connected_by_name: string; updated_at: string };
type Overview = { channels: { channel: Channel; name: string; configured: boolean; fake: boolean }[]; accounts: Account[]; counts: { account_id: string; state: string; n: number }[] };
type Listing = {
  id: string;
  account_id: string;
  channel: Channel;
  account_name: string;
  external_item_id: string;
  external_variation_id: string;
  title: string | null;
  sync_stock: boolean;
  active: boolean;
  last_pushed_qty: number | null;
  last_pushed_at: string | null;
  last_error: string | null;
  packaging_label: string;
  sku: string;
  product_name: string;
  availability_mode: string;
  packs_available: number;
};
type Sale = {
  id: string;
  channel: Channel;
  account_name: string;
  external_order_id: string;
  external_status: string | null;
  state: string;
  last_error: string | null;
  next_check_at: string;
  created_at: string;
  order_id: string | null;
  order_number: number | null;
  order_status: string | null;
  total_cents: string | null;
};
type Pack = { id: string; label: string; sku: string; product_name: string; packs_available: number; availability_mode: string };

const ACCOUNT_STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'neutral' }> = {
  active: { label: 'Conectada', tone: 'good' },
  reauth_required: { label: 'Autorizar de novo', tone: 'warn' },
  disconnected: { label: 'Desconectada', tone: 'neutral' },
};
const SALE_STATE: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' | 'act' }> = {
  pending: { label: 'Na fila', tone: 'act' },
  waiting: { label: 'Aguardando pagamento', tone: 'neutral' },
  imported: { label: 'Importada', tone: 'good' },
  error: { label: 'Precisa de ação', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
  ignored: { label: 'Não paga (encerrada)', tone: 'neutral' },
};

function Accounts({ data, reload }: { data: Overview; reload: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function connect(channel: Channel) {
    setBusy(channel);
    setError('');
    try {
      const { url } = await api<{ url: string }>('/admin/marketplaces/connect', { method: 'POST', body: { channel } });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  }
  async function disconnect(a: Account) {
    if (!confirm(`Desconectar ${a.name}? Vendas novas deixam de entrar até conectar de novo. Revogue também a autorização no painel do marketplace.`)) return;
    await api(`/admin/marketplaces/accounts/${a.id}/disconnect`, { method: 'POST', body: {} }).then(reload, (e) => setError(e.message));
  }
  return (
    <Panel title="Contas" description="A conta é autorizada no próprio marketplace; aqui ficam só os tokens de acesso, cifrados.">
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        {data.channels.map((c) => {
          const accounts = data.accounts.filter((a) => a.channel === c.channel);
          return (
            <div key={c.channel} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">
                  {c.name} {c.fake && <Badge tone="warn">simulado</Badge>}
                </h3>
                {c.configured ? (
                  <Button variant="primary" busy={busy === c.channel} onClick={() => connect(c.channel)}>
                    {accounts.length ? 'Conectar outra / reautorizar' : 'Conectar conta'}
                  </Button>
                ) : (
                  <Badge>Não configurado</Badge>
                )}
              </div>
              {!c.configured && <p className="mt-2 text-sm text-ink-soft">Falta cadastrar o aplicativo no {c.name} e colocar as credenciais no .env do servidor.</p>}
              <ul className="mt-2 space-y-2">
                {accounts.map((a) => {
                  const err = data.counts.find((n) => n.account_id === a.id && n.state === 'error')?.n ?? 0;
                  return (
                    <li key={a.id} className="border-t border-line pt-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{a.name}</span>
                        <Badge tone={ACCOUNT_STATUS[a.status]?.tone}>{ACCOUNT_STATUS[a.status]?.label ?? a.status}</Badge>
                        {err > 0 && <Badge tone="bad">{err} venda(s) precisando de ação</Badge>}
                      </div>
                      <p className="text-xs text-ink-soft">
                        ID {a.external_id} · conectada por {a.connected_by_name}
                        {a.refresh_expires_at && a.status === 'active' && ` · autorização válida até ${when(a.refresh_expires_at)}`}
                      </p>
                      {a.last_error && <p className="mt-1 text-xs text-bad">{a.last_error}</p>}
                      {a.status !== 'disconnected' && (
                        <Button variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => disconnect(a)}>
                          Desconectar
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function LinkForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const active = accounts.filter((a) => a.status === 'active');
  const [accountId, setAccountId] = useState(active[0]?.id ?? '');
  const [itemId, setItemId] = useState('');
  const [variationId, setVariationId] = useState('');
  const [q, setQ] = useState('');
  const [packs, setPacks] = useState<Pack[]>([]);
  const [packagingId, setPackagingId] = useState('');
  const [sync, setSync] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const channel = accounts.find((a) => a.id === accountId)?.channel;

  useEffect(() => {
    if (q.trim().length < 2) return setPacks([]);
    const t = setTimeout(() => api<{ packagings: Pack[] }>(`/admin/marketplaces/packagings?q=${encodeURIComponent(q.trim())}`).then((r) => setPacks(r.packagings), () => setPacks([])), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ syncStock: boolean }>('/admin/marketplaces/listings', {
        method: 'POST',
        body: { accountId, externalItemId: itemId.trim(), externalVariationId: variationId.trim() || undefined, packagingId, syncStock: sync },
      });
      setMsg({ tone: 'good', text: r.syncStock || !sync ? 'Anúncio vinculado.' : 'Anúncio vinculado. Anúncio com variação no Mercado Livre: o saldo continua sendo ajustado à mão lá.' });
      setItemId('');
      setVariationId('');
      onDone();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!active.length) return <p className="text-sm text-ink-soft">Conecte uma conta para vincular anúncios.</p>;
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Conta" required>
        {(id) => (
          <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={channel === 'shopee' ? 'item_id do anúncio' : 'Código do anúncio (MLB…)'} required>
        {(id) => <Input id={id} value={itemId} onChange={(e) => setItemId(e.target.value)} required maxLength={40} autoComplete="off" />}
      </Field>
      <Field label={channel === 'shopee' ? 'model_id (vazio se não tem variação)' : 'ID da variação (vazio se não tem)'}>
        {(id) => <Input id={id} value={variationId} onChange={(e) => setVariationId(e.target.value)} inputMode="numeric" maxLength={30} autoComplete="off" />}
      </Field>
      <Field label="Embalagem vendida neste anúncio" required hint="Busque por nome, SKU ou código de barras.">
        {(id) => (
          <div className="space-y-1.5">
            <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: copo 200" autoComplete="off" />
            {packs.length > 0 && (
              <Select aria-label="Embalagem" value={packagingId} onChange={(e) => setPackagingId(e.target.value)} required>
                <option value="">Escolha…</option>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.product_name} · {p.label} · {p.sku} · {p.availability_mode === 'made_to_order' ? 'sob encomenda' : `${p.packs_available} disp.`}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} className="size-4" />
        Enviar o saldo disponível para o anúncio automaticamente
      </label>
      {msg && (
        <div className="sm:col-span-2">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" busy={busy} disabled={!accountId || !itemId.trim() || !packagingId}>
          Vincular anúncio
        </Button>
      </div>
    </form>
  );
}

function Listings({ data }: { data: Overview }) {
  const [rows, setRows] = useState<Listing[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const load = useCallback(() => api<{ listings: Listing[] }>('/admin/marketplaces/listings').then((r) => setRows(r.listings), (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  async function patch(l: Listing, body: Record<string, unknown>) {
    await api(`/admin/marketplaces/listings/${l.id}`, { method: 'PATCH', body }).then(load, (e) => setError(e.message));
  }
  async function pushAll() {
    setBusy(true);
    setNote('');
    try {
      const r = await api<{ pushed: number; failed: number }>('/admin/marketplaces/push-stock', { method: 'POST', body: {} });
      setNote(`${r.pushed} anúncio(s) atualizados${r.failed ? `, ${r.failed} com erro` : ''}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Anúncios vinculados"
      description="Cada anúncio (ou modelo da Shopee) corresponde a uma embalagem de venda. O saldo enviado é o disponível em embalagens, já descontadas as reservas."
      actions={
        <Button onClick={pushAll} busy={busy}>
          Enviar saldos agora
        </Button>
      }
    >
      <div className="mb-4">
        <LinkForm accounts={data.accounts} onDone={load} />
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {note && <Notice tone="good">{note}</Notice>}
      {rows && rows.length === 0 && <Empty title="Nenhum anúncio vinculado ainda." />}
      {rows && rows.length > 0 && (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-ink-soft">
              <tr>
                <th className="py-2 pl-4 font-medium sm:pl-0">Anúncio</th>
                <th className="py-2 pl-3 font-medium">Embalagem</th>
                <th className="py-2 pl-3 text-right font-medium">Disponível</th>
                <th className="hidden py-2 pl-3 font-medium md:table-cell">Último envio</th>
                <th className="py-2 pr-4 pl-3 font-medium sm:pr-0">Envio automático</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className={`border-b border-line align-top last:border-0 ${l.active ? '' : 'opacity-60'}`}>
                  <td className="py-2 pl-4 sm:pl-0">
                    <span className="font-mono text-xs">{l.external_item_id}</span>
                    {l.external_variation_id && <span className="text-xs text-ink-soft"> · var. {l.external_variation_id}</span>}
                    <span className="block text-xs text-ink-soft">{l.account_name}</span>
                    {l.last_error && <span className="block text-xs text-bad">{l.last_error}</span>}
                  </td>
                  <td className="py-2 pl-3">
                    {l.product_name}
                    <span className="block text-xs text-ink-soft">
                      {l.packaging_label} · {l.sku}
                    </span>
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">{l.availability_mode === 'made_to_order' ? <Badge>sob encomenda</Badge> : l.packs_available}</td>
                  <td className="hidden py-2 pl-3 text-xs text-ink-soft md:table-cell">{l.last_pushed_at ? `${l.last_pushed_qty ?? '—'} em ${when(l.last_pushed_at)}` : '—'}</td>
                  <td className="py-2 pr-4 pl-3 sm:pr-0">
                    <div className="flex flex-col items-start gap-1">
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={l.sync_stock}
                          disabled={!l.active || (l.channel === 'mercadolivre' && Boolean(l.external_variation_id))}
                          onChange={(e) => patch(l, { syncStock: e.target.checked })}
                          aria-label={`Envio automático de saldo do anúncio ${l.external_item_id}`}
                        />
                        {l.channel === 'mercadolivre' && l.external_variation_id ? 'manual (variação)' : 'saldo'}
                      </label>
                      <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => patch(l, { active: !l.active })}>
                        {l.active ? 'Desativar vínculo' : 'Reativar'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Sales({ accounts }: { accounts: Account[] }) {
  const [state, setState] = useState('');
  const [rows, setRows] = useState<Sale[] | null>(null);
  const [error, setError] = useState('');
  const [accountId, setAccountId] = useState(accounts.find((a) => a.status === 'active')?.id ?? '');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (state) p.set('state', state);
    return api<{ orders: Sale[] }>(`/admin/marketplaces/orders?${p}`).then((r) => setRows(r.orders), (e) => setError(e.message));
  }, [state]);
  useEffect(() => void load(), [load]);

  async function fetchSale(e: FormEvent) {
    e.preventDefault();
    setBusy('fetch');
    setError('');
    try {
      await api('/admin/marketplaces/orders', { method: 'POST', body: { accountId, externalOrderId: number.trim() } });
      setNumber('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function retry(s: Sale) {
    setBusy(s.id);
    await api(`/admin/marketplaces/orders/${s.id}/retry`, { method: 'POST', body: {} }).then(load, (e) => setError(e.message));
    setBusy('');
  }

  return (
    <Panel title="Vendas recebidas" description="O aviso do marketplace só dispara a consulta; a venda paga vira pedido pago, com o estoque reservado.">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Select aria-label="Situação da venda" value={state} onChange={(e) => setState(e.target.value)} className="w-auto">
          <option value="">Todas</option>
          {Object.entries(SALE_STATE).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        {accounts.some((a) => a.status === 'active') && (
          <form onSubmit={fetchSale} className="flex flex-wrap items-end gap-2">
            <Select aria-label="Conta" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-auto">
              {accounts
                .filter((a) => a.status === 'active')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
            <Input aria-label="Número da venda no marketplace" placeholder="Nº da venda" value={number} onChange={(e) => setNumber(e.target.value)} className="w-40" maxLength={40} />
            <Button type="submit" busy={busy === 'fetch'} disabled={!number.trim()}>
              Buscar venda
            </Button>
          </form>
        )}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {rows && rows.length === 0 && <Empty title="Nenhuma venda nesta situação." />}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{s.external_order_id}</span>
                  <Badge tone={SALE_STATE[s.state]?.tone}>{SALE_STATE[s.state]?.label ?? s.state}</Badge>
                  {s.external_status && <span className="text-xs text-ink-faint">{s.external_status}</span>}
                </div>
                <p className="text-xs text-ink-soft">
                  {s.account_name} · recebida {when(s.created_at)}
                </p>
                {s.last_error && <p className="mt-0.5 text-xs text-bad">{s.last_error}</p>}
              </div>
              <div className="flex items-center gap-2">
                {s.order_id && (
                  <Link href={`/painel/pedidos/${s.order_id}`} className="text-sm font-medium text-act hover:underline">
                    Pedido {s.order_number} · {money(s.total_cents)}
                  </Link>
                )}
                {['error', 'waiting', 'pending'].includes(s.state) && (
                  <Button className="h-8" busy={busy === s.id} onClick={() => retry(s)}>
                    Consultar agora
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MarketplacesPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Overview>('/admin/marketplaces').then(setData, (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  return (
    <>
      <PageHeader title="Marketplaces" description="Mercado Livre e Shopee: vendas pagas entram como pedido e o saldo dos anúncios acompanha o estoque." />
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="space-y-5">
          <Accounts data={data} reload={load} />
          <Listings data={data} />
          <Sales accounts={data.accounts} />
          <Notice>
            Nota fiscal das vendas de marketplace: emitida por nós, mas os dados do comprador ficam na plataforma. Até integrarmos a API de faturamento de cada
            uma, a emissão destes pedidos é manual (decisão com o contador).
          </Notice>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="marketplaces.manage">
      <MarketplacesPage />
    </Guard>
  );
}
