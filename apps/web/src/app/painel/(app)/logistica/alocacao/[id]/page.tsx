'use client';

import Link from '@/components/painel-link';
import { useParams } from 'next/navigation';
import { AllocationPanel } from '@/components/logistics';
import { Guard, useMe } from '@/components/shell';
import { Button, PageHeader } from '@/components/ui';

function Allocation() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  return (
    <>
      <PageHeader
        title="Alocação do pedido"
        actions={
          <span className="flex gap-2">
            {can('orders.view') && (
              <Link href={`/painel/pedidos/${id}`}>
                <Button>Ver pedido</Button>
              </Link>
            )}
            <Link href="/painel/logistica/alocacao">
              <Button>Voltar</Button>
            </Link>
          </span>
        }
      />
      <div className="max-w-3xl">
        <AllocationPanel orderId={id} />
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="logistics.view">
      <Allocation />
    </Guard>
  );
}
