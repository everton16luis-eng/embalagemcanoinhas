'use client';

// SGLog Fase 9a: uma devolucao. Autorizada -> voltando -> recebida -> conferida -> encerrada.
// So a conferencia movimenta estoque; estorno e decisao da quarentena viram linhas novas (nada e apagado).
import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CONDITION, Deadlines, RETURN_KIND, RETURN_METHOD, RETURN_REASON, ReturnBadge, type Deadline } from '@/components/returns';
import { Guard, useMe } from '@/components/shell';
import { newKey, useWarehouses } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, parseQty, qty, when } from '@/lib/format';

type Ret = {
  id: string;
  number: number;
  order_id: string;
  order_number: number;
  channel: string;
  invoice_status: string;
  occurrence_id: string | null;
  occurrence_number: number | null;
  shipment_seq: number | null;
  kind: string;
  reason: string;
  status: string;
  return_method: string;
  carrier: string | null;
  tracking_code: string | null;
  reverse_code: string | null;
  return_freight_cents: string | null;
  warehouse_name: string | null;
  fiscal_required: boolean;
  delivered_at: string | null;
  notes: string | null;
  received_at: string | null;
  inspected_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  version: number;
  created_by_name: string | null;
};
type Item = { id: string; sku: string; product_name: string; packaging_label: string; base_unit: string; qty: string; unit_cost_cents: string | null; inspected: Record<string, string>; pending: string };
type Insp = {
  id: string;
  return_item_id: string;
  sku: string;
  condition: string;
  qty: string;
  unit_cost_cents: string | null;
  cost_source: string | null;
  reverses_id: string | null;
  reason: string | null;
  created_at: string;
  actor_name: string | null;
  reversed: boolean;
  decided: string;
  decisions: { decision: string; qty: string; reason: string; createdAt: string; actorName: string | null }[];
};
type View = { return: Ret; items: Item[]; inspections: Insp[]; events: { id: string; action: string; note: string | null; created_at: string; actor_name: string | null; to_status: string | null }[]; deadlines: Deadline[] };
type Line = { key: number; itemId: string; condition: string; qty: string; reason: string };
const DECISION: Record<string, string> = { release: 'Liberada para venda', damaged: 'Passou para avariada', discard: 'Descartada (baixa)' };

