'use client';

// SGLog Fase 7: pedido ao fornecedor (documento com versoes), confirmacao do fornecedor, aprovacao do aumento de
// preco, contato de acompanhamento e situacao do abastecimento. O envio e manual: nada sai por e-mail do sistema.
import { Copy, Printer } from 'lucide-react';
import Link from '@/components/painel-link';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Field, Input, Notice, Panel, Select, Textarea, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { centsToInput, money, parseMoney, parseQty, qty, qtyToInput, when } from '@/lib/format';

export const CHANNEL: Record<string, string> = {
  printed: 'Impresso ou PDF',
  email: 'E-mail (enviado pela equipe)',
  whatsapp: 'WhatsApp (enviado pela equipe)',
  phone: 'Telefone',
  portal: 'Portal do fornecedor',
  other: 'Outro',
};

export const SUPPLY: Record<string, { label: string; tone: Tone }> = {
  untracked: { label: 'Anterior ao acompanhamento', tone: 'neutral' },
  awaiting_confirmation: { label: 'Aguardando confirmação', tone: 'act' },
  confirmation_late: { label: 'Confirmação atrasada', tone: 'bad' },
  price_approval: { label: 'Aumento de preço aguardando aprovação', tone: 'warn' },
  refused: { label: 'Recusada pelo fornecedor', tone: 'bad' },
  delivery_expected: { label: 'Entrega prevista', tone: 'good' },
  delivery_late: { label: 'Entrega atrasada', tone: 'bad' },
  no_date: { label: 'Entrega sem previsão definida', tone: 'warn' },
};

export const CONFIRMATION: Record<string, string> = {
  none: 'Sem acompanhamento',
  awaiting: 'Aguardando confirmação',
  confirmed: 'Confirmada',
  partial: 'Entrega parcial confirmada',
  changed: 'Confirmada com alteração',
  refused: 'Recusada',
  pending_approval: 'Aumento aguardando aprovação',
};

const OUTCOME: Record<string, string> = {
  confirmed: 'Confirmado (tudo o pendente)',
  partial: 'Entrega parcial (o restante continua pendente)',
  reduced: 'Quantidade reduzida (o restante é cancelado)',
  refused: 'Recusado (nada mais virá)',
};
const OUTCOME_SHORT: Record<string, string> = { confirmed: 'confirmado', partial: 'parcial', reduced: 'reduzido', refused: 'recusado' };
const CONF_STATUS: Record<string, { label: string; tone: Tone }> = {
  applied: { label: 'Aplicada', tone: 'good' },
  pending_approval: { label: 'Aguardando aprovação', tone: 'warn' },
  rejected: { label: 'Aumento recusado', tone: 'bad' },
  superseded: { label: 'Substituída', tone: 'neutral' },
};

export const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR') : '—');

export type SupplyInfo = { category: string; refDate: string | null; daysLate: number | null; confirmationDue: string | null } | null;
export type Confirmation = {
  id: string;
  version: number;
  outcome: string;
  channel: string;
  supplier_ref: string | null;
  promised_at: string | null;
  note: string | null;
  price_increase_cents: string;
  status: string;
  decided_at: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
  decision_self: boolean;
  actor_id: string;
  created_at: string;
  actor_name: string;
  items: { itemId: string; label: string; outcome: string; pendingPacks: string; confirmedPacks: string; orderedPackCostCents: string; confirmedPackCostCents: string; promisedAt: string | null; restPromisedAt: string | null; note: string | null }[] | null;
};
export type SupplyOrder = {
  id: string;
  status: string;
  version: number;
  sent_via: string | null;
  sent_document_version: number | null;
  supplier_ref: string | null;
  confirmation_status: string;
  promised_at: string | null;
  followup_on: string | null;
  supply: SupplyInfo;
  documents: { version: number; channel: string; content_hash: string; note: string | null; created_at: string; actor_name: string }[];
  confirmations: Confirmation[];
  requests: { id: string; number: number; source: string; status: string; base_qty: string; order_number: number | null; sku: string; product_name: string }[];
  items: { id: string; packaging_label: string; product_name: string; pack_cost_cents: string; pending_packs: string; promised_at: string | null; supplier_outcome: string | null; partial_packs: string | null; rest_promised_at: string | null; canceled_packs: string }[];
};

