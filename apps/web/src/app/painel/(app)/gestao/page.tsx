'use client';

// SGLog Fase 10b: painel Gestao (resumo financeiro com cobertura, canais, custos que faltam e indicadores).
import { Dashboard } from '@/components/management';
import { Guard } from '@/components/shell';
import { PageHeader } from '@/components/ui';

export default function Page() {
  return (
    <Guard perm="management.view">
      <div className="space-y-4">
        <PageHeader title="Painel Gestão" description="Receita, custos e margem de contribuição dos pedidos pagos, com a cobertura dos custos. Margem de contribuição não é lucro líquido." />
        <Dashboard />
      </div>
    </Guard>
  );
}
