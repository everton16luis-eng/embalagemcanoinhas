'use client';

// SGLog Fase 7 (D7-1): versao enviada do pedido ao fornecedor, exatamente como foi guardada, para imprimir ou salvar
// em PDF pelo navegador. Sem dados de clientes. Sem a versao (?v=), a previa do pedido atual (nao gravada).
import { Printer } from 'lucide-react';
import Link from '@/components/painel-link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Guard } from '@/components/shell';
import { CHANNEL, day } from '@/components/supply';
import { Button, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, money, qty, when } from '@/lib/format';

type Address = { street: string; number: string; complement: string | null; district: string; city: string; uf: string; cep: string };
type Doc = {
  purchaseNumber: number;
  generatedOn: string;
  buyer: { legalName: string; tradeName: string | null; cnpj: string; phone: string | null; email: string | null; address: Address | null };
  supplier: { name: string; document: string | null };
  deliverTo: { warehouse: string; address: Address; addressSource: string };
  items: { line: number; sku: string; product: string; packaging: string; supplierCode: string | null; packs: number; packCostCents: number; subtotalCents: number }[];
  goodsCents: number;
  freightCents: number;
  otherCostsCents: number;
  totalCents: number;
  expectedAt: string | null;
  message: string | null;
};
type Saved = { version: number; channel: string; content: Doc; body_text: string; content_hash: string; created_at: string; actor_name: string };

const addr = (a: Address) => `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ''} · ${a.district} · ${a.city}/${a.uf} · CEP ${a.cep.slice(0, 5)}-${a.cep.slice(5)}`;

function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const v = useSearchParams().get('v');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [preview, setPreview] = useState<{ document: Doc | null; missing: string[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (v) api(`/admin/purchase-orders/${id}/documents/${v}`).then((r) => setSaved(r.document), (e) => setError(e.message));
    else api(`/admin/purchase-orders/${id}/document`).then(setPreview, (e) => setError(e.message));
  }, [id, v]);
  const doc = saved?.content ?? preview?.document ?? null;
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (preview && !preview.document) return <Notice tone="warn">Faltam dados para gerar o pedido: {preview.missing.join('; ')}.</Notice>;
  if (!doc) return <p className="text-sm text-ink-faint">Carregando…</p>;
  return (
    <>
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #po-doc, #po-doc * { visibility: visible !important; }
        #po-doc { position: absolute; inset: 0 auto auto 0; width: 100%; padding: 0; border: 0; box-shadow: none; }
        .no-print { display: none !important; }
      }`}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href={`/painel/compras/${id}`} className="text-sm text-act hover:underline">
          ← Voltar à compra
        </Link>
        <Button variant="primary" onClick={() => window.print()}>
          <Printer size={16} /> Imprimir ou salvar em PDF
        </Button>
        {saved ? (
          <span className="text-xs text-ink-soft">
            Versão {saved.version} enviada em {when(saved.created_at)} por {saved.actor_name} ({CHANNEL[saved.channel] ?? saved.channel}). Imutável.
          </span>
        ) : (
          <span className="text-xs text-warn">Prévia do pedido atual: ainda não registrada como enviada.</span>
        )}
      </div>
      <article id="po-doc" className="mx-auto max-w-3xl rounded-lg border border-line bg-card p-4 text-sm text-ink sm:p-8" data-testid="po-document">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
          <div>
            <h1 className="text-lg font-semibold">Pedido de compra nº {doc.purchaseNumber}</h1>
            <p className="text-ink-soft">
              {doc.buyer.tradeName ?? doc.buyer.legalName}
              {saved ? ` · versão ${saved.version}` : ''}
            </p>
          </div>
          <p className="text-right text-xs text-ink-soft">Emitido em {day(doc.generatedOn)}</p>
        </header>
        <section className="grid gap-3 border-b border-line py-3 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Comprador</h2>
            <p className="font-medium">{doc.buyer.legalName}</p>
            <p>CNPJ {formatCnpj(doc.buyer.cnpj)}</p>
            {doc.buyer.address && <p className="text-ink-soft">{addr(doc.buyer.address)}</p>}
            {(doc.buyer.phone || doc.buyer.email) && <p className="text-ink-soft">{[doc.buyer.phone, doc.buyer.email].filter(Boolean).join(' · ')}</p>}
          </div>
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Fornecedor</h2>
            <p className="font-medium">{doc.supplier.name}</p>
            {doc.supplier.document && <p>{doc.supplier.document.length === 14 ? `CNPJ ${formatCnpj(doc.supplier.document)}` : `CPF ${doc.supplier.document}`}</p>}
            <h2 className="mt-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">Entregar em</h2>
            <p className="font-medium">{doc.deliverTo.warehouse}</p>
            <p className="text-ink-soft">{addr(doc.deliverTo.address)}</p>
            {doc.expectedAt && <p>Entrega desejada até {day(doc.expectedAt)}</p>}
          </div>
        </section>
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-[480px] text-sm">
            <thead className="text-left text-xs text-ink-soft">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-2 font-medium">#</th>
                <th className="py-1.5 pr-2 font-medium">Produto</th>
                <th className="py-1.5 pr-2 text-right font-medium">Qtd.</th>
                <th className="py-1.5 pr-2 text-right font-medium">Preço</th>
                <th className="py-1.5 text-right font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {doc.items.map((l) => (
                <tr key={l.line}>
                  <td className="py-1.5 pr-2 align-top">{l.line}</td>
                  <td className="py-1.5 pr-2">
                    <span className="block">{l.product}</span>
                    <span className="block text-xs text-ink-faint">
                      {l.sku} · {l.packaging}
                      {l.supplierCode ? ` · cód. fornecedor ${l.supplierCode}` : ''}
                    </span>
                  </td>
                  <td className="num py-1.5 pr-2 text-right">{qty(l.packs)}</td>
                  <td className="num py-1.5 pr-2 text-right">{money(l.packCostCents)}</td>
                  <td className="num py-1.5 text-right">{money(l.subtotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="mt-3 ml-auto max-w-xs space-y-1 border-t border-line pt-2">
          <div className="flex justify-between">
            <dt className="text-ink-soft">Mercadoria</dt>
            <dd className="num">{money(doc.goodsCents)}</dd>
          </div>
          {doc.freightCents > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-soft">Frete</dt>
              <dd className="num">{money(doc.freightCents)}</dd>
            </div>
          )}
          {doc.otherCostsCents > 0 && (
            <div className="flex justify-between">
              <dt className="text-ink-soft">Outras despesas</dt>
              <dd className="num">{money(doc.otherCostsCents)}</dd>
            </div>
          )}
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd className="num">{money(doc.totalCents)}</dd>
          </div>
        </dl>
        {doc.message && <p className="mt-4 whitespace-pre-line">{doc.message}</p>}
        <p className="mt-4 text-ink-soft">Por favor, confirme este pedido informando quantidades, preços e prazo de entrega de cada item.</p>
        {saved && <p className="mt-6 font-mono text-[10px] break-all text-ink-faint">Conferência: {saved.content_hash}</p>}
      </article>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="purchases.view">
      <Suspense>
        <DocumentView />
      </Suspense>
    </Guard>
  );
}
