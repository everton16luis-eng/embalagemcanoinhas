'use client';

import { ImageOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, FISCAL_STATUS, Input, Notice, PageHeader, PRODUCT_STATUS, Select } from '@/components/ui';
import { api, imageUrl } from '@/lib/api';
import { money } from '@/lib/format';

type Row = {
  id: string;
  name: string;
  status: string;
  sku: string | null;
  base_unit: string;
  availability_mode: string;
  category_name: string | null;
  fiscal_status: string;
  variant_count: number;
  price_cents: string | null;
  unit_price_cents: string | null;
  image_key: string | null;
};

function ProductList() {
  const { can } = useMe();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [fiscal, setFiscal] = useState('');
  const [data, setData] = useState<{ products: Row[]; total: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '50' });
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      if (fiscal) params.set('fiscal', fiscal);
      api(`/admin/products?${params}`).then(setData, (e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, status, fiscal]);

  return (
    <>
      <PageHeader
        title="Produtos"
        description="SKU, embalagens de venda e de compra, preços e classificação fiscal."
        actions={
          <>
            {can('catalog.import') && can('catalog.manage') && <Link href="/painel/produtos/importar"><Button variant="secondary">Importar via Excel</Button></Link>}
            {can('catalog.manage') && <Link href="/painel/produtos/novo"><Button variant="primary">Novo produto</Button></Link>}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input aria-label="Buscar" placeholder="Buscar por nome, SKU ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todas as situações</option>
          <option value="active">Ativos</option>
          <option value="draft">Rascunhos</option>
          <option value="inactive">Inativos</option>
        </Select>
        <Select aria-label="Fiscal" value={fiscal} onChange={(e) => setFiscal(e.target.value)} className="w-auto">
          <option value="">Qualquer situação fiscal</option>
          <option value="pending">Fiscal pendente</option>
          <option value="informed">Aguardando contador</option>
          <option value="validated">Fiscal validado</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && (
        <div className="overflow-hidden rounded-lg border border-line bg-card">
          {data.products.length === 0 ? (
            <Empty title={q || status || fiscal ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado.'}>
              {!q && !status && !fiscal && 'Comece pelo cadastro das categorias e depois dos produtos.'}
            </Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-sunken/60 text-left text-xs font-medium text-ink-soft">
                <tr>
                  <th className="py-2 pl-4 font-medium">Produto</th>
                  <th className="hidden py-2 font-medium md:table-cell">SKU</th>
                  <th className="py-2 text-right font-medium">Preço</th>
                  <th className="hidden py-2 pr-4 pl-6 font-medium sm:table-cell">Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.products.map((p) => (
                  <tr key={p.id} className="hover:bg-sunken/40">
                    <td className="py-2.5 pl-4">
                      <Link href={`/painel/produtos/${p.id}`} className="flex items-center gap-3">
                        {p.image_key ? (
                          <img src={imageUrl(p.image_key)} alt="" className="size-10 shrink-0 rounded border border-line object-cover" />
                        ) : (
                          <span className="grid size-10 shrink-0 place-items-center rounded border border-dashed border-line-strong text-ink-faint"><ImageOff size={16} aria-label="Sem foto" /></span>
                        )}
                        <span className="min-w-0">
                          <span className="block font-medium hover:underline">{p.name}</span>
                          <span className="block text-xs text-ink-faint">
                            {p.category_name ?? 'Sem categoria'}
                            {p.variant_count > 1 && ` · ${p.variant_count} variações`}
                            {p.availability_mode === 'made_to_order' && ' · Sob encomenda'}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="hidden py-2.5 font-mono text-xs md:table-cell">{p.sku}</td>
                    <td className="num py-2.5 text-right">
                      <span className="block">{money(p.price_cents)}</span>
                      <span className="block text-xs text-ink-faint">{money(p.unit_price_cents)}/{p.base_unit}</span>
                    </td>
                    <td className="hidden py-2.5 pr-4 pl-6 sm:table-cell">
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={PRODUCT_STATUS[p.status]!.tone}>{PRODUCT_STATUS[p.status]!.label}</Badge>
                        <Badge tone={FISCAL_STATUS[p.fiscal_status]!.tone}>{FISCAL_STATUS[p.fiscal_status]!.label}</Badge>
                      </span>
                    </td>
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
    <Guard perm="catalog.view">
      <ProductList />
    </Guard>
  );
}
