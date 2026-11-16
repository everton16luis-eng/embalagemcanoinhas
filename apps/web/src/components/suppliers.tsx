'use client';

import { Star } from 'lucide-react';
import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money, qty, unitMoney, when } from '@/lib/format';
import { Badge, Input, Notice } from './ui';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'act';

export const SUPPLIER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Ativo', tone: 'good' },
  inactive: { label: 'Inativo', tone: 'neutral' },
  blocked: { label: 'Bloqueado', tone: 'bad' },
};
export const OFFER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Ativa', tone: 'good' },
  paused: { label: 'Pausada', tone: 'warn' },
  ended: { label: 'Encerrada', tone: 'neutral' },
};
export const AVAILABILITY_SOURCE: Record<string, string> = { manual: 'Informada no painel', whatsapp: 'WhatsApp', email: 'E-mail', phone: 'Telefone', api: 'Integração' };

/** Selo da situacao do fornecedor; bloqueado mostra o motivo; arquivado tem selo proprio. */
export function SupplierBadge({ status, archivedAt, blockedReason }: { status: string; archivedAt?: string | null; blockedReason?: string | null }) {
  if (archivedAt) return <Badge>Arquivado</Badge>;
  const s = SUPPLIER_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <span title={blockedReason ?? undefined}>
      <Badge tone={s.tone}>{status === 'blocked' && blockedReason ? `Bloqueado: ${blockedReason}` : s.label}</Badge>
    </span>
  );
}

/** Disponibilidade informada pelo fornecedor. Nunca e estoque da loja: o texto deixa isso claro. */
export function AvailabilityBadge({ qtyValue, validUntil, expired, unit, warnDays = 3 }: { qtyValue: string | null; validUntil: string | null; expired: boolean | null; unit?: string; warnDays?: number }) {
  if (qtyValue === null || !validUntil) return <Badge>Sem informação</Badge>;
  if (expired) return <Badge tone="warn">Vencida</Badge>;
  const days = Math.ceil((new Date(validUntil).getTime() - Date.now()) / 86_400_000);
  return (
    <span title={`Informado pelo fornecedor; válido até ${when(validUntil)}`}>
      <Badge tone={days <= warnDays ? 'warn' : 'good'}>
        {qty(qtyValue)}
        {unit ? ` ${unit}` : ''} · {days <= warnDays ? `vence em ${Math.max(days, 0)} d` : 'em dia'}
      </Badge>
    </span>
  );
}

type ChoiceOption = {
  rank: number;
  offerId: string;
  supplierName: string;
  packagingLabel: string;
  packs: number;
  totalCents: number;
  costComplete: boolean;
  unitCostCents: number;
  surplus: number;
  leadDays: number | null;
  isPrimary: boolean;
  warnings: string[];
  reasons: string[];
};
type Comparison = {
  variant: { id: string; sku: string; product_name: string; base_unit: string };
  need: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offers: any[];
  choice: { recommended: ChoiceOption | null; options: ChoiceOption[]; excluded: { offerId: string; supplierName: string; packagingLabel: string; reasons: string[] }[]; summary: string };
  settings: { tie_tolerance_pct: string; stale_quote_days: number; availability_warning_days: number };
};

/**
 * Comparacao de fornecedores de uma variante, com a sugestao explicada. So sugere: nao cria pedido, nao muda o
 * principal e nao mexe na reposicao (D2-6, D2-9).
 */