function Page() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const manage = can('returns.manage');
  const receive = can('returns.receive');
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [transit, setTransit] = useState({ carrier: '', trackingCode: '', reverseCode: '' });
  const [warehouseId, setWarehouseId] = useState('');
  const { active: warehouses } = useWarehouses();
  const apply = useCallback((r: View) => {
    setV(r);
    setLines(r.items.filter((i) => Number(i.pending) > 0).map((i, n) => ({ key: n, itemId: i.id, condition: 'good', qty: String(Number(i.pending)).replace('.', ','), reason: '' })));
  }, []);
  const load = useCallback(() => {
    api<View>(`/admin/returns/${id}`).then(apply, (e) => setError(e.message));
  }, [id, apply]);
  useEffect(load, [load]);
  if (!v) return error ? <Notice tone="bad">{error}</Notice> : null;
  const r = v.return;

  const run = async (name: string, path: string, body: Record<string, unknown>, ok: string) => {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      apply(await api<View>(`/admin/returns${path}`, { method: 'POST', body: { ...body, requestKey: newKey() } }));
      setNotice(ok);
    } catch (e) {
      setError((e as Error).message);
      load();
    } finally {
      setBusy('');
    }
  };
  const ask = (msg: string) => {
    const t = window.prompt(msg);
    return t && t.trim().length >= 3 ? t.trim() : null;
  };
  const item = (itemId: string) => v.items.find((i) => i.id === itemId);
  const inspect = () =>
    run(
      'inspect',
      `/${id}/inspect`,
      { version: r.version, lines: lines.filter((l) => Number(parseQty(l.qty)) > 0).map((l) => ({ itemId: l.itemId, condition: l.condition, qty: parseQty(l.qty), reason: l.reason.trim() || null })) },
      'Conferência registrada. O estoque foi movimentado conforme a condição de cada linha.',
    );
  const setLine = (k: number, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const needsReason = (c: string) => c === 'damaged' || c === 'discarded';

  return (
    <>
      <PageHeader
        title={`${RETURN_KIND[r.kind]} nº ${r.number}`}
        description={
          <>
            <Link href={`/painel/pedidos/${r.order_id}`} className="text-act hover:underline">
              Pedido nº {r.order_number}
            </Link>{' '}
            · {RETURN_REASON[r.reason] ?? r.reason}
            {r.occurrence_id && (
              <>
                {' '}
                ·{' '}
                <Link href={`/painel/logistica/ocorrencias/${r.occurrence_id}`} className="text-act hover:underline">
                  ocorrência nº {r.occurrence_number}
                </Link>
              </>
            )}
          </>
        }
        actions={<ReturnBadge status={r.status} />}
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {notice && (
        <div className="mb-4" data-testid="return-notice">
          <Notice tone="good">{notice}</Notice>
        </div>
      )}
      <div className="space-y-5">
        <Panel title="Itens" description="Autorizado, conferido por condição e o que falta conferir.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm" data-testid="return-items">
              <thead className="text-left text-ink-soft">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Item</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Autorizado</th>
                  <th className="py-1.5 pr-2 font-medium">Conferido</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Falta</th>
                  <th className="py-1.5 text-right font-medium">Custo da venda</th>
                </tr>
              </thead>
              <tbody>
                {v.items.map((i) => (
                  <tr key={i.id} className="border-t border-line align-top">
                    <td className="py-1.5 pr-2">
                      <span className="font-medium">{i.sku}</span> <span className="text-ink-soft">{i.product_name}</span>
                    </td>
                    <td className="num py-1.5 pr-2 text-right">
                      {qty(i.qty)} {i.base_unit}
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(i.inspected)
                          .filter(([, q]) => Number(q) > 0)
                          .map(([c, q]) => (
                            <Badge key={c} tone={CONDITION[c]?.tone}>
                              {CONDITION[c]?.label} {qty(q)}
                            </Badge>
                          ))}
                      </div>
                    </td>
                    <td className="num py-1.5 pr-2 text-right">{qty(i.pending)}</td>
                    <td className="num py-1.5 text-right">{i.unit_cost_cents ? money(i.unit_cost_cents) : <span className="text-ink-faint">médio atual</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {r.status === 'authorized' && (manage || receive) && (
          <Panel title="Logística reversa" description="Registro manual: a postagem ou coleta reversa é combinada fora do sistema. Nada é comprado automaticamente.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Transportadora">{(fid) => <Input id={fid} value={transit.carrier} onChange={(e) => setTransit({ ...transit, carrier: e.target.value })} maxLength={80} />}</Field>
              <Field label="Rastreio">{(fid) => <Input id={fid} value={transit.trackingCode} onChange={(e) => setTransit({ ...transit, trackingCode: e.target.value })} maxLength={60} />}</Field>
              <Field label="Autorização reversa">{(fid) => <Input id={fid} value={transit.reverseCode} onChange={(e) => setTransit({ ...transit, reverseCode: e.target.value })} maxLength={60} />}</Field>
            </div>
            <div className="mt-3">
              <Button
                busy={busy === 'transit'}
                onClick={() =>
                  run('transit', `/${id}/transit`, { version: r.version, carrier: transit.carrier || null, trackingCode: transit.trackingCode || null, reverseCode: transit.reverseCode || null }, 'Marcada como voltando.')
                }
              >
                Marcar como voltando
              </Button>
            </div>
          </Panel>
        )}

        {['authorized', 'in_transit'].includes(r.status) && receive && (
          <Panel title="Recebimento" description="Registra a chegada física no depósito. Ainda não mexe no estoque: depois vem a conferência.">
            <div className="flex flex-wrap items-end gap-3">
              {warehouses.length > 1 && (
                <Field label="Depósito">
                  {(fid) => (
                    <Select id={fid} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                      <option value="">Padrão</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Button variant="primary" busy={busy === 'receive'} onClick={() => run('receive', `/${id}/receive`, { version: r.version, warehouseId: warehouseId || null }, 'Recebida. Agora confira os itens.')} data-testid="receive-return">
                Registrar recebimento
              </Button>
            </div>
          </Panel>
        )}

        {r.status === 'received' && receive && lines.length > 0 && (
          <Panel title="Conferência" description={`Depósito ${r.warehouse_name}. Cada linha movimenta o estoque conforme a condição; divida o item em várias linhas se vier parte boa e parte avariada.`}>
            <div className="space-y-2" data-testid="inspect-form">
              {lines.map((l) => {
                const it = item(l.itemId)!;
                return (
                  <div key={l.key} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_170px_120px_1fr_auto] sm:items-end">
                    <div className="text-sm">
                      <span className="font-medium">{it.sku}</span> <span className="text-ink-soft">falta {qty(it.pending)}</span>
                    </div>
                    <Select aria-label={`Condição de ${it.sku}`} value={l.condition} onChange={(e) => setLine(l.key, { condition: e.target.value })}>
                      {Object.entries(CONDITION).map(([k, c]) => (
                        <option key={k} value={k}>
                          {c.label} ({c.hint})
                        </option>
                      ))}
                    </Select>
                    <Input aria-label={`Quantidade de ${it.sku}`} inputMode="decimal" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    <Input aria-label={`Motivo de ${it.sku}`} placeholder={needsReason(l.condition) ? 'Motivo (obrigatório)' : 'Motivo (opcional)'} value={l.reason} onChange={(e) => setLine(l.key, { reason: e.target.value })} maxLength={300} />
                    <Button variant="ghost" onClick={() => setLines([...lines, { key: Math.max(...lines.map((x) => x.key)) + 1, itemId: l.itemId, condition: 'damaged', qty: '', reason: '' }])}>
                      Dividir
                    </Button>
                  </div>
                );
              })}
              <Button variant="primary" busy={busy === 'inspect'} disabled={lines.some((l) => needsReason(l.condition) && l.reason.trim().length < 3 && Number(parseQty(l.qty)) > 0)} onClick={inspect}>
                Registrar conferência
              </Button>
            </div>
          </Panel>
        )}

        {v.inspections.length > 0 && (
          <Panel title="Conferência registrada" description="Linhas permanentes. Corrigir = estornar a linha (movimentos de estorno) e conferir de novo.">
            <ul className="divide-y divide-line text-sm" data-testid="inspection-lines">
              {v.inspections.map((i) => {
                const openQ = i.condition === 'quarantine' && !i.reverses_id && !i.reversed ? Number(i.qty) - Number(i.decided) : 0;
                return (
                  <li key={i.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{i.sku}</span>
                      <Badge tone={i.reverses_id ? 'neutral' : CONDITION[i.condition]?.tone}>
                        {i.reverses_id ? 'Estorno · ' : ''}
                        {CONDITION[i.condition]?.label}
                      </Badge>
                      <span className="num">{qty(i.qty)}</span>
                      {i.reversed && <Badge>estornada</Badge>}
                      {i.unit_cost_cents && <span className="text-ink-soft">custo {money(i.unit_cost_cents)}</span>}
                      <span className="text-ink-faint">
                        {when(i.created_at)}
                        {i.actor_name ? ` · ${i.actor_name}` : ''}
                      </span>
                      {manage && !i.reverses_id && !i.reversed && Number(i.decided) === 0 && ['received', 'inspected'].includes(r.status) && (
                        <Button
                          variant="ghost"
                          busy={busy === `rev${i.id}`}
                          onClick={() => {
                            const reason = ask('Motivo do estorno desta linha da conferência:');
                            if (reason) run(`rev${i.id}`, `/${id}/inspections/${i.id}/reverse`, { reason }, 'Linha estornada. Confira de novo o que faltar.');
                          }}
                        >
                          Estornar
                        </Button>
                      )}
                    </div>
                    {i.reason && <p className="text-ink-soft">{i.reason}</p>}
                    {i.decisions.map((d, n) => (
                      <p key={n} className="text-ink-soft">
                        {DECISION[d.decision]}: {qty(d.qty)} · {d.reason} · {when(d.createdAt)}
                      </p>
                    ))}
                    {openQ > 0 && manage && (
                      <div className="flex flex-wrap gap-2" data-testid="quarantine-decide">
                        <span className="text-ink-soft">Em quarentena: {qty(openQ)}</span>
                        {(['release', 'damaged', 'discard'] as const).map((d) => (
                          <Button
                            key={d}
                            variant={d === 'release' ? 'secondary' : 'ghost'}
                            busy={busy === `q${i.id}${d}`}
                            onClick={() => {
                              const raw = window.prompt(`${DECISION[d]}: quantidade (até ${qty(openQ)})`, String(openQ).replace('.', ','));
                              if (!raw) return;
                              const reason = ask('Motivo da decisão:');
                              if (reason) run(`q${i.id}${d}`, `/quarantine/${i.id}/decide`, { decision: d, qty: parseQty(raw), reason }, 'Decisão registrada.');
                            }}
                          >
                            {d === 'release' ? 'Liberar' : d === 'damaged' ? 'Avariada' : 'Descartar'}
                          </Button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}

        <Panel title="Dados">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-soft">Como volta</dt>
              <dd>
                {RETURN_METHOD[r.return_method]}
                {r.carrier ? ` · ${r.carrier}` : ''}
                {r.tracking_code ? ` · ${r.tracking_code}` : ''}
                {r.reverse_code ? ` · autorização ${r.reverse_code}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-ink-soft">Documento fiscal</dt>
              <dd>{r.fiscal_required ? 'Pedido com NF-e autorizada: a devolução precisa de documento fiscal próprio (ou dispensa justificada) para encerrar. A NF-e da venda não é alterada.' : 'Sem NF-e autorizada no pedido.'}</dd>
            </div>
            {r.warehouse_name && (
              <div>
                <dt className="text-ink-soft">Recebida</dt>
                <dd>
                  {r.warehouse_name} · {when(r.received_at)}
                </dd>
              </div>
            )}
            {r.notes && (
              <div>
                <dt className="text-ink-soft">Observação</dt>
                <dd>{r.notes}</dd>
              </div>
            )}
            {r.cancel_reason && (
              <div>
                <dt className="text-ink-soft">Cancelada</dt>
                <dd>
                  {r.cancel_reason} · {when(r.canceled_at)}
                </dd>
              </div>
            )}
          </dl>
          <div className="mt-3">
            <Deadlines items={v.deadlines} deliveredAt={r.delivered_at} />
          </div>
        </Panel>

        {manage && ['authorized', 'in_transit', 'inspected'].includes(r.status) && (
          <div className="flex flex-wrap gap-2">
            {r.status === 'inspected' && (
              <Button variant="primary" busy={busy === 'complete'} onClick={() => run('complete', `/${id}/complete`, { version: r.version }, 'Devolução encerrada.')} data-testid="complete-return">
                Encerrar devolução
              </Button>
            )}
            {r.status !== 'inspected' && (
              <Button
                variant="danger"
                busy={busy === 'cancel'}
                onClick={() => {
                  const reason = ask('Motivo do cancelamento da devolução:');
                  if (reason) run('cancel', `/${id}/cancel`, { version: r.version, reason }, 'Devolução cancelada.');
                }}
              >
                Cancelar devolução
              </Button>
            )}
          </div>
        )}

        <Panel title="Histórico" description="Registro permanente.">
          <ol className="space-y-2 text-sm" data-testid="return-events">
            {v.events.map((e) => (
              <li key={e.id} className="border-l-2 border-line pl-3">
                <span className="text-ink-faint">
                  {when(e.created_at)}
                  {e.actor_name ? ` · ${e.actor_name}` : ''}
                </span>
                {e.note && <p>{e.note}</p>}
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}

export default function DevolucaoPage() {
  return (
    <Guard perm="returns.manage|returns.receive|occurrences.manage|logistics.view|orders.view">
      <Page />
    </Guard>
  );
}
