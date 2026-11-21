'use client';

// SGLog Fase 10b: custos logisticos (frete cobrado x pago, embalagem, devolucoes, perdas de estoque).
import { LogisticsCosts } from '@/components/management';
import { Guard } from '@/components/shell';
import { PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <Guard perm="management.view">
      <div className="space-y-4">
        <PageHeader title="Custos logísticos" description="Frete cobrado e pago, embalagem, devoluções e perdas de estoque." />
        <LogisticsCosts />
      </div>
    </Guard>
  );
}