export function SupplierComparison({ variantId, compact = false, initialNeed }: { variantId: string; compact?: boolean; initialNeed?: string }) {
  const [need, setNeed] = useState(initialNeed ?? '');
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      const n = need.trim().replace(',', '.');
      const qs = n && Number(n) > 0 ? `?need=${encodeURIComponent(n)}` : '';
      api<Comparison>(`/admin/suppliers/variants/${variantId}/comparison${qs}`).then(setData, (e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [variantId, need]);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <p className="text-sm text-ink-faint">Carregando fornecedores…</p>;
  const unit = data.variant.base_unit;
  const byOffer = new Map(data.offers.map((o) => [o.id, o]));
  const rec = data.choice.recommended;
  const rows = [...data.choice.options.map((o) => ({ kind: 'option' as const, o })), ...data.choice.excluded.map((e) => ({ kind: 'excluded' as const, e }))];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={`need-${variantId}`} className="text-ink-soft">
          Necessidade ({unit})
        </label>
        <Input id={`need-${variantId}`} className="w-28" inputMode="decimal" placeholder={qty(data.need)} value={need} onChange={(e) => setNeed(e.target.value)} />
        <span className="text-xs text-ink-faint">Empate técnico até {Number(data.settings.tie_tolerance_pct).toLocaleString('pt-BR')} % do custo total.</span>
      </div>
      {data.offers.length === 0 ? (
        <p className="text-sm text-ink-soft">Nenhum fornecedor cadastrado para esta variante.</p>
      ) : (
        <>
          <Notice tone={rec ? 'act' : 'warn'}>
            <strong>Sugestão para {qty(data.need)} {unit}:</strong> {data.choice.summary}
            {rec && <span className="block text-xs">Motivo: {rec.reasons.join('; ')}.</span>}
          </Notice>
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-ink-soft">
                <tr className="border-b border-line">
                  <th className="py-2 pl-4 font-medium sm:pl-5">Fornecedor / embalagem</th>
                  <th className="py-2 pl-3 text-right font-medium">Custo/{unit}</th>
                  {!compact && <th className="py-2 pl-3 text-right font-medium">Compra</th>}
                  <th className="py-2 pl-3 text-right font-medium">Total</th>
                  <th className="py-2 pl-3 text-right font-medium">Prazo</th>
                  {!compact && <th className="py-2 pl-3 font-medium">Disponível (fornecedor)</th>}
                  {!compact && <th className="py-2 pl-3 font-medium">Cotação</th>}
                  <th className="py-2 pr-4 pl-3 font-medium sm:pr-5">Por quê</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const id = r.kind === 'option' ? r.o.offerId : r.e.offerId;
                  const t = byOffer.get(id);
                  const isRec = r.kind === 'option' && r.o.rank === 1;
                  return (
                    <tr key={id} className={r.kind === 'excluded' ? 'text-ink-faint' : isRec ? 'bg-act-tint/40' : ''}>
                      <td className="py-2 pl-4 sm:pl-5">
                        <span className="flex items-center gap-1 font-medium">
                          {t?.is_primary && <Star size={14} className="fill-current text-warn" aria-label="Fornecedor principal" />}
                          <Link href={`/painel/fornecedores/${t?.supplier_id}?aba=produtos`} className="hover:underline">
                            {r.kind === 'option' ? r.o.supplierName : r.e.supplierName}
                          </Link>
                          {t && t.supplier_status !== 'active' && <SupplierBadge status={t.supplier_status} archivedAt={t.supplier_archived_at} blockedReason={t.supplier_blocked_reason} />}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {t?.packaging_label} ({qty(t?.base_qty ?? 0)} {unit}){t?.min_order_packs && ` · mínimo ${qty(t.min_order_packs)}`}
                          {t?.order_multiple_packs && ` · múltiplo ${qty(t.order_multiple_packs)}`}
                        </span>
                      </td>
                      <td className="num py-2 pl-3 text-right">{t ? unitMoney(t.unit_cost_cents) : '—'}</td>
                      {!compact && <td className="num py-2 pl-3 text-right">{r.kind === 'option' ? `${qty(r.o.packs)} emb.` : '—'}</td>}
                      <td className="num py-2 pl-3 text-right">
                        {r.kind === 'option' ? (
                          <>
                            {money(r.o.totalCents)}
                            {!r.o.costComplete && <span className="block text-xs text-warn">+ frete/despesas não informados</span>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num py-2 pl-3 text-right">{t?.lead_days === null || t?.lead_days === undefined ? '—' : `${t.lead_days} d`}</td>
                      {!compact && (
                        <td className="py-2 pl-3">
                          <AvailabilityBadge qtyValue={t?.available_qty ?? null} validUntil={t?.availability_valid_until ?? null} expired={t?.availability_expired ?? null} unit={unit} warnDays={data.settings.availability_warning_days} />
                        </td>
                      )}
                      {!compact && (
                        <td className="py-2 pl-3 text-xs">
                          {t ? `há ${t.quote_age_days} d` : '—'}
                          {t && t.quote_age_days > data.settings.stale_quote_days && (
                            <span className="ml-1">
                              <Badge tone="warn">antiga</Badge>
                            </span>
                          )}
                        </td>
                      )}
                      <td className="py-2 pr-4 pl-3 text-xs sm:pr-5">
                        {r.kind === 'option' ? (
                          <>
                            {isRec ? <Badge tone="act">Sugerido</Badge> : `${r.o.rank}º: `}
                            {!isRec && r.o.reasons.join('; ')}
                            {r.o.warnings.length > 0 && <span className="block text-ink-faint">{r.o.warnings.join(' · ')}</span>}
                          </>
                        ) : (
                          <>Fora: {r.e.reasons.join('; ')}</>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-faint">Disponibilidade é a informada pelo fornecedor e não entra no estoque da loja. A sugestão não cria pedido nem muda o fornecedor principal.</p>
        </>
      )}
    </div>
  );
}
