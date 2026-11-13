'use client';

import { useParams } from 'next/navigation';
import { OrderView } from '@/components/loja/order-view';

export default function OrderPage() {
  const { token } = useParams<{ token: string }>();
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-6 sm:px-8">
      <OrderView base={`/public/orders/${encodeURIComponent(token)}`} devToken={token} />
      <p className="mt-8 text-[13px] text-g-faint">Guarde o endereço desta página: é o link de acompanhamento do seu pedido.</p>
    </div>
  );
}
