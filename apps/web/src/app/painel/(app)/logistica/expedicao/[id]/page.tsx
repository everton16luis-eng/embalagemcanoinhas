'use client';

import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LogisticsBadge } from '@/components/logistics';
import { SHIPMENT_KIND, SHIPMENT_STEPS, ShipmentBadge } from '@/components/shipments';
import { Guard, useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Textarea, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty, when } from '@/lib/format';

type Item = {
  id: string;
  sku: string;
  product_name: string;
  packaging_label: string | null;
  base_qty: string;
  picked_qty: string;
  checked_qty: string;
  status: string;
  bin: string | null;
  backorder: boolean;
  base_unit: string;
};
type Shipment = {
  id: string;
  order_id: string;
  seq: number;
  kind: string;
  status: string;
  version: number;
  warehouse_name: string | null;
  carrier: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  volumes: number | null;
  weight_g: number | null;
  packages: { weightG: number; lengthMm?: number; widthMm?: number; heightMm?: number }[] | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancel_reason: string | null;
  order_number: number;
  order_status: string;
  logistics_status: string | null;
  logistics_note: string | null;
  invoice_status: string;
  ship_kind: string | null;
  ship_name: string | null;
  buyer_name: string | null;
  items: Item[];
  checks: { id: string; kind: string; sku: string | null; sku_read: string | null; qty: string; result: string; note: string | null; created_at: string; actor_name: string | null }[];
  events: { id: string; from_status: string | null; to_status: string; action: string; note: string | null; occurred_at: string; actor_name: string | null }[];
  settings: { multiShipment: string; distinctChecker: boolean };
  youPicked: boolean;
};

const CHECK_LABEL: Record<string, string> = {
  pick: 'Separado',
  unpick: 'Devolvido ao lugar',
  check: 'Conferido',
  check_undo: 'Conferência desfeita',
  shortage: 'Falta registrada',
  rejected: 'Recusado',
};
const RESULT_LABEL: Record<string, string> = { over: 'acima do previsto', wrong_sku: 'código de fora da remessa', mismatch: 'divergente' };
const ACTION_LABEL: Record<string, string> = {
  create: 'Remessa criada',
  create_request: 'Remessa criada',
  start_picking: 'Separação iniciada',
  finish_picking: 'Separação concluída',
  shortage: 'Falta na separação',
  reopen: 'Reaberta',
  pack: 'Embalada',
  dispatch: 'Despachada',
  handover: 'Entregue ao cliente',
  deliver: 'Entregue',
  release: 'Liberada para pendente',
  cancel: 'Cancelada',
  split: 'Dividida',
  reallocate: 'Cancelada pela realocação',
  order_canceled: 'Cancelada com o pedido',
};
const invoiceOk = (s: string) => s === 'authorized' || s === 'not_required';
const num = (v: string) => Number(v);

/** Confirmacao em dois passos para acao critica: o primeiro clique mostra o aviso, o segundo confirma. */
function Confirm({ label, confirmLabel, warning, variant = 'primary', busy, onConfirm, disabled }: { label: string; confirmLabel: string; warning: ReactNode; variant?: 'primary' | 'danger'; busy: boolean; onConfirm: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button variant={variant} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <div className="w-full space-y-2">
      <Notice tone="warn">{warning}</Notice>
      <div className="flex flex-wrap gap-2">
        <Button variant={variant} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={() => setAsking(false)}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

/** Pede um motivo antes de agir (devolver ao lugar, falta, reabrir, cancelar). */
function ReasonForm({ label, button, variant = 'secondary', busy, onSubmit, onCancel, extra }: { label: string; button: string; variant?: 'secondary' | 'danger' | 'primary'; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void; extra?: ReactNode }) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="mt-2 w-full space-y-2 rounded-md border border-line bg-sunken/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason.trim());
      }}
    >
      {extra}
      <Field label={label} required>
        {(fid) => <Textarea id={fid} required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-16" />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} busy={busy}>
          {button}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Voltar
        </Button>
      </div>
    </form>
  );
}

