'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { qty } from '@/lib/format';
import { useMe } from './shell';
import { Input } from './ui';

export type PackagingHit = { id: string; kind: 'sale' | 'purchase'; label: string; unit_code: string; base_qty: string; variant_id: string; sku: string; product_name: string; base_unit: string };

/** Chave de requisicao: a tela reenviando o mesmo lancamento nao duplica a entrada no estoque. */
export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const MOVEMENT_LABELS: Record<string, string> = {
  receipt: 'Entrada de compra',
  sale: 'Venda',
  return: 'Devolução',
  loss: 'Perda',
  damage: 'Avaria',
  adjustment: 'Ajuste',
  inventory: 'Inventário',
  reserve: 'Reserva',
  release: 'Liberação de reserva',
  // SGLog Fase 3
  transfer_out: 'Transferência enviada',
  transfer_in: 'Transferência recebida',
  transfer_loss: 'Extravio na transferência',
  transfer_return: 'Transferência recusada',
  block: 'Bloqueio / quarentena',
  unblock: 'Liberação do bloqueio',
  damage_hold: 'Separado como avariado',
  damage_release: 'Avariado recuperado',
  reversal: 'Estorno',
};

export const TRANSFER_STATUS: Record<string, { label: string; tone: 'neutral' | 'act' | 'warn' | 'good' | 'bad' }> = {
  in_transit: { label: 'Em trânsito', tone: 'act' },
  partial: { label: 'Recebida em parte', tone: 'warn' },
  received: { label: 'Recebida', tone: 'good' },
  closed_divergent: { label: 'Encerrada com divergência', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  is_default: boolean;
  active: boolean;
  cep: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  uf: string | null;
  on_hand?: string;
  reserved?: string;
  blocked?: string;
  damaged?: string;
  in_transit?: string;
  variants?: number;
  alerts?: number;
  incoming?: number;
};

/**
 * Permissoes de estoque que valem de fato: as que exigem verificacao em duas etapas (ajuste e cadastro de
 * deposito) so contam com ela ativa, como no resto do painel.
 */
export function useStockAccess() {
  const { me, can } = useMe();
  const mfa = me.user.mfaEnabled;
  return { manage: can('stock.manage'), transfer: can('stock.transfer'), adjust: can('stock.adjust') && mfa, warehouses: can('settings.manage') && mfa, adjustNeedsMfa: can('stock.adjust') && !mfa };
}

/** Depositos cadastrados (ativos primeiro, o padrao no topo). */
export function useWarehouses() {
  const [items, setItems] = useState<Warehouse[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => api<{ items: Warehouse[] }>('/admin/warehouses').then((r) => setItems(r.items), (e) => setError(e.message)), []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { warehouses: items, active: items?.filter((w) => w.active) ?? [], error, reload };
}

export const PO_STATUS: Record<string, { label: string; tone: 'neutral' | 'act' | 'warn' | 'good' | 'bad' }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  sent: { label: 'Enviado', tone: 'act' },
  partial: { label: 'Recebido em parte', tone: 'warn' },
  received: { label: 'Recebido', tone: 'good' },
  canceled: { label: 'Cancelado', tone: 'neutral' },
};

/** "Pacote com 100 (100 UN)" */
export const packLabel = (label: string, baseQty: string, unit: string) => `${label} (${qty(baseQty)} ${unit})`;

/** Busca de embalagem por nome, SKU ou código de barras. */
export function PackagingPicker({ onPick, placeholder = 'Adicionar produto: nome, SKU ou código de barras' }: { onPick: (p: PackagingHit) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PackagingHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ items: PackagingHit[] }>(`/admin/stock/packagings?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.items), () => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative">
      <Input aria-label="Buscar produto" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-line-strong bg-card shadow-lg">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-sunken"
                onClick={() => {
                  onPick(h);
                  setQ('');
                  setHits([]);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{h.product_name}</span>
                  <span className="block text-xs text-ink-faint">
                    <span className="font-mono">{h.sku}</span> · {packLabel(h.label, h.base_qty, h.base_unit)}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-ink-soft">{h.kind === 'purchase' ? 'Compra' : 'Venda'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
