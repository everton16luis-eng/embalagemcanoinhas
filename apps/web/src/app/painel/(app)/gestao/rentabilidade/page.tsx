'use client';

// SGLog Fase 10b: rentabilidade por pedido, produto, categoria, canal, fornecedor e UF.
import { Profitability } from '@/components/management';
import { Guard } from '@/components/shell';
import { PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <Guard perm="management.view">
      <div className="space-y-4">
        <PageHeader title="Rentabilidade" description="Margem de contribuição por pedido e por grupo. Pedido parcial deixa de fora o custo que falta." />
        <Profitability />
      </div>
    </Guard>
  );
}