function Stepper({ status }: { status: string }) {
  if (status === 'canceled') return <Notice tone="neutral">Remessa cancelada.</Notice>;
  const idx = SHIPMENT_STEPS.findIndex(([k]) => k === status);
  return (
    <ol className="grid grid-cols-3 overflow-hidden rounded-md border border-line text-center text-xs font-medium sm:grid-cols-6">
      {SHIPMENT_STEPS.map(([k, label], i) => (
        <li key={k} aria-current={i === idx ? 'step' : undefined} className={`border-line px-1 py-2 not-last:border-r max-sm:[&:nth-child(-n+3)]:border-b ${i < idx ? 'bg-good-tint text-good' : i === idx ? 'bg-ink text-white' : 'text-ink-faint'}`}>
          {label}
        </li>
      ))}
    </ol>
  );
}

function ItemRow({ it, s, busy, run }: { it: Item; s: Shipment; busy: string; run: (what: string, path: string, body: Record<string, unknown>, ok: string) => Promise<boolean> }) {
  const { can } = useMe();
  const rest = num(it.base_qty) - num(it.picked_qty);
  const [amount, setAmount] = useState(String(rest > 0 ? rest : '').replace('.', ','));
  const [mode, setMode] = useState<'' | 'unpick' | 'shortage' | 'undo'>('');
  const [found, setFound] = useState('');
  const [undoQty, setUndoQty] = useState('');
  useEffect(() => setAmount(String(rest > 0 ? rest : '').replace('.', ',')), [rest]);
  const picking = s.status === 'picking';
  const mayPick = can('shipping.pick');
  const pickedPct = Math.min(100, (num(it.picked_qty) / num(it.base_qty)) * 100);
  const checkedPct = Math.min(100, (num(it.checked_qty) / num(it.base_qty)) * 100);
  const complete = s.status === 'checking' ? num(it.checked_qty) === num(it.base_qty) : num(it.picked_qty) === num(it.base_qty);

  return (
    <li className={`px-4 py-3 sm:px-5 ${complete ? 'bg-good-tint/30' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            <span className="num">{it.sku}</span>
            {it.bin && <Badge tone="act">Local {it.bin}</Badge>}
            {it.backorder && (
              <span className="ml-1">
                <Badge tone="warn">Encomenda</Badge>
              </span>
            )}
          </p>
          <p className="text-sm text-ink-soft">
            {it.product_name}
            {it.packaging_label && ` · ${it.packaging_label}`}
          </p>
        </div>
        <p className="num text-sm sm:text-right">
          <span className="block">
            Previsto <b>{qty(it.base_qty)}</b> {it.base_unit}
          </span>
          <span className="block text-ink-soft">
            Separado {qty(it.picked_qty)} · conferido {qty(it.checked_qty)}
          </span>
        </p>
      </div>
      <div className="mt-2 grid gap-1">
        <span className="h-1.5 overflow-hidden rounded bg-sunken" aria-label={`Separado ${Math.round(pickedPct)}%`}>
          <span className="block h-full bg-act" style={{ width: `${pickedPct}%` }} />
        </span>
        {['checking', 'packed'].includes(s.status) && (
          <span className="h-1.5 overflow-hidden rounded bg-sunken" aria-label={`Conferido ${Math.round(checkedPct)}%`}>
            <span className="block h-full bg-good" style={{ width: `${checkedPct}%` }} />
          </span>
        )}
      </div>
      {mayPick && picking && rest > 0 && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`pick-${it.id}`, 'pick', { itemId: it.id, qty: parseQty(amount) }, `${it.sku}: separado.`);
          }}
        >
          <Field label="Quantidade separada" className="w-36">
            {(fid) => <Input id={fid} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" busy={busy === `pick-${it.id}`}>
            Separar
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode(mode === 'shortage' ? '' : 'shortage')}>
            Não encontrei tudo
          </Button>
        </form>
      )}
      {mayPick && ['pending', 'picking'].includes(s.status) && num(it.picked_qty) - num(it.checked_qty) > 0 && mode !== 'unpick' && (
        <button className="mt-2 text-xs font-medium text-act hover:underline" onClick={() => setMode('unpick')}>
          Devolver ao lugar
        </button>
      )}
      {mayPick && s.status === 'checking' && num(it.checked_qty) > 0 && mode !== 'undo' && (
        <button className="mt-2 text-xs font-medium text-act hover:underline" onClick={() => setMode('undo')}>
          Desfazer conferência
        </button>
      )}
      {mode === 'shortage' && (
        <ReasonForm
          label="O que aconteceu"
          button="Registrar falta"
          variant="danger"
          busy={busy === `shortage-${it.id}`}
          onCancel={() => setMode('')}
          extra={
            <>
              <Field label="Quantidade encontrada no lugar" required className="w-48">
                {(fid) => <Input id={fid} inputMode="decimal" required value={found} onChange={(e) => setFound(e.target.value)} />}
              </Field>
              <p className="text-[13px] text-ink-soft">O pedido vai para análise e a remessa volta para “a separar”. Nada é baixado do estoque: o saldo é corrigido por inventário ou perda.</p>
            </>
          }
          onSubmit={(note) => void run(`shortage-${it.id}`, 'shortage', { itemId: it.id, found: parseQty(found), note }, 'Falta registrada. O pedido foi para análise.').then((ok) => ok && setMode(''))}
        />
      )}
      {mode === 'unpick' && (
        <ReasonForm
          label="Motivo"
          button="Devolver ao lugar"
          busy={busy === `unpick-${it.id}`}
          onCancel={() => setMode('')}
          extra={
            <Field label="Quantidade devolvida" required className="w-48">
              {(fid) => <Input id={fid} inputMode="decimal" required value={undoQty} onChange={(e) => setUndoQty(e.target.value)} placeholder={qty(num(it.picked_qty) - num(it.checked_qty))} />}
            </Field>
          }
          onSubmit={(note) => void run(`unpick-${it.id}`, 'unpick', { itemId: it.id, qty: parseQty(undoQty), note }, 'Registrado: mercadoria devolvida ao lugar.').then((ok) => ok && (setMode(''), setUndoQty('')))}
        />
      )}
      {mode === 'undo' && (
        <ReasonForm
          label="Motivo (o registro anterior continua no histórico)"
          button="Desfazer conferência"
          busy={busy === `undo-${it.id}`}
          onCancel={() => setMode('')}
          extra={
            <Field label="Quantidade a desfazer" required className="w-48">
              {(fid) => <Input id={fid} inputMode="decimal" required value={undoQty} onChange={(e) => setUndoQty(e.target.value)} placeholder={qty(it.checked_qty)} />}
            </Field>
          }
          onSubmit={(note) => void run(`undo-${it.id}`, 'check-undo', { itemId: it.id, qty: parseQty(undoQty), note }, 'Conferência desfeita.').then((ok) => ok && (setMode(''), setUndoQty('')))}
        />
      )}
    </li>
  );
}

/** Leitura por SKU (digitado ou bipado de etiqueta). Enter confere; o foco volta para o campo. */
function CheckScanner({ s, busy, run }: { s: Shipment; busy: string; run: (what: string, path: string, body: Record<string, unknown>, ok: string) => Promise<boolean> }) {
  const [sku, setSku] = useState('');
  const [amount, setAmount] = useState('1');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const blocked = s.settings.distinctChecker && s.youPicked;
  return (
    <Panel title="Conferência" description="Leia ou digite o SKU de cada item e a quantidade. Só aceita item da remessa e nunca acima do separado.">
      {blocked && (
        <div className="mb-3">
          <Notice tone="warn">A conferência desta remessa precisa ser feita por outra pessoa: você separou itens dela.</Notice>
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run('check', 'check', { sku: sku.trim(), qty: parseQty(amount) }, `${sku.trim()}: conferido.`).then((ok) => {
            if (ok) {
              setSku('');
              setAmount('1');
            }
            ref.current?.focus();
          });
        }}
      >
        <Field label="SKU" className="min-w-0 flex-1">
          {(fid) => <Input id={fid} ref={ref} required autoComplete="off" autoCapitalize="characters" value={sku} onChange={(e) => setSku(e.target.value)} disabled={blocked} />}
        </Field>
        <Field label="Quantidade" className="w-28">
          {(fid) => <Input id={fid} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} disabled={blocked} />}
        </Field>
        <Button type="submit" variant="primary" busy={busy === 'check'} disabled={blocked}>
          Conferir
        </Button>
      </form>
    </Panel>
  );
}

function PackForm({ s, busy, run }: { s: Shipment; busy: string; run: (what: string, path: string, body: Record<string, unknown>, ok: string) => Promise<boolean> }) {
  const [rows, setRows] = useState([{ weight: '', l: '', w: '', h: '' }]);
  const set = (i: number, k: 'weight' | 'l' | 'w' | 'h', v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v.replace(/\D/g, '') } : r)));
  const ready = s.items.filter((i) => i.status === 'active').every((i) => num(i.checked_qty) === num(i.base_qty));
  return (
    <Panel title="Embalagem" description="Volumes com o peso em gramas; medidas em milímetros quando houver.">
      {!ready && (
        <div className="mb-3">
          <Notice tone="warn">Termine a conferência de todos os itens para embalar.</Notice>
        </div>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const packages = rows.map((r) => ({ weightG: Number(r.weight), ...(r.l ? { lengthMm: Number(r.l) } : {}), ...(r.w ? { widthMm: Number(r.w) } : {}), ...(r.h ? { heightMm: Number(r.h) } : {}) }));
          void run('pack', 'pack', { version: s.version, packages }, 'Remessa embalada.');
        }}
      >
        {rows.map((r, i) => (
          <fieldset key={i} className="grid grid-cols-2 gap-2 rounded-md border border-line p-2 sm:grid-cols-5 sm:items-end">
            <legend className="px-1 text-xs text-ink-soft">Volume {i + 1}</legend>
            <Field label="Peso (g)" required>
              {(fid) => <Input id={fid} inputMode="numeric" required value={r.weight} onChange={(e) => set(i, 'weight', e.target.value)} />}
            </Field>
            <Field label="Compr. (mm)">{(fid) => <Input id={fid} inputMode="numeric" value={r.l} onChange={(e) => set(i, 'l', e.target.value)} />}</Field>
            <Field label="Largura (mm)">{(fid) => <Input id={fid} inputMode="numeric" value={r.w} onChange={(e) => set(i, 'w', e.target.value)} />}</Field>
            <Field label="Altura (mm)">{(fid) => <Input id={fid} inputMode="numeric" value={r.h} onChange={(e) => set(i, 'h', e.target.value)} />}</Field>
            {rows.length > 1 && (
              <Button type="button" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                Remover
              </Button>
            )}
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setRows([...rows, { weight: '', l: '', w: '', h: '' }])} disabled={rows.length >= 99}>
            Adicionar volume
          </Button>
          <Button type="submit" variant="primary" busy={busy === 'pack'} disabled={!ready}>
            Concluir embalagem
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function DispatchForm({ s, busy, run }: { s: Shipment; busy: string; run: (what: string, path: string, body: Record<string, unknown>, ok: string) => Promise<boolean> }) {
  const [f, setF] = useState({ carrier: '', trackingCode: '', trackingUrl: '' });
  const pickup = s.kind === 'pickup';
  const marketplace = s.kind === 'marketplace';
  const invoice = invoiceOk(s.invoice_status);
  const analysis = s.logistics_status === 'analysis';
  const body = { version: s.version, ...(f.carrier.trim() && !pickup && !marketplace ? { carrier: f.carrier.trim() } : {}), ...(f.trackingCode.trim() && !pickup ? { trackingCode: f.trackingCode.trim() } : {}), ...(f.trackingUrl.trim() && !pickup && !marketplace ? { trackingUrl: f.trackingUrl.trim() } : {}) };
  return (
    <Panel title={pickup ? 'Entrega ao cliente' : 'Despacho'} description={pickup ? 'O cliente retira na loja: ao entregar, o estoque da remessa é baixado.' : 'Baixa do estoque só o que está nesta remessa.'}>
      {!invoice && (
        <div className="mb-3">
          <Notice tone="warn">A NF-e deste pedido ainda não foi autorizada. {pickup ? 'A entrega' : 'O despacho'} fica bloqueado até a autorização.</Notice>
        </div>
      )}
      {analysis && (
        <div className="mb-3">
          <Notice tone="warn">O pedido está em análise. Resolva a alocação antes de despachar.</Notice>
        </div>
      )}
      {!pickup && (
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          {!marketplace && <Field label="Transportadora ou entregador">{(fid) => <Input id={fid} value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} />}</Field>}
          <Field label={marketplace ? 'Código informado pelo marketplace' : 'Código de rastreio'}>{(fid) => <Input id={fid} value={f.trackingCode} onChange={(e) => setF({ ...f, trackingCode: e.target.value })} />}</Field>
          {!marketplace && <Field label="Link de rastreio">{(fid) => <Input id={fid} type="url" value={f.trackingUrl} onChange={(e) => setF({ ...f, trackingUrl: e.target.value })} />}</Field>}
        </div>
      )}
      <Confirm
        label={pickup ? 'Entregar ao cliente' : 'Despachar'}
        confirmLabel={pickup ? 'Confirmar entrega e baixar estoque' : 'Confirmar despacho e baixar estoque'}
        warning={`${s.items.filter((i) => i.status === 'active').map((i) => `${i.sku}: ${qty(i.base_qty)}`).join(' · ')} sairão do estoque do ${s.warehouse_name}. Esta ação não pode ser desfeita.`}
        busy={busy === 'dispatch'}
        disabled={!invoice || analysis}
        onConfirm={() => void run('dispatch', 'dispatch', body, pickup ? 'Entregue ao cliente. Estoque baixado.' : 'Remessa despachada. Estoque baixado.')}
      />
    </Panel>
  );
}

function SplitForm({ s, busy, run, onClose }: { s: Shipment; busy: string; run: (what: string, path: string, body: Record<string, unknown>, ok: string) => Promise<boolean>; onClose: () => void }) {
  const [move, setMove] = useState<Record<string, string>>({});
  const items = s.items.filter((i) => i.status === 'active');
  return (
    <form
      className="mt-3 space-y-2 rounded-md border border-line bg-sunken/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const list = Object.entries(move)
          .filter(([, v]) => v.trim())
          .map(([itemId, v]) => ({ itemId, qty: parseQty(v) }));
        void run('split', 'split', { version: s.version, items: list }, 'Remessa dividida. A parte separada virou uma nova remessa.').then((ok) => ok && onClose());
      }}
    >
      <p className="text-sm font-medium">Quanto vai para a nova remessa</p>
      {items.map((i) => (
        <Field key={i.id} label={`${i.sku} (tem ${qty(i.base_qty)})`}>
          {(fid) => <Input id={fid} inputMode="decimal" value={move[i.id] ?? ''} onChange={(e) => setMove({ ...move, [i.id]: e.target.value })} />}
        </Field>
      ))}
      <div className="flex gap-2">
        <Button type="submit" busy={busy === 'split'}>
          Dividir
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Voltar
        </Button>
      </div>
    </form>
  );
}

function ShipmentScreen() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const [s, setS] = useState<Shipment | null>(null);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [panel, setPanel] = useState<'' | 'reopen' | 'release' | 'cancel' | 'split'>('');

  const load = useCallback(() => api<{ shipment: Shipment }>(`/admin/shipments/${id}`).then((r) => setS(r.shipment), (e) => setMsg({ tone: 'bad', text: e.message })), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (what: string, path: string, body: Record<string, unknown>, ok: string) => {
      setBusy(what);
      setMsg(null);
      try {
        const r = await api<{ shipment: Shipment }>(`/admin/shipments/${id}/${path}`, { method: 'POST', body: { ...body, requestKey: newKey() } });
        setS(r.shipment);
        setMsg({ tone: 'good', text: ok });
        return true;
      } catch (e) {
        setMsg({ tone: 'bad', text: (e as Error).message });
        await load();
        return false;
      } finally {
        setBusy('');
      }
    },
    [id, load],
  );

  if (!s) return msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : <p className="py-8 text-center text-sm text-ink-faint">Carregando…</p>;
  const items = s.items.filter((i) => i.status === 'active');
  const allPicked = items.every((i) => num(i.picked_qty) === num(i.base_qty));
  const open = ['pending', 'picking', 'checking', 'packed'].includes(s.status);
  const analysis = s.logistics_status === 'analysis';
  const picked = items.some((i) => num(i.picked_qty) > 0);

  return (
    <>
      <PageHeader
        title={`Pedido nº ${s.order_number} · remessa ${s.seq}`}
        description={
          <>
            {SHIPMENT_KIND[s.kind] ?? s.kind} · {s.warehouse_name}
            {s.buyer_name && ` · ${s.buyer_name}`}
          </>
        }
        actions={
          <span className="flex flex-wrap gap-2">
            {can('orders.view') && (
              <Link href={`/painel/pedidos/${s.order_id}`}>
                <Button>Ver pedido</Button>
              </Link>
            )}
            <Link href="/painel/logistica/expedicao">
              <Button>Voltar</Button>
            </Link>
          </span>
        }
      />
      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <ShipmentBadge status={s.status} />
          {s.logistics_status && s.logistics_status !== 'processing' && <LogisticsBadge status={s.logistics_status} />}
          {!invoiceOk(s.invoice_status) && <Badge tone="warn">NF-e pendente</Badge>}
        </div>
        <Stepper status={s.status} />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {analysis && s.logistics_note && <Notice tone="warn">{s.logistics_note}</Notice>}
        {s.cancel_reason && <Notice tone="neutral">Cancelada: {s.cancel_reason}</Notice>}

        {s.status === 'pending' && can('shipping.pick') && (
          <Panel title="Separação" description="Retire cada item do lugar e registre a quantidade. Nada sai do estoque até o despacho.">
            {analysis ? (
              <p className="text-sm text-ink-soft">O pedido está em análise: a separação volta a ser liberada quando a alocação for resolvida.{picked && ' Devolva ao lugar o que já foi separado antes da nova alocação.'}</p>
            ) : (
              <Button variant="primary" busy={busy === 'start'} onClick={() => void run('start', 'start', { version: s.version }, 'Separação iniciada.')}>
                Iniciar separação
              </Button>
            )}
          </Panel>
        )}

        {s.status === 'checking' && can('shipping.pick') && <CheckScanner s={s} busy={busy} run={run} />}

        <section className="rounded-lg border border-line bg-card">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
            <h2 className="text-[15px] font-semibold">Itens ({items.length})</h2>
            <span className="text-xs text-ink-faint">Ordenados pelo local no depósito</span>
          </header>
          {items.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-ink-soft">Sem itens ativos.</p>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((it) => (
                <ItemRow key={`${it.id}-${it.picked_qty}-${it.checked_qty}`} it={it} s={s} busy={busy} run={run} />
              ))}
            </ul>
          )}
          {s.status === 'picking' && can('shipping.pick') && (
            <div className="border-t border-line px-4 py-3 sm:px-5">
              <Button variant="primary" disabled={!allPicked} busy={busy === 'finish'} onClick={() => void run('finish', 'finish-picking', { version: s.version }, 'Separação concluída. Agora a conferência.')}>
                Concluir separação
              </Button>
              {!allPicked && <p className="mt-1 text-xs text-ink-faint">Separe todos os itens ou registre a falta.</p>}
            </div>
          )}
        </section>

        {s.status === 'checking' && can('shipping.pick') && <PackForm s={s} busy={busy} run={run} />}
        {s.status === 'packed' && (
          <Panel title="Volumes">
            <p className="text-sm">
              {s.volumes} volume(s) · {s.weight_g} g
            </p>
            {s.packages && (
              <ul className="mt-1 text-xs text-ink-soft">
                {s.packages.map((p, i) => (
                  <li key={i}>
                    Volume {i + 1}: {p.weightG} g{p.lengthMm ? ` · ${p.lengthMm}×${p.widthMm ?? '?'}×${p.heightMm ?? '?'} mm` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
        {s.status === 'packed' && can('shipping.manage') && <DispatchForm s={s} busy={busy} run={run} />}
        {['shipped', 'in_transit', 'out_for_delivery'].includes(s.status) && (
          <Panel title="Entrega">
            <p className="mb-2 text-sm">
              Saiu {when(s.shipped_at)}
              {s.carrier && ` · ${s.carrier}`}
              {s.tracking_code && ` · ${s.tracking_code}`}
            </p>
            {can('shipping.manage') && (
              <Confirm label="Marcar como entregue" confirmLabel="Confirmar entrega" warning="Confirme que o cliente recebeu esta remessa." busy={busy === 'deliver'} onConfirm={() => void run('deliver', 'deliver', { version: s.version }, 'Entrega registrada.')} />
            )}
          </Panel>
        )}
        {s.status === 'delivered' && <Notice tone="good">Entregue {when(s.delivered_at)}.</Notice>}

        {open && (can('shipping.pick') || can('logistics.manage')) && (
          <Panel title="Outras ações">
            <div className="flex flex-wrap gap-2">
              {['checking', 'packed'].includes(s.status) && can('shipping.pick') && (
                <Button onClick={() => setPanel(panel === 'reopen' ? '' : 'reopen')}>{s.status === 'checking' ? 'Voltar para a separação' : 'Voltar para a conferência'}</Button>
              )}
              {['picking', 'checking', 'packed'].includes(s.status) && can('logistics.manage') && <Button onClick={() => setPanel(panel === 'release' ? '' : 'release')}>Liberar para pendente</Button>}
              {s.status === 'pending' && can('logistics.manage') && s.settings.multiShipment === 'enabled' && <Button onClick={() => setPanel(panel === 'split' ? '' : 'split')}>Dividir remessa</Button>}
              {can('logistics.manage') && (
                <Button variant="danger" onClick={() => setPanel(panel === 'cancel' ? '' : 'cancel')}>
                  Cancelar remessa
                </Button>
              )}
            </div>
            {s.status === 'pending' && can('logistics.manage') && s.settings.multiShipment !== 'enabled' && (
              <p className="mt-2 text-xs text-ink-faint">Dividir em mais de uma remessa está travado até a validação fiscal da entrega parcial.</p>
            )}
            {panel === 'reopen' && (
              <ReasonForm
                label="Motivo"
                button="Reabrir"
                busy={busy === 'reopen'}
                onCancel={() => setPanel('')}
                onSubmit={(note) => void run('reopen', 'reopen', { version: s.version, to: s.status === 'checking' ? 'picking' : 'checking', note }, 'Remessa reaberta.').then((ok) => ok && setPanel(''))}
              />
            )}
            {panel === 'release' && (
              <ReasonForm
                label="Motivo"
                button="Liberar para pendente"
                busy={busy === 'release'}
                onCancel={() => setPanel('')}
                extra={<p className="text-[13px] text-ink-soft">O que já foi separado continua registrado; devolva ao lugar antes de trocar a alocação.</p>}
                onSubmit={(note) => void run('release', 'release', { version: s.version, note }, 'Remessa voltou para pendente.').then((ok) => ok && setPanel(''))}
              />
            )}
            {panel === 'cancel' && (
              <ReasonForm
                label="Motivo do cancelamento"
                button="Cancelar remessa"
                variant="danger"
                busy={busy === 'cancel'}
                onCancel={() => setPanel('')}
                extra={
                  picked ? (
                    <Notice tone="warn">Há mercadoria separada. Devolva ao lugar (em cada item) antes de cancelar.</Notice>
                  ) : (
                    <p className="text-[13px] text-ink-soft">As reservas continuam com o pedido. Uma nova remessa pode ser criada depois.</p>
                  )
                }
                onSubmit={(reason) => void run('cancel', 'cancel', { version: s.version, reason }, 'Remessa cancelada.').then((ok) => ok && setPanel(''))}
              />
            )}
            {panel === 'split' && <SplitForm s={s} busy={busy} run={run} onClose={() => setPanel('')} />}
          </Panel>
        )}

        <Panel title="Histórico">
          {s.checks.length === 0 && s.events.length === 0 ? (
            <p className="text-sm text-ink-faint">Nada registrado ainda.</p>
          ) : (
            <ol className="space-y-1.5 text-[13px]">
              {[
                ...s.events.map((e) => ({ at: e.occurred_at, key: `e${e.id}`, title: e.action === 'handover' && e.to_status === 'shipped' ? 'Saída para o cliente (estoque baixado)' : (ACTION_LABEL[e.action] ?? e.action), note: e.note, actor: e.actor_name, tone: 'neutral' as Tone })),
                ...s.checks.map((c) => ({
                  at: c.created_at,
                  key: `c${c.id}`,
                  title: `${CHECK_LABEL[c.kind] ?? c.kind}: ${c.sku ?? c.sku_read ?? ''} ${qty(c.qty)}${c.kind === 'rejected' ? ` (${RESULT_LABEL[c.result] ?? c.result})` : ''}`,
                  note: c.note,
                  actor: c.actor_name,
                  tone: (c.kind === 'rejected' || c.kind === 'shortage' ? 'bad' : 'neutral') as Tone,
                })),
              ]
                .sort((a, b) => (a.at < b.at ? 1 : -1))
                .map((x) => (
                  <li key={x.key}>
                    <span className={`font-medium ${x.tone === 'bad' ? 'text-bad' : ''}`}>{x.title}</span>
                    <span className="text-ink-faint">
                      {' '}
                      · {when(x.at)} · {x.actor ?? 'sistema'}
                    </span>
                    {x.note && <span className="block text-ink-soft">{x.note}</span>}
                  </li>
                ))}
            </ol>
          )}
        </Panel>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="logistics.view">
      <ShipmentScreen />
    </Guard>
  );
}
