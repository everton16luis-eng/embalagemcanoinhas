'use client';

// SGLog Fase 9b: uma devolucao ao fornecedor. Enviar = saida fisica confirmada (so ai o estoque sai);
// recusada = a mercadoria voltou (estorno no saldo de origem); aceita encerra sem credito automatico.
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BUCKET, SUPPLIER_RETURN_STATUS } from '@/components/returns';
import { Guard, useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

type View = {
  supplierReturn: {
    id: string;
    number: number;
    supplier_name: string;
    purchase_order_number: number | null;
    customer_return_number: number | null;
    warehouse_name: string;
    status: string;
    reason: string;
    document_ref: string | null;
    carrier: string | null;
    tracking_code: string | null;
    sent_at: string | null;
    closed_at: string | null;
    close_note: string | null;
    created_at: string;
    version: number;
    created_by_name: string | null;
  };
  items: { id: string; sku: string; product_name: string; base_unit: string; bucket: string; qty: string; out_qty: string }[];
  events: { id: string; action: string; note: string | null; created_at: string; actor_name: string | null }[];
};

function Page() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const manage = can('purchases.manage');
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [send, setSend] = useState({ documentRef: '', carrier: '', trackingCode: '' });
  const load = useCallback(() => {
    api<View>(`/admin/supplier-returns/${id}`).then(setV, (e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  if (!v) return error ? <Notice tone="bad">{error}</Notice> : null;
  const s = v.supplierReturn;
  const run = async (action: string, body: Record<string, unknown>, ok: string) => {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      setV(await api<View>(`/admin/supplier-returns/${id}/${action}`, { method: 'POST', body: { ...body, version: s.version, requestKey: newKey() } }));
      setNotice(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const close = (action: 'accept' | 'refuse' | 'cancel', label: string, ok: string) => {
    const note = window.prompt(label);
    if (note && note.trim().length >= 3) run(action, { note: note.trim() }, ok);
  };
  const st = SUPPLIER_RETURN_STATUS[s.status];
  return (
    <>
      <PageHeader title={`Devolução ao fornecedor nº ${s.number}`} description={`${s.supplier_name} · depósito ${s.warehouse_name}`} actions={<Badge tone={st?.tone}>{st?.label}</Badge>} />
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
      <div className="space-y-5">
        <Panel title="Itens" description="Saldo de onde sai cada item e o que já saiu do estoque.">
          <ul className="divide-y divide-line text-sm" data-testid="supplier-return-items">
            {v.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">{i.sku}</span>
                <span className="text-ink-soft">{i.product_name}</span>
                <Badge>{BUCKET[i.bucket]}</Badge>
                <span className="num">
                  {qty(i.qty)} {i.base_unit}
                </span>
                <span className="text-ink-faint">saiu {qty(i.out_qty)}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Dados">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-soft">Motivo</dt>
              <dd>{s.reason}</dd>
            </div>
            {s.purchase_order_number && (
              <div>
                <dt className="text-ink-soft">Compra</dt>
                <dd>nº {s.purchase_order_number}</dd>
              </div>
            )}
            {s.document_ref && (
              <div>
                <dt className="text-ink-soft">Documento enviado</dt>
                <dd>
                  {s.document_ref} · {when(s.sent_at)}
                  {s.carrier ? ` · ${s.carrier}` : ''}
                  {s.tracking_code ? ` · ${s.tracking_code}` : ''}
                </dd>
              </div>
            )}
            {s.close_note && (
              <div>
                <dt className="text-ink-soft">Encerramento</dt>
                <dd>
                  {s.close_note} · {when(s.closed_at)}
                </dd>
              </div>
            )}
          </dl>
        </Panel>
        {manage && s.status === 'draft' && (
          <Panel title="Confirmar envio" description="Confirme só quando a mercadoria sair fisicamente. O estoque sai agora, do saldo indicado em cada item.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Documento enviado" required hint="NF de devolução ou outro documento.">
                {(fid) => <Input id={fid} value={send.documentRef} maxLength={60} onChange={(e) => setSend({ ...send, documentRef: e.target.value })} />}
              </Field>
              <Field label="Transportadora">{(fid) => <Input id={fid} value={send.carrier} maxLength={80} onChange={(e) => setSend({ ...send, carrier: e.target.value })} />}</Field>
              <Field label="Rastreio">{(fid) => <Input id={fid} value={send.trackingCode} maxLength={60} onChange={(e) => setSend({ ...send, trackingCode: e.target.value })} />}</Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                busy={busy === 'send'}
                disabled={!send.documentRef.trim()}
                onClick={() => run('send', { documentRef: send.documentRef.trim(), carrier: send.carrier || null, trackingCode: send.trackingCode || null }, 'Envio confirmado. O estoque saiu.')}
              >
                Confirmar envio
              </Button>
              <Button variant="danger" busy={busy === 'cancel'} onClick={() => close('cancel', 'Motivo do cancelamento do rascunho:', 'Rascunho cancelado.')}>
                Cancelar rascunho
              </Button>
            </div>
          </Panel>
        )}
        {manage && s.status === 'sent' && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'accept'} onClick={() => close('accept', 'O fornecedor aceitou. Observação (crédito ou troca são tratados fora do sistema):', 'Devolução aceita.')}>
              Fornecedor aceitou
            </Button>
            <Button busy={busy === 'refuse'} onClick={() => close('refuse', 'O fornecedor recusou e a mercadoria voltou. Motivo:', 'Recusada: a mercadoria voltou ao saldo de origem.')}>
              Recusada (mercadoria voltou)
            </Button>
          </div>
        )}
        <Panel title="Histórico" description="Registro permanente.">
          <ol className="space-y-2 text-sm">
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

export default function DevolucaoFornecedorPage() {
  return (
    <Guard perm="purchases.view|purchases.manage|returns.manage|stock.view">
      <Page />
    </Guard>
  );
}
