'use client';

// SGLog Fase 6: fila das encomendas por deposito e produto (ordem de pagamento), reprocessamento com previa (D6-10)
// e antecipacao manual com justificativa e verificacao em duas etapas (D6-9/D6-11).
import Link from '@/components/painel-link';
import { useCallback, useEffect, useState } from 'react';
import { newKey } from '@/components/stock';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Notice, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { qty, when } from '@/lib/format';

type Entry = { position: number; reservationId: string; orderId: string; orderNumber: number; paidAt: string; qty: string; purchases: { id: string; number: number }[] };
type Group = { warehouseId: string; variantId: string; sku: string; product_name: string; base_unit: string; warehouse_name: string; free: string; queue: Entry[] };
type PlanRow = { warehouseId: string; variantId: string; converted: { orderNumber: number; qty: string }[]; stoppedAt: { orderNumber: number; qty: string; free: string } | null };

function Page() {
  const { can, me } = useMe();
  const manage = can('logistics.manage');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{ key: string; rows: PlanRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ groups: Group[] }>('/admin/backorders').then((r) => setGroups(r.groups), (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const name = (r: PlanRow) => groups?.find((g) => g.variantId === r.variantId && g.warehouseId === r.warehouseId);

  const runPreview = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const key = newKey();
      const r = await api<{ results: PlanRow[] }>('/admin/backorders/reprocess', { method: 'POST', body: { requestKey: key, apply: false } });
      setPreview({ key, rows: r.results });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ replayed: boolean; results: PlanRow[] }>('/admin/backorders/reprocess', { method: 'POST', body: { requestKey: preview.key, apply: true } });
      const n = r.results.reduce((s, x) => s + x.converted.length, 0);
      setNotice(r.replayed ? 'Este reprocessamento já tinha sido aplicado.' : `${n} encomenda(s) atendida(s) pela fila.`);
      setPreview(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const advance = async (g: Group, e: Entry) => {
    const justification = window.prompt(`Antecipar o pedido nº ${e.orderNumber} à frente de ${e.position - 1} encomenda(s)? Justifique (mínimo 10 caracteres):`);
    if (!justification) return;
    setError('');
    setNotice('');
    try {
      await api('/admin/backorders/advance', { method: 'POST', body: { reservationId: e.reservationId, justification, requestKey: newKey() } });
      setNotice(`Pedido nº ${e.orderNumber} antecipado (${qty(e.qty)} ${g.base_unit}). Registro permanente com a justificativa.`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Encomendas"
        description="Pedidos pagos aguardando mercadoria, por depósito e produto. Atende pela ordem de pagamento e só a encomenda inteira; a primeira que não cabe segura a fila."
        actions={
          manage && (
            <Button onClick={runPreview} busy={busy && !preview}>
              Reprocessar encomendas
            </Button>
          )
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {notice && (
        <div className="mb-4" data-testid="backorders-notice">
          <Notice tone="good">{notice}</Notice>
        </div>
      )}
      {preview && (
        <Panel title="Prévia do reprocessamento" className="mb-5" description="Nada mudou ainda. Confira e aplique.">
          {preview.rows.every((r) => !r.converted.length) ? (
            <p className="text-sm text-ink-soft">Nenhuma encomenda pode ser atendida inteira com a mercadoria livre de agora.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="reprocess-preview">
              {preview.rows
                .filter((r) => r.converted.length)
                .map((r) => (
                  <li key={`${r.warehouseId}:${r.variantId}`}>
                    <span className="font-medium">{name(r)?.product_name ?? r.variantId}</span> ({name(r)?.warehouse_name}): {r.converted.map((c) => `nº ${c.orderNumber}`).join(', ')}
                    {r.stoppedAt && <span className="block text-xs text-ink-soft">Para no nº {r.stoppedAt.orderNumber}: precisa {qty(r.stoppedAt.qty)}, livre {qty(r.stoppedAt.free)}.</span>}
                  </li>
                ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" busy={busy} onClick={apply} disabled={preview.rows.every((r) => !r.converted.length)}>
              Aplicar
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Fechar
            </Button>
          </div>
        </Panel>
      )}
      {!groups ? (
        <p className="text-sm text-ink-faint">Carregando…</p>
      ) : groups.length === 0 ? (
        <Empty title="Nenhuma encomenda aguardando mercadoria." />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const head = g.queue[0];
            return (
              <Panel
                key={`${g.warehouseId}:${g.variantId}`}
                title={g.product_name}
                description={
                  <>
                    <span className="font-mono">{g.sku}</span> · {g.warehouse_name} · livre para encomendas {qty(g.free)} {g.base_unit}
                  </>
                }
              >
                <ol className="divide-y divide-line text-sm" data-testid="backorder-queue">
                  {g.queue.map((e) => (
                    <li key={e.reservationId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0">
                        <span className="num mr-2 text-ink-faint">{e.position}º</span>
                        <Link href={`/painel/logistica/alocacao/${e.orderId}`} className="font-medium underline underline-offset-2">
                          Pedido nº {e.orderNumber}
                        </Link>{' '}
                        · {qty(e.qty)} {g.base_unit}
                        <span className="block text-xs text-ink-faint">
                          Pago em {when(e.paidAt)}
                          {e.purchases.length > 0 && <> · vinculada à compra {e.purchases.map((p) => `nº ${p.number}`).join(', ')}</>}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {e === head && Number(e.qty) > Number(g.free) && <Badge tone="warn">Aguardando mercadoria</Badge>}
                        {manage && e.position > 1 && Number(e.qty) <= Number(g.free) && (
                          <Button
                            onClick={() => advance(g, e)}
                            disabled={!me.user.mfaEnabled}
                            title={me.user.mfaEnabled ? undefined : 'Ative a verificação em duas etapas em Minha conta para antecipar.'}
                          >
                            Antecipar
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function EncomendasPage() {
  return (
    <Guard perm="logistics.view">
      <Page />
    </Guard>
  );
}