export function SupplyBadge({ supply }: { supply: SupplyInfo }) {
  if (!supply) return null;
  const s = SUPPLY[supply.category] ?? { label: supply.category, tone: 'neutral' as Tone };
  return (
    <span data-testid="supply-badge">
      <Badge tone={s.tone}>
        {s.label}
        {supply.category === 'delivery_late' && supply.daysLate ? ` há ${supply.daysLate} dia(s)` : ''}
        {['delivery_expected', 'delivery_late'].includes(supply.category) && supply.refDate ? ` · ${day(supply.refDate)}` : ''}
      </Badge>
    </span>
  );
}

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

type Preview = { document: unknown; text: string | null; missing: string[] };

/**
 * Pedido ao fornecedor (D7-1, D7-2): previa, o que falta, envio com canal (registro do envio feito pela equipe) e as
 * versoes enviadas (imutaveis). O texto pode ser copiado para WhatsApp ou e-mail e a versao impressa ou salva em PDF.
 */
export function DocumentPanel({ order, canManage, onChange }: { order: SupplyOrder; canManage: boolean; onChange: (o: never, text?: string) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [channel, setChannel] = useState('printed');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const canSend = canManage && order.status === 'approved';
  const canResend = canManage && ['sent', 'partial'].includes(order.status);

  useEffect(() => {
    if (!canSend && !canResend) return;
    const t = setTimeout(() => {
      api<Preview>(`/admin/purchase-orders/${order.id}/document${message.trim() ? `?message=${encodeURIComponent(message.trim())}` : ''}`).then(setPreview, (e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [order.id, order.version, message, canSend, canResend]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/${canSend ? 'send' : 'documents'}`, { method: 'POST', body: { channel, message: message.trim() || null } });
      setMessage('');
      onChange(r.order as never, r.document?.text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!canSend && !canResend && !order.documents.length) return null;
  return (
    <Panel title="Pedido ao fornecedor" description="O envio é feito pela equipe (impresso, PDF, WhatsApp ou e-mail). O sistema registra a versão enviada e não manda e-mail sozinho.">
      {order.documents.length > 0 && (
        <ul className="mb-3 divide-y divide-line text-sm" data-testid="po-documents">
          {order.documents
            .slice()
            .reverse()
            .map((d) => (
              <li key={d.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">Versão {d.version}</span> · {CHANNEL[d.channel] ?? d.channel}
                  <span className="block text-xs text-ink-faint">
                    {when(d.created_at)} · {d.actor_name}
                  </span>
                </span>
                <Link className="inline-flex items-center gap-1 text-sm font-medium text-act hover:underline" href={`/painel/compras/${order.id}/documento?v=${d.version}`}>
                  <Printer size={14} /> Ver e imprimir
                </Link>
              </li>
            ))}
        </ul>
      )}
      {(canSend || canResend) && (
        <form onSubmit={submit} className="space-y-3">
          {preview && preview.missing.length > 0 && (
            <div data-testid="document-missing">
              <Notice tone="warn">
                <span className="block font-medium">Faltam dados para gerar o pedido:</span>
                <ul className="mt-1 list-disc pl-5">
                  {preview.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <span className="mt-1 block">
                  Complete em{' '}
                  <Link className="underline" href="/painel/empresa">
                    Empresa
                  </Link>{' '}
                  ou{' '}
                  <Link className="underline" href="/painel/depositos">
                    Depósitos
                  </Link>
                  .
                </span>
              </Notice>
            </div>
          )}
          {preview?.text && (
            <details className="rounded-md border border-line bg-sunken/40 p-2 text-sm">
              <summary className="cursor-pointer font-medium">Prévia do texto</summary>
              <pre className="mt-2 max-h-72 overflow-auto text-xs whitespace-pre-wrap" data-testid="document-preview">
                {preview.text}
              </pre>
              <Button
                type="button"
                className="mt-2"
                onClick={async () => setCopied((await copy(preview.text!)) ? 'Texto copiado.' : 'Não foi possível copiar: selecione o texto e copie.')}
              >
                <Copy size={14} /> Copiar texto
              </Button>
              {copied && <span className="ml-2 text-xs text-ink-soft">{copied}</span>}
            </details>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Como foi enviado">
              {(id) => (
                <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {Object.entries(CHANNEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Mensagem ao fornecedor" hint="Vai no documento. As observações internas da compra não vão.">
              {(id) => <Textarea id={id} className="min-h-16" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />}
            </Field>
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <Button variant="primary" busy={busy} disabled={Boolean(preview?.missing.length)}>
            {canSend ? 'Registrar envio ao fornecedor' : 'Reenviar (nova versão)'}
          </Button>
        </form>
      )}
    </Panel>
  );
}

type Line = { outcome: string; packs: string; cost: string; promisedAt: string; restPromisedAt: string; note: string };

/**
 * Confirmacao do fornecedor (D7-3): resultado por item sobre o que esta pendente. Parcial mantem o restante; reducao
 * e recusa cancelam o saldo e liberam vinculos de encomendas que deixam de caber. Aumento acima da tolerancia fica
 * aguardando aprovacao (D7-4). Nada de estoque ou custo medio aqui.
 */
export function ConfirmationPanel({
  order,
  canManage,
  canApprove,
  meId,
  isOwner,
  onChange,
}: {
  order: SupplyOrder;
  canManage: boolean;
  canApprove: boolean;
  meId: string;
  isOwner: boolean;
  onChange: (o: never, summary?: string | null) => void;
}) {
  const open = ['sent', 'partial'].includes(order.status);
  const pendingItems = order.items.filter((i) => Number(i.pending_packs) > 0);
  const blank = (): Record<string, Line> =>
    Object.fromEntries(pendingItems.map((i) => [i.id, { outcome: 'confirmed', packs: '', cost: centsToInput(i.pack_cost_cents), promisedAt: '', restPromisedAt: '', note: '' }]));
  const [lines, setLines] = useState<Record<string, Line>>(blank);
  const [show, setShow] = useState(false);
  const [channel, setChannel] = useState('phone');
  const [ref, setRef] = useState(order.supplier_ref ?? '');
  const [promisedAt, setPromisedAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = order.confirmations.find((c) => c.status === 'pending_approval');
  const set = (id: string, patch: Partial<Line>) => setLines({ ...lines, [id]: { ...lines[id]!, ...patch } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const items = pendingItems.map((i) => {
      const l = lines[i.id]!;
      const cost = parseMoney(l.cost);
      return {
        itemId: i.id,
        outcome: l.outcome,
        ...(['partial', 'reduced'].includes(l.outcome) ? { packs: parseQty(l.packs) } : {}),
        ...(cost !== null && l.outcome !== 'refused' ? { packCostCents: cost } : {}),
        ...(l.promisedAt ? { promisedAt: l.promisedAt } : {}),
        ...(l.outcome === 'partial' && l.restPromisedAt ? { restPromisedAt: l.restPromisedAt } : {}),
        ...(l.note.trim().length >= 3 ? { note: l.note.trim() } : {}),
      };
    });
    setBusy(true);
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/confirmations`, {
        method: 'POST',
        body: { channel, supplierRef: ref.trim() || null, promisedAt: promisedAt || null, note: note.trim().length >= 3 ? note.trim() : null, items },
      });
      const parts = [
        r.confirmation.status === 'pending_approval' ? `Aumento de ${money(r.confirmation.increaseCents)} acima da tolerância: aguardando aprovação de outra pessoa. O recebimento fica travado até lá.` : 'Confirmação registrada.',
        r.released?.length ? `Encomendas que voltaram a aguardar compra (vínculo desfeito, pedido não cancelado): ${r.released.map((x: { orderNumber: number }) => `nº ${x.orderNumber}`).join(', ')}.` : '',
        r.closed ? 'Nada mais pendente: a compra foi encerrada.' : '',
      ].filter(Boolean);
      setShow(false);
      setNote('');
      onChange(r.order as never, parts.join(' '));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (c: Confirmation, approve: boolean) => {
    setError('');
    let body: Record<string, unknown>;
    if (approve) {
      const own = c.actor_id === meId;
      let n: string | null = null;
      if (own) {
        if (!isOwner) return setError('Quem registrou a confirmação não aprova o aumento. Peça a outra pessoa com a permissão.');
        n = window.prompt('Você registrou esta confirmação. Justifique a aprovação:');
        if (!n) return;
      }
      body = { version: c.version, increaseCents: Number(c.price_increase_cents), ...(n ? { note: n } : {}) };
    } else {
      const reason = window.prompt('Por que recusar o aumento? A compra volta a aguardar nova confirmação.');
      if (!reason) return;
      body = { reason };
    }
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/confirmations/${c.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body });
      onChange(
        r.order as never,
        approve ? `Aumento aprovado (versão ${c.version}).${r.released?.length ? ` Encomendas liberadas: ${r.released.map((x: { orderNumber: number }) => `nº ${x.orderNumber}`).join(', ')}.` : ''}` : 'Aumento recusado.',
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!open && !order.confirmations.length) return null;
  return (
    <Panel title="Confirmação do fornecedor" description={CONFIRMATION[order.confirmation_status] ?? order.confirmation_status}>
      {pending && (
        <div className="mb-3 rounded-md border border-warn/40 bg-warn/5 p-3 text-sm" data-testid="price-approval">
          <p className="font-medium">
            Aumento de {money(pending.price_increase_cents)} na versão {pending.version} aguardando aprovação
          </p>
          <ul className="mt-1 space-y-0.5 text-ink-soft">
            {(pending.items ?? [])
              .filter((i) => Number(i.confirmedPackCostCents) > Number(i.orderedPackCostCents))
              .map((i) => (
                <li key={i.itemId}>
                  {i.label}: {money(i.orderedPackCostCents)} → {money(i.confirmedPackCostCents)} por embalagem
                </li>
              ))}
          </ul>
          <p className="mt-1 text-xs text-ink-faint">
            Registrada por {pending.actor_name} em {when(pending.created_at)}. Aprovar exige a verificação em duas etapas; nada muda no estoque nem no custo médio.
          </p>
          {canApprove && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => decide(pending, true)}>
                Aprovar aumento
              </Button>
              <Button onClick={() => decide(pending, false)}>Recusar aumento</Button>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {open && canManage && pendingItems.length > 0 && !show && (
        <Button onClick={() => (setLines(blank()), setShow(true))}>Registrar confirmação</Button>
      )}
      {show && (
        <form onSubmit={submit} className="space-y-3" data-testid="confirmation-form">
          <ul className="divide-y divide-line">
            {pendingItems.map((i) => {
              const l = lines[i.id]!;
              return (
                <li key={i.id} className="space-y-2 py-2">
                  <p className="text-sm">
                    <span className="block font-medium">{i.product_name}</span>
                    <span className="block text-xs text-ink-faint">
                      {i.packaging_label} · pendente {qty(i.pending_packs)} · {money(i.pack_cost_cents)} cada
                    </span>
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Resultado">
                      {(id) => (
                        <Select id={id} value={l.outcome} onChange={(e) => set(i.id, { outcome: e.target.value })}>
                          {Object.entries(OUTCOME).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {['partial', 'reduced'].includes(l.outcome) && (
                      <Field label={l.outcome === 'partial' ? 'Vem agora (embalagens)' : 'Fica (embalagens)'} hint={`Menos que ${qty(i.pending_packs)}.`}>
                        {(id) => <Input id={id} inputMode="decimal" value={l.packs} onChange={(e) => set(i.id, { packs: e.target.value })} />}
                      </Field>
                    )}
                    {l.outcome !== 'refused' && (
                      <Field label="Preço confirmado da embalagem (R$)">{(id) => <Input id={id} inputMode="decimal" value={l.cost} onChange={(e) => set(i.id, { cost: e.target.value })} />}</Field>
                    )}
                    {l.outcome !== 'refused' && (
                      <Field label={l.outcome === 'partial' ? 'Entrega da parte' : 'Entrega prometida'}>
                        {(id) => <Input id={id} type="date" value={l.promisedAt} onChange={(e) => set(i.id, { promisedAt: e.target.value })} />}
                      </Field>
                    )}
                    {l.outcome === 'partial' && (
                      <Field label="Previsão do restante" hint="Em branco: sem previsão definida.">
                        {(id) => <Input id={id} type="date" value={l.restPromisedAt} onChange={(e) => set(i.id, { restPromisedAt: e.target.value })} />}
                      </Field>
                    )}
                    {(['reduced', 'refused'].includes(l.outcome) || parseMoney(l.cost) !== Number(i.pack_cost_cents)) && (
                      <Field label="Motivo" hint="Obrigatório em redução, recusa ou mudança de preço (aqui ou na observação geral).">
                        {(id) => <Input id={id} maxLength={500} value={l.note} onChange={(e) => set(i.id, { note: e.target.value })} />}
                      </Field>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Como o fornecedor respondeu">
              {(id) => (
                <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {Object.entries(CHANNEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Referência do fornecedor" hint="Número do pedido de venda deles, se houver.">
              {(id) => <Input id={id} maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />}
            </Field>
            <Field label="Entrega prometida (geral)" hint="Vale para os itens sem data própria.">
              {(id) => <Input id={id} type="date" value={promisedAt} onChange={(e) => setPromisedAt(e.target.value)} />}
            </Field>
            <Field label="Observação">{(id) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy}>
              Salvar confirmação
            </Button>
            <Button type="button" variant="ghost" onClick={() => setShow(false)}>
              Fechar
            </Button>
          </div>
        </form>
      )}
      {order.confirmations.length > 0 && (
        <ul className="mt-3 divide-y divide-line text-sm" data-testid="confirmations">
          {order.confirmations.map((c) => {
            const st = CONF_STATUS[c.status] ?? { label: c.status, tone: 'neutral' as Tone };
            return (
              <li key={c.id} className="py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Versão {c.version}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="text-xs text-ink-faint">
                    {CHANNEL[c.channel] ?? c.channel} · {c.actor_name} · {when(c.created_at)}
                  </span>
                </p>
                <ul className="mt-0.5 text-xs text-ink-soft">
                  {(c.items ?? []).map((i) => (
                    <li key={i.itemId}>
                      {i.label}: {OUTCOME_SHORT[i.outcome] ?? i.outcome}
                      {['partial', 'reduced'].includes(i.outcome) ? ` ${qty(i.confirmedPacks)} de ${qty(i.pendingPacks)}` : ''}
                      {i.confirmedPackCostCents !== i.orderedPackCostCents ? ` · ${money(i.orderedPackCostCents)} → ${money(i.confirmedPackCostCents)}` : ''}
                      {i.promisedAt ? ` · entrega ${day(i.promisedAt)}` : ''}
                      {i.restPromisedAt ? ` · restante ${day(i.restPromisedAt)}` : ''}
                      {i.note ? ` · ${i.note}` : ''}
                    </li>
                  ))}
                </ul>
                {c.note && <p className="text-xs text-ink-faint">{c.note}</p>}
                {c.decided_by_name && (
                  <p className="text-xs text-ink-faint">
                    Decisão: {c.decided_by_name} em {when(c.decided_at)}
                    {c.decision_self ? ' (próprio registro, proprietário)' : ''}
                    {c.decision_note ? ` · ${c.decision_note}` : ''}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Contato de acompanhamento (cobranca de confirmacao ou prazo) e o proximo retorno. */
export function FollowupPanel({ order, canManage, onChange }: { order: SupplyOrder; canManage: boolean; onChange: (o: never) => void }) {
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('phone');
  const [next, setNext] = useState(order.followup_on ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!['sent', 'partial'].includes(order.status) || !canManage) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (note.trim().length < 3) return setError('Descreva o contato.');
    setBusy(true);
    try {
      const r = await api(`/admin/purchase-orders/${order.id}/followup`, { method: 'POST', body: { note: note.trim(), channel, followupOn: next || null } });
      setNote('');
      onChange(r.order as never);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Acompanhamento" description={order.followup_on ? `Próximo retorno: ${day(order.followup_on)}` : 'Registre cobranças de confirmação ou de prazo.'}>
      <form onSubmit={submit} className="space-y-2">
        <Field label="Contato">{(id) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: liguei, prometeram retorno amanhã" />}</Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Canal">
            {(id) => (
              <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
                {Object.entries(CHANNEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Próximo retorno">{(id) => <Input id={id} type="date" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button busy={busy}>Registrar contato</Button>
      </form>
    </Panel>
  );
}

const REQ_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Aberta', tone: 'act' },
  in_purchase: { label: 'Em compra', tone: 'good' },
  done: { label: 'Atendida', tone: 'good' },
  rejected: { label: 'Recusada', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
export const REQUEST_STATUS = REQ_STATUS;

export function RequestsPanel({ requests }: { requests: SupplyOrder['requests'] }) {
  if (!requests.length) return null;
  return (
    <Panel title="Requisições desta compra">
      <ul className="divide-y divide-line text-sm">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-medium">Nº {r.number}</span> · {r.product_name} · {qty(r.base_qty)}
              <span className="block text-xs text-ink-faint">{r.source === 'backorder' ? `Encomenda do pedido nº ${r.order_number}` : 'Pedido interno'}</span>
            </span>
            <Badge tone={REQ_STATUS[r.status]?.tone ?? 'neutral'}>{REQ_STATUS[r.status]?.label ?? r.status}</Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export type ReceiptSuggestion = {
  invoiceRef: string;
  warnings: string[];
  items: { itemId: string; label: string; invoiceQty: string; pendingPacks: string; packs: string; invoicedPackCostCents: number; orderedPackCostCents: number; divergences: string[] }[];
  unmatched: { description: string; code: string; qty: string; divergences: string[] }[];
  missingFromInvoice: { itemId: string; label: string; pending: string }[];
};

/** Escolha da nota de compra vinculada para sugerir o recebimento (D7-10). So preenche o formulario. */
export function XmlSuggest({ orderId, invoices, onApply }: { orderId: string; invoices: { id: string; series: string; number: number }[]; onApply: (s: ReceiptSuggestion) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState<ReceiptSuggestion | null>(null);
  if (!invoices.length) return null;
  const run = async (invoiceId: string) => {
    setError('');
    setBusy(true);
    try {
      const s = await api<ReceiptSuggestion>(`/admin/purchase-orders/${orderId}/receipt-suggestions?invoiceId=${invoiceId}`);
      setLast(s);
      onApply(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-md bg-sunken/50 p-2 text-sm" data-testid="xml-suggest">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-soft">Preencher pela nota (XML):</span>
        {invoices.map((i) => (
          <Button key={i.id} type="button" busy={busy} onClick={() => run(i.id)}>
            NF {i.series}/{i.number}
          </Button>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
      {last && (
        <div className="mt-2 text-xs">
          <p className="text-ink-soft">Sugestão da nota {last.invoiceRef}: confira a mercadoria antes de dar entrada. Nada foi gravado.</p>
          {[...last.warnings, ...last.items.flatMap((i) => i.divergences.map((d) => `${i.label}: ${d}`)), ...last.unmatched.map((u) => `${u.description} (${u.code}): sem item correspondente no pedido`)].map((w) => (
            <p key={w} className="text-warn">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export const suggestionToForm = (s: ReceiptSuggestion) => ({
  packs: Object.fromEntries(s.items.map((i) => [i.itemId, qtyToInput(i.packs)])),
  invoiced: Object.fromEntries(s.items.map((i) => [i.itemId, centsToInput(i.invoicedPackCostCents)])),
});
