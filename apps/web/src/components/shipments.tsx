'use client';

// SGLog Fase 5 (docs/26-sglog-fase5.md): remessas, separacao, conferencia, embalagem e expedicao.
import Link from '@/components/painel-link';
import { Badge, Panel, type Tone } from '@/components/ui';
import { qty, when } from '@/lib/format';

export const SHIPMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'A separar', tone: 'warn' },
  picking: { label: 'Em separação', tone: 'act' },
  checking: { label: 'Em conferência', tone: 'act' },
  packed: { label: 'Embalada', tone: 'good' },
  shipped: { label: 'Despachada', tone: 'neutral' },
  in_transit: { label: 'Em trânsito', tone: 'neutral' },
  out_for_delivery: { label: 'Saiu para entrega', tone: 'neutral' },
  delivered: { label: 'Entregue', tone: 'good' },
  delivery_failed: { label: 'Falha na entrega', tone: 'bad' },
  returned: { label: 'Devolvida', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};
export const SHIPMENT_KIND: Record<string, string> = { delivery: 'Entrega', pickup: 'Retirada na loja', marketplace: 'Marketplace', legacy: 'Despacho anterior' };
export const OPEN_SHIPMENT = ['pending', 'picking', 'checking', 'packed'];
/** Etapas mostradas na tela da remessa. */
export const SHIPMENT_STEPS: [string, string][] = [
  ['pending', 'A separar'],
  ['picking', 'Separação'],
  ['checking', 'Conferência'],
  ['packed', 'Embalada'],
  ['shipped', 'Despachada'],
  ['delivered', 'Entregue'],
];

export function ShipmentBadge({ status }: { status: string }) {
  const s = SHIPMENT_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export type OrderShipment = {
  id: string;
  seq: number;
  kind: string;
  status: string;
  carrier: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  volumes: number | null;
  weight_g: number | null;
  shipped_at: string | null;
  delivered_at: string | null;
  warehouse_name?: string | null;
  cancel_reason?: string | null;
  items: { sku: string; productName: string; qty: string; picked?: string; checked?: string }[];
};

/** Remessas do pedido no painel: situacao, itens e o caminho para a tela de expedicao. */
export function OrderShipmentsPanel({ shipments }: { shipments: OrderShipment[] }) {
  const list = shipments.filter((s) => s.kind !== 'legacy' || s.status !== 'canceled');
  if (!list.length) return null;
  const open = list.filter((s) => OPEN_SHIPMENT.includes(s.status));
  return (
    <Panel title="Remessas" description={open.length ? 'A situação do pedido acompanha as remessas: separe, confira, embale e despache pela Expedição.' : undefined}>
      <ul className="space-y-2">
        {list.map((s) => (
          <li key={s.id} className="rounded-md border border-line px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                Remessa nº {s.seq} · {SHIPMENT_KIND[s.kind] ?? s.kind}
                {s.warehouse_name && <span className="font-normal text-ink-faint"> · {s.warehouse_name}</span>}
              </span>
              <ShipmentBadge status={s.status} />
            </div>
            <p className="mt-1 text-xs text-ink-soft">{s.items.map((i) => `${i.sku}: ${qty(i.qty)}`).join(' · ') || 'Sem itens (despacho anterior)'}</p>
            {(s.tracking_code || s.shipped_at) && (
              <p className="mt-1 text-xs text-ink-soft">
                {s.shipped_at && `Saiu ${when(s.shipped_at)}`}
                {s.carrier && ` · ${s.carrier}`}
                {s.tracking_code && ` · ${s.tracking_code}`}
                {s.delivered_at && ` · entregue ${when(s.delivered_at)}`}
              </p>
            )}
            {s.cancel_reason && <p className="mt-1 text-xs text-ink-faint">Cancelada: {s.cancel_reason}</p>}
            {s.kind !== 'legacy' && (
              <Link href={`/painel/logistica/expedicao/${s.id}`} className="mt-1 inline-block text-xs font-medium text-act hover:underline">
                Abrir na expedição
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
