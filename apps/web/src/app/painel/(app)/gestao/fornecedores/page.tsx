'use client';

// SGLog Fase 10b: desempenho de fornecedores (prazo, nota, variacao de custo, ocorrencias e devolucoes).
import { SupplierPerformance } from '@/components/management';
import { Guard } from '@/components/shell';
import { PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <Guard perm="management.view">
      <div className="space-y-4">
        <PageHeader title="Desempenho de fornecedores" description="Recebimentos do período: prazo, diferença de nota, variação de custo e devoluções." />
        <SupplierPerformance />
      </div>
    </Guard>
  );
}
