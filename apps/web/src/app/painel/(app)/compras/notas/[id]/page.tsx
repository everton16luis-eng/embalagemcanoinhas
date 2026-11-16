'use client';

import Link from '@/components/painel-link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, money, qty, when } from '@/lib/format';

type ConfItem = {
  line: number;
  code: string;
  gtin: string | null;
  description: string;
  unit: string;
  qty: string;
  unitValue: string;
  totalCents: number;
  match: { packagingId: string; label: string; productName: string; sku: string; by: 'supplier_sku' | 'gtin' } | null;
  divergences: string[];
};
type Data = {
  invoice: {
    id: string;
    access_key: string;
    series: string;
    number: string;
    issued_at: string | null;
    supplier_name: string;
    supplier_document: string;
    total_cents: string;
    protocol_status: string | null;
    supplier_id: string | null;
    purchase_order_id: string | null;
    purchase_order_number: number | null;
    created_at: string;
    created_by_name: string;
  };
  conference: { supplier: { id: string; name: string } | null; warnings: string[]; items: ConfItem[]; missingFromInvoice: { itemId: string; label: string; pending: string }[]; ok: boolean };
};
type Po = { id: string; number: number; supplier_name: string; status: string };

const BY = { supplier_sku: 'código do fornecedor', gtin: 'código de barras' } as const;
const groupedKey = (k: string) => k.replace(/(\d{4})(?=\d)/g, '$1 ');

function Detail() {
  const { id } = useParams<{ id: string }>();
  const repeated = useSearchParams().get('repetida') === '1';
  const { can } = useMe();
  const [data, setData] = useState<Data | null>(null);
  const [orders, setOrders] = useState<Po[]>([]);
  const [poId, setPoId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Data>(`/admin/purchase-invoices/${id}`).then(
      (d) => {
        setData(d);
        setPoId(d.invoice.purchase_order_id ?? '');
      },
      (e) => setError(e.message),
    );
  }, [id]);
  const supplierId = data?.conference.supplier?.id;
  useEffect(() => {
    if (!supplierId || !can('purchases.manage')) return;
    api<{ items: Po[] }>(`/admin/purchase-orders?pageSize=100&status=open&supplierId=${supplierId}`).then((r) => setOrders(r.items), () => setOrders([]));
  }, [supplierId, can]);

  async function link(value: string | null) {
    setBusy(true);
    setError('');
    try {
      const d = await api<Data>(`/admin/purchase-invoices/${id}/link`, { method: 'POST', body: { purchaseOrderId: value } });
      setData(d);
      setPoId(d.invoice.purchase_order_id ?? '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <Notice tone="bad">{error}</Notice> : <p className="text-sm text-ink-soft">Carregando…</p>;
  const { invoice: inv, conference: c } = data;
  const linked = inv.purchase_order_id;
  // Pedido ja vinculado pode nao estar mais "em aberto"; mantem a opcao visivel.
  const options = linked && !orders.some((o) => o.id === linked) ? [{ id: linked, number: inv.purchase_order_number ?? 0, supplier_name: inv.supplier_name, status: '' }, ...orders] : orders;

  return (
    <>
      <PageHeader
        title={`NF ${inv.number} · série ${inv.series}`}
        description={`${inv.supplier_name} · ${formatCnpj(inv.supplier_document)}`}
        actions={
          <a href={`/api/v1/admin/purchase-invoices/${inv.id}/xml`}>
            <Button>Baixar XML</Button>
          </a>
        }
      />
      <p className="mb-4 text-sm">
        <Link href="/painel/compras/notas" className="text-act-dark underline">
          Voltar para Notas de compra
        </Link>
      </p>
      {repeated && <Notice tone="warn">Esta nota já tinha sido importada. Mostrando a importação existente.</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Dados da nota">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-ink-soft">Chave de acesso</dt>
            <dd className="num break-all">{groupedKey(inv.access_key)}</dd>
            <dt className="text-ink-soft">Emissão</dt>
            <dd>{when(inv.issued_at)}</dd>
            <dt className="text-ink-soft">Total da nota</dt>
            <dd className="num">{money(inv.total_cents)}</dd>
            <dt className="text-ink-soft">Protocolo SEFAZ</dt>
            <dd>{inv.protocol_status === '100' ? <Badge tone="good">Autorizada (100)</Badge> : <Badge tone="warn">{inv.protocol_status ?? 'Sem protocolo no XML'}</Badge>}</dd>
            <dt className="text-ink-soft">Importada</dt>
            <dd>
              {when(inv.created_at)} por {inv.created_by_name}
            </dd>
          </dl>
        </Panel>
        <Panel title="Conferência" description="O sistema só aponta diferenças. A entrada no estoque é feita no recebimento do pedido de compra.">
          <div className="space-y-3 text-sm">
            {c.ok ? <Notice tone="good">Nota confere com o pedido de compra.</Notice> : !linked && c.supplier && <Notice tone="warn">Vincule a nota ao pedido de compra para comparar quantidades e preços.</Notice>}
            {c.warnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))}
            {can('purchases.manage') && c.supplier && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1">
                  <span className="text-xs text-ink-soft">Pedido de compra</span>
                  <Select value={poId} onChange={(e) => setPoId(e.target.value)} className="w-auto min-w-48">
                    <option value="">Sem vínculo</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        Nº {o.number}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button busy={busy} disabled={poId === (linked ?? '')} onClick={() => link(poId || null)}>
                  Salvar vínculo
                </Button>
              </div>
            )}
            {linked && (
              <p>
                <Link href={`/painel/compras/${linked}?nf=${encodeURIComponent(inv.number)}`} className="font-medium text-act-dark underline">
                  Abrir pedido Nº {inv.purchase_order_number} para receber
                </Link>
              </p>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Itens da nota">
        <ul className="divide-y divide-line text-sm">
          {c.items.map((it) => (
            <li key={it.line} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="font-medium">
                    {it.line}. {it.description}
                  </p>
                  <p className="text-xs text-ink-faint">
                    Cód. {it.code}
                    {it.gtin && ` · GTIN ${it.gtin}`}
                  </p>
                </div>
                <p className="num text-right">
                  {qty(it.qty)} {it.unit} × {money(Math.round(Number(it.unitValue) * 100))} = {money(it.totalCents)}
                </p>
              </div>
              {it.match && (
                <p className="mt-1 text-xs text-ink-soft">
                  No cadastro: {it.match.productName} · {it.match.label} ({it.match.sku}), pelo {BY[it.match.by]}
                </p>
              )}
              {it.divergences.map((d) => (
                <p key={d} className="mt-1 text-xs font-medium text-bad">
                  {d}
                </p>
              ))}
            </li>
          ))}
        </ul>
        {c.missingFromInvoice.length > 0 && (
          <div className="mt-4 border-t border-line pt-3 text-sm">
            <p className="font-medium">Pendentes no pedido e ausentes na nota</p>
            <ul className="mt-1 list-disc pl-5 text-ink-soft">
              {c.missingFromInvoice.map((m) => (
                <li key={m.itemId}>
                  {m.label}: {qty(m.pending)} pendente(s)
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <Suspense>
        <Detail />
      </Suspense>
    </Guard>
  );
}
