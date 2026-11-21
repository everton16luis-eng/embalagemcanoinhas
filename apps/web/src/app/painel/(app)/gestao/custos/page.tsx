'use client';

// SGLog Fase 10a: configuracoes de custo, lancamentos de custos externos, importacao por planilha e conferencia C22-C24.
import { useState } from 'react';
import { CostEntries, CostImport, CostReconcile, CostSettings } from '@/components/costs';
import { Guard, useMe } from '@/components/shell';
import { PageHeader } from '@/components/ui';

const TABS = [
  ['settings', 'Configurações', 'costs.view|costs.settings|fiscal.validate'],
  ['entries', 'Lançamentos', 'costs.view|costs.record'],
  ['import', 'Importação', 'costs.record'],
  ['reconcile', 'Conferência', 'costs.view|margins.view'],
] as const;

function Costs() {
  const { can } = useMe();
  const tabs = TABS.filter(([, , p]) => p.split('|').some((x) => can(x)));
  const [tab, setTab] = useState<string>(tabs[0]?.[0] ?? 'settings');
  return (
    <div className="space-y-4">
      <PageHeader title="Custos e margens" description="Taxas, tributos estimados, embalagem e custos externos usados na margem de contribuição dos pedidos. Margem de contribuição não é lucro líquido." />
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'settings' && <CostSettings />}
      {tab === 'entries' && <CostEntries />}
      {tab === 'import' && <CostImport />}
      {tab === 'reconcile' && <CostReconcile />}
    </div>
  );
}

export default function Page() {
  return (
    <Guard perm="costs.view|margins.view|costs.settings|costs.record|fiscal.validate">
      <Costs />
    </Guard>
  );
}
