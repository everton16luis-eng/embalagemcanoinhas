'use client';

import Link from 'next/link';
import { useMemo, useRef } from 'react';
import { PHOTO_ISSUES_KEY, ProductImages, type PendingImages } from '@/components/product-images';
import { emptyProduct, ProductEditor } from '@/components/product-form';
import { Guard } from '@/components/shell';
import { PageHeader } from '@/components/ui';

export default function NewProductPage() {
  const initial = useMemo(emptyProduct, []);
  const pending = useRef<PendingImages>(null);

  const afterCreate = async (product: { id: string }) => {
    const problems = (await pending.current?.uploadAll(product.id)) ?? [];
    // A tela de edicao mostra o que nao subiu (o produto ja foi criado).
    if (problems.length) {
      try {
        sessionStorage.setItem(`${PHOTO_ISSUES_KEY}:${product.id}`, JSON.stringify(problems));
      } catch {}
    }
  };

  return (
    <Guard perm="catalog.manage">
      <p className="mb-2 text-sm">
        <Link href="/painel/produtos" className="text-ink-soft hover:underline">← Produtos</Link>
      </p>
      <PageHeader title="Novo produto" description="A classificação fiscal é adicionada depois de salvar." />
      <div className="space-y-4">
        <ProductImages editable pendingRef={pending} />
        <ProductEditor initial={initial} afterCreate={afterCreate} />
      </div>
    </Guard>
  );
}
