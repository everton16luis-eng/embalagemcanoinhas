'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { OrderView } from '@/components/loja/order-view';

export default function AccountOrderPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-4 sm:px-8">
      <Link href="/conta" className="text-[13px] font-semibold text-g-green">
        ‹ Minha conta
      </Link>
      <div className="mt-2">
        <OrderView base={`/customer/orders/${encodeURIComponent(id)}`} />
      </div>
    </div>
  );
}
