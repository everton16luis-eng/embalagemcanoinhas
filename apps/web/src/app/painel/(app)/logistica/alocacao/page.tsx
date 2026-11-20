'use client';

import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { LogisticsBadge } from '@/components/logistics';
import { CHANNEL_LABEL } from '@/components/orders';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

type Row = { id: string; number: number; channel: string; paid_at: string | null; logistics_status: string; logistics_note: string | null; items: number; origins: string | null };
type Queue = { items: Row[]; total: number; counts: Record<string, number>; auto: boolean };
type Settings = { dropship_status: string; fiscal_validator_name: string | null; validated_at: string | null; validated_by_name: string | null; version: number };

const FILTER: Record<string, string> = { open: 'Em aberto', analysis: 'Em análise', awaiting: 'Aguardando', processing: 'Alocados' };

/** Trava do dropshipping (D3): so libera com o nome de quem validou o tratamento fiscal. */
function DropshipLock() {
  const { can } = useMe();
  const [s, setS] = useState<Settings | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const load = useCallback(
    () =>
      api<{ settings: Settings }>('/admin/logistics/settings').then(
        (r) => setS(r.settings),
        (e) => setMsg({ tone: 'bad', text: e.message }),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!s) return null;
  const enabled = s.dropship_status === 'enabled';
  const save = async (status: 'blocked' | 'enabled') => {
    setBusy(true);
    setMsg(null);
    try {
      await api('/admin/logistics/settings/dropship', { method: 'PUT', body: { status, version: s.version, ...(status === 'enabled' ? { fiscalValidatorName: name.trim() } : {}) } });
      setMsg({ tone: 'good', text: status === 'enabled' ? 'Dropshipping liberado.' : 'Dropshipping bloqueado.' });
      setName('');
      await load();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Dropshipping" description="Envio direto do fornecedor ao cliente. Fica bloqueado até a validação do tratamento fiscal (nota de remessa por conta e ordem).">
      {msg && (
        <div className="mb-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      <p className="text-sm">
        <Badge tone={enabled ? 'warn' : 'neutral'}>{enabled ? 'Liberado' : 'Bloqueado'}</Badge>
        {enabled && s.validated_at && (
          <span className="ml-2 text-ink-soft">
            Validado por {s.fiscal_validator_name}, registrado por {s.validated_by_name} em {when(s.validated_at)}.
          </span>
        )}
      </p>
      {can('settings.manage') &&
        (enabled ? (
          <Button className="mt-3" variant="danger" busy={busy} onClick={() => save('blocked')}>
            Bloquear de novo
          </Button>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save('enabled');
            }}
          >
            <Field label="Quem validou o tratamento fiscal" required className="min-w-0 flex-1">
              {(fid) => <Input id={fid} required minLength={3} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Button type="submit" busy={busy}>
              Liberar
            </Button>
          </form>
        ))}
    </Panel>
  );
}

function AllocationQueue() {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Queue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setPage(1), [status]);
  useEffect(() => {
    api<Queue>(`/admin/logistics/queue?status=${status}&page=${page}&pageSize=30`).then(setData, (e) => setError(e.message));
  }, [status, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 30)) : 1;

  return (
    <>
      <PageHeader title="Alocação de pedidos" description="Pedidos pagos esperando a definição de onde sai a mercadoria: depósito próprio ou fornecedor. Em análise primeiro." />
      {data && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="bad">{data.counts.analysis ?? 0} em análise</Badge>
          <Badge tone="warn">{data.counts.awaiting ?? 0} aguardando</Badge>
          <Badge tone="good">{data.counts.processing ?? 0} alocados</Badge>
          <span className="text-ink-faint">Alocação automática {data.auto ? 'ligada' : 'desligada'}</span>
        </div>
      )}
      <div className="mb-4">
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          {Object.entries(FILTER).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="mb-4 rounded-lg border border-line bg-card">
          {data.items.length === 0 ? (
            <Empty title="Nenhum pedido nesta situação." />
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((o) => (
                <li key={o.id}>
                  <Link href={`/painel/logistica/alocacao/${o.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-sunken/40 sm:px-5">
                    <span className="min-w-0">
                      <span className="block font-medium">
                        Pedido nº {o.number} · {CHANNEL_LABEL[o.channel] ?? o.channel}
                      </span>
                      <span className="block text-xs text-ink-faint">
                        {o.paid_at ? `Pago ${when(o.paid_at)}` : 'Pago'} · {o.items} {o.items === 1 ? 'item' : 'itens'}
                        {o.origins && ` · ${o.origins}`}
                      </span>
                      {o.logistics_note && <span className="block text-xs text-ink-soft">{o.logistics_note}</span>}
                    </span>
                    <LogisticsBadge status={o.logistics_status} />
                  </Link>
                </li>
              ))}
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
      <DropshipLock />
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="logistics.view">
      <AllocationQueue />
    </Guard>
  );
}
