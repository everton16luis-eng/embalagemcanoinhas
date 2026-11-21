'use client';

// SGLog Fase 9a: uma ocorrencia, com as transicoes (versao + chave de requisicao) e o historico imutavel.
import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { OCCURRENCE_KIND, OCCURRENCE_SOURCE, OccurrenceBadge, RESPONSIBILITY, RETURN_KIND, ReturnBadge } from '@/components/returns';
import { Guard, useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type View = {
  occurrence: {
    id: string;
    number: number;
    order_id: string;
    order_number: number;
    shipment_seq: number | null;
    item_sku: string | null;
    item_name: string | null;
    kind: string;
    responsibility: string;
    status: string;
    source: string;
    blocks_completion: boolean;
    description: string;
    resolution: string | null;
    due_at: string | null;
    resolved_at: string | null;
    canceled_reason: string | null;
    created_at: string;
    version: number;
    created_by_name: string | null;
    resolved_by_name: string | null;
  };
  events: { id: string; action: string; from_status: string | null; to_status: string | null; note: string | null; created_at: string; actor_name: string | null }[];
  returns: { id: string; number: number; kind: string; status: string; created_at: string }[];
};
const ACTION: Record<string, string> = {
  open: 'Aberta',
  start: 'Em andamento',
  resolve: 'Resolvida',
  cancel: 'Cancelada',
  reopen: 'Reaberta',
  note: 'Anotação',
  responsibility: 'Responsável',
  tracking: 'Rastreio',
  payment: 'Pagamento',
  return: 'Devolução',
};

function Page() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const manage = can('occurrences.manage');
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState('note');
  const [note, setNote] = useState('');
  const [resp, setResp] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<View>(`/admin/occurrences/${id}`).then(
      (r) => {
        setV(r);
        setResp(r.occurrence.responsibility);
      },
      (e) => setError(e.message),
    );
  }, [id]);
  useEffect(load, [load]);
  if (!v) return error ? <Notice tone="bad">{error}</Notice> : null;
  const o = v.occurrence;
  const open = o.status === 'open' || o.status === 'in_progress';
  const actions = [
    ['note', 'Anotar'],
    ...(o.status === 'open' ? [['start', 'Passar para em andamento']] : []),
    ...(open ? [['responsibility', 'Definir responsável'], ['resolve', 'Resolver'], ['cancel', 'Cancelar']] : []),
    ...(o.status === 'resolved' ? [['reopen', 'Reabrir']] : []),
  ];
  const submit = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body: Record<string, unknown> = { action, note, version: o.version, requestKey: newKey() };
      if (action === 'responsibility' || action === 'resolve') body.responsibility = resp;
      const r = await api<View>(`/admin/occurrences/${id}/action`, { method: 'POST', body });
      setV(r);
      setNote('');
      setAction('note');
      setNotice('Registrado.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title={`Ocorrência nº ${o.number}`}
        description={
          <>
            {OCCURRENCE_KIND[o.kind] ?? o.kind} ·{' '}
            <Link href={`/painel/pedidos/${o.order_id}`} className="text-act hover:underline">
              Pedido nº {o.order_number}
            </Link>
            {o.shipment_seq ? ` · remessa ${o.shipment_seq}` : ''}
          </>
        }
        actions={<OccurrenceBadge status={o.status} />}
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
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <Panel title="Resumo">
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2" data-testid="occurrence-summary">
              <div>
                <dt className="text-ink-soft">Responsável</dt>
                <dd>{RESPONSIBILITY[o.responsibility]}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">Origem</dt>
                <dd>{OCCURRENCE_SOURCE[o.source]}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">Aberta em</dt>
                <dd>
                  {when(o.created_at)}
                  {o.created_by_name ? ` por ${o.created_by_name}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-ink-soft">Conclusão do pedido</dt>
                <dd>{o.blocks_completion ? (open ? 'Segurada enquanto estiver aberta' : 'Liberada') : 'Não segura'}</dd>
              </div>
              {o.item_sku && (
                <div>
                  <dt className="text-ink-soft">Item</dt>
                  <dd>
                    {o.item_sku} · {o.item_name}
                  </dd>
                </div>
              )}
              {o.due_at && (
                <div>
                  <dt className="text-ink-soft">Prazo interno</dt>
                  <dd>{when(o.due_at)}</dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="text-ink-soft">Descrição</dt>
                <dd className="whitespace-pre-wrap">{o.description}</dd>
              </div>
              {o.resolution && o.status === 'resolved' && (
                <div className="sm:col-span-2">
                  <dt className="text-ink-soft">Solução</dt>
                  <dd>
                    {o.resolution} ({when(o.resolved_at)}
                    {o.resolved_by_name ? `, ${o.resolved_by_name}` : ''})
                  </dd>
                </div>
              )}
              {o.canceled_reason && o.status === 'canceled' && (
                <div className="sm:col-span-2">
                  <dt className="text-ink-soft">Motivo do cancelamento</dt>
                  <dd>{o.canceled_reason}</dd>
                </div>
              )}
            </dl>
          </Panel>
          {v.returns.length > 0 && (
            <Panel title="Devoluções ligadas">
              <ul className="space-y-1 text-sm">
                {v.returns.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/painel/logistica/devolucoes/${r.id}`} className="font-medium text-act hover:underline">
                      {RETURN_KIND[r.kind]} nº {r.number}
                    </Link>
                    <ReturnBadge status={r.status} />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Histórico" description="Registro permanente: nada aqui é apagado ou editado.">
            <ol className="space-y-2 text-sm" data-testid="occurrence-events">
              {v.events.map((e) => (
                <li key={e.id} className="border-l-2 border-line pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{ACTION[e.action] ?? e.action}</Badge>
                    <span className="text-ink-faint">
                      {when(e.created_at)}
                      {e.actor_name ? ` · ${e.actor_name}` : ''}
                    </span>
                  </div>
                  {e.note && <p className="mt-0.5 whitespace-pre-wrap">{e.note}</p>}
                </li>
              ))}
            </ol>
          </Panel>
        </div>
        {manage && (
          <Panel title="Ação">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              data-testid="occurrence-action"
            >
              <Field label="O que fazer">
                {(fid) => (
                  <Select id={fid} value={action} onChange={(e) => setAction(e.target.value)}>
                    {actions.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {(action === 'responsibility' || action === 'resolve') && (
                <Field label="Responsável" hint={action === 'resolve' ? 'Obrigatório para resolver.' : undefined}>
                  {(fid) => (
                    <Select id={fid} value={resp} onChange={(e) => setResp(e.target.value)}>
                      {Object.entries(RESPONSIBILITY).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label={action === 'resolve' ? 'Solução' : action === 'cancel' || action === 'reopen' ? 'Motivo' : 'Anotação'} required>
                {(fid) => <Textarea id={fid} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}
              </Field>
              <Button variant="primary" type="submit" busy={busy} disabled={note.trim().length < 3}>
                Registrar
              </Button>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}

export default function OcorrenciaPage() {
  return (
    <Guard perm="occurrences.manage|returns.manage|logistics.view|orders.view">
      <Page />
    </Guard>
  );
}
