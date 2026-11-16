'use client';

import Link from '@/components/painel-link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Notice, PageHeader } from '@/components/ui';
import { api, upload } from '@/lib/api';
import { formatCnpj, money, when } from '@/lib/format';

type Row = {
  id: string;
  access_key: string;
  series: string;
  number: string;
  issued_at: string | null;
  supplier_name: string;
  supplier_document: string;
  total_cents: string;
  protocol_status: string | null;
  created_at: string;
  purchase_order_id: string | null;
  purchase_order_number: number | null;
  item_count: number;
};

function InvoiceList() {
  const { can } = useMe();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ invoices: Row[] }>('/admin/purchase-invoices').then((r) => setRows(r.invoices), (e) => setError(e.message));
  }, []);

  async function send(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await upload<{ invoice: { id: string }; duplicate?: boolean }>('/admin/purchase-invoices', file);
      router.push(`/painel/compras/notas/${r.invoice.id}${r.duplicate ? '?repetida=1' : ''}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <PageHeader
        title="Notas de compra"
        description="Importe o XML da NF-e do fornecedor para conferir itens, quantidades e preços com o pedido de compra. Importar não mexe no estoque: a entrada continua sendo o recebimento."
        actions={
          can('purchases.manage') && (
            <>
              <input ref={input} type="file" accept=".xml,application/xml,text/xml" className="sr-only" aria-label="Arquivo XML da nota" onChange={(e) => send(e.target.files?.[0])} />
              <Button variant="primary" busy={busy} onClick={() => input.current?.click()}>
                Importar XML
              </Button>
            </>
          )
        }
      />
      <p className="mb-4 text-sm">
        <Link href="/painel/compras" className="text-act-dark underline">
          Voltar para Compras
        </Link>
      </p>
      {error && <Notice tone="bad">{error}</Notice>}
      {rows && (
        <div className="overflow-x-auto rounded-lg border border-line bg-card">
          {rows.length === 0 ? (
            <Empty title="Nenhuma nota de compra importada." />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Nota</th>
                  <th className="hidden py-2 pl-3 font-medium sm:table-cell">Pedido de compra</th>
                  <th className="py-2 pr-4 pl-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-sunken/40">
                    <td className="py-2.5 pl-4">
                      <Link href={`/painel/compras/notas/${r.id}`} className="block">
                        <span className="font-medium hover:underline">
                          NF {r.number} · {r.supplier_name}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {formatCnpj(r.supplier_document)} · {r.item_count} item(ns) · importada {when(r.created_at)}
                        </span>
                      </Link>
                    </td>
                    <td className="hidden py-2.5 pl-3 sm:table-cell">
                      {r.purchase_order_number ? `Nº ${r.purchase_order_number}` : <Badge tone="warn">Sem vínculo</Badge>}
                    </td>
                    <td className="num py-2.5 pr-4 pl-3 text-right">{money(r.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <InvoiceList />
    </Guard>
  );
}
