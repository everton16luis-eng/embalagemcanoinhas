'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { accessKey, DOC_STATUS, EVENT_LABEL, FILE_LABEL } from '@/components/fiscal';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Field, Notice, PageHeader, Panel, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
const kb = (b: number) => `${Math.max(1, Math.round(b / 1024))} KB`;

function Detail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useMe();
  const manage = can('fiscal.manage') && me.user.mfaEnabled;
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [mode, setMode] = useState<'' | 'cancel' | 'cce'>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => api(`/admin/fiscal/documents/${id}`).then(setD, (e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (name: string, path: string, body: object, ok: string) => {
    setBusy(name);
    setMsg(null);
    try {
      const r = await api(path, { method: 'POST', body });
      setMsg(r.warning ? { tone: 'warn', text: r.warning } : { tone: 'good', text: ok });
      setMode('');
      setText('');
      await load();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  if (!d) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-soft">Carregando…</p>;
  const doc = d.document;
  const st = DOC_STATUS[doc.status]!;
  const open = doc.status === 'pending' || doc.status === 'processing';

  return (
    <>
      <PageHeader
        title={doc.number ? `NF-e nº ${doc.number}` : 'NF-e em emissão'}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
            {doc.environment === 'homologacao' && <Badge tone="warn">Homologação: sem valor fiscal</Badge>}
            <span>
              Pedido{' '}
              <Link href={`/painel/pedidos/${doc.order_id}`} className="underline">
                nº {doc.order_number}
              </Link>{' '}
              · {doc.buyer_name}
            </span>
          </span>
        }
        actions={
          <Link href="/painel/fiscal?aba=notas">
            <Button>Voltar</Button>
          </Link>
        }
      />
      {msg && (
        <div className="mb-4">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      {doc.status === 'rejected' && (
        <div className="mb-4">
          <Notice tone="bad">
            Rejeitada{doc.sefaz_status ? ` (${doc.sefaz_status})` : ''}: {doc.sefaz_message ?? 'sem mensagem'}
            {doc.errors?.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {doc.errors.map((e: any, i: number) => (
                  <li key={i}>
                    {e.message}
                    {e.field ? ` (${e.field})` : ''}
                  </li>
                ))}
              </ul>
            )}
            <span className="mt-1 block">Corrija o cadastro indicado e emita de novo pelo pedido.</span>
          </Notice>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Panel title="Dados da nota">
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
              <dt className="text-ink-soft">Chave de acesso</dt>
              <dd className="num break-all">{accessKey(doc.access_key)}</dd>
              <dt className="text-ink-soft">Série / número</dt>
              <dd className="num">{doc.number ? `${doc.series} / ${doc.number}` : '—'}</dd>
              <dt className="text-ink-soft">Natureza</dt>
              <dd>{doc.payload.natureza_operacao}</dd>
              <dt className="text-ink-soft">Autorizada em</dt>
              <dd>{when(doc.authorized_at)}</dd>
              {doc.canceled_at && (
                <>
                  <dt className="text-ink-soft">Cancelada em</dt>
                  <dd>
                    {when(doc.canceled_at)} · {doc.cancel_reason}
                  </dd>
                </>
              )}
              <dt className="text-ink-soft">Referência</dt>
              <dd className="num">
                {doc.ref} · tentativa {doc.attempt} · {doc.provider === 'fake' ? 'provedor simulado' : 'Focus NFe'}
              </dd>
              <dt className="text-ink-soft">Emitida por</dt>
              <dd>{doc.created_by_name ?? 'Rotina automática'}</dd>
            </dl>
          </Panel>

          {manage && (open || doc.status === 'authorized') && (
            <Panel title="Ações">
              <div className="flex flex-wrap gap-2">
                {open && (
                  <Button busy={busy === 'sync'} onClick={() => run('sync', `/admin/fiscal/documents/${id}/sync`, {}, 'Situação atualizada.')}>
                    Consultar situação agora
                  </Button>
                )}
                {doc.status === 'authorized' && mode === '' && (
                  <>
                    <Button onClick={() => setMode('cce')}>Carta de correção</Button>
                    <Button variant="danger" onClick={() => setMode('cancel')}>
                      Cancelar nota
                    </Button>
                  </>
                )}
              </div>
              {mode && (
                <form
                  className="mt-3 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (mode === 'cancel') run('cancel', `/admin/fiscal/documents/${id}/cancel`, { reason: text }, 'Nota cancelada na SEFAZ.');
                    else run('cce', `/admin/fiscal/documents/${id}/correction`, { text }, 'Carta de correção registrada na SEFAZ.');
                  }}
                >
                  <Field
                    label={mode === 'cancel' ? 'Justificativa do cancelamento' : 'Texto da correção'}
                    required
                    hint={
                      mode === 'cancel'
                        ? 'De 15 a 255 caracteres. O prazo da SEFAZ costuma ser de 24 horas após a autorização.'
                        : 'De 15 a 1000 caracteres. Não corrige valores, impostos, remetente, destinatário nem datas.'
                    }
                  >
                    {(fid) => <Textarea id={fid} required minLength={15} maxLength={mode === 'cancel' ? 255 : 1000} value={text} onChange={(e) => setText(e.target.value)} />}
                  </Field>
                  <div className="flex gap-2">
                    <Button type="submit" variant={mode === 'cancel' ? 'danger' : 'primary'} busy={busy === mode}>
                      {mode === 'cancel' ? 'Confirmar cancelamento' : 'Enviar correção'}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setMode('')}>
                      Voltar
                    </Button>
                  </div>
                </form>
              )}
            </Panel>
          )}

          <Panel title="Histórico">
            <ol className="space-y-2 text-sm">
              {d.events.map((e: any, i: number) => (
                <li key={i} className="flex gap-3">
                  <span className="num w-32 shrink-0 text-xs text-ink-faint">{when(e.created_at)}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                    {e.status && <span className="text-ink-soft"> · {DOC_STATUS[e.status]?.label ?? e.status}</span>}
                    {e.sefaz_status && <span className="text-ink-soft"> · SEFAZ {e.sefaz_status}</span>}
                    {e.message && <span className="text-ink-soft"> — {e.kind === 'file' ? FILE_LABEL[e.message] ?? e.message : e.message}</span>}
                    {e.data?.reason && <span className="text-ink-soft"> — {e.data.reason}</span>}
                    {e.data?.text && <span className="text-ink-soft"> — {e.data.text}</span>}
                    {e.actor_name && <span className="text-ink-faint"> · {e.actor_name}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Panel title="Arquivos" description="Guardados com resumo SHA-256, conferido a cada download.">
            {d.files.length === 0 ? (
              <p className="text-sm text-ink-soft">{open ? 'Disponíveis depois da autorização.' : 'Nenhum arquivo.'}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.files.map((f: any) => (
                  <li key={f.id}>
                    <a className="font-medium text-act-dark underline" href={`/api/v1/admin/fiscal/files/${f.id}`}>
                      {FILE_LABEL[f.kind] ?? f.kind}
                      {f.sequence > 1 ? ` nº ${f.sequence}` : ''}
                    </a>
                    <span className="block text-xs text-ink-faint">
                      {kb(f.bytes)} · {when(f.created_at)}
                      <span className="num block truncate" title={f.sha256}>
                        SHA-256 {f.sha256.slice(0, 16)}…
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="fiscal.view">
      <Detail />
    </Guard>
  );
}
