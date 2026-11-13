'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { emptyProduct, ProductEditor } from '@/components/product-form';
import { Guard } from '@/components/shell';
import { PageHeader } from '@/components/ui';

export default function NewProductPage() {
  const initial = useMemo(emptyProduct, []);
  return (
    <Guard perm="catalog.manage">
      <p className="mb-2 text-sm">
        <Link href="/painel/produtos" className="text-ink-soft hover:underline">← Produtos</Link>
      </p>
      <PageHeader title="Novo produto" description="Fotos e classificação fiscal são adicionadas depois de salvar." />
      <ProductEditor initial={initial} />
    </Guard>
  );
}
