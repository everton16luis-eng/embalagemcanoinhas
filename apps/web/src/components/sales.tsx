import { money } from '@/lib/format';

export const QUOTE_STATUS: Record<string, { label: string; tone: 'neutral' | 'act' | 'warn' | 'good' | 'bad' }> = {
  open: { label: 'Em aberto', tone: 'act' },
  expired: { label: 'Vencido', tone: 'warn' },
  converted: { label: 'Virou pedido', tone: 'good' },
  canceled: { label: 'Cancelado', tone: 'bad' },
};

export const quoteState = (q: { status: string; expired: boolean }) => (q.status === 'open' && q.expired ? 'expired' : q.status);

/**
 * Link oficial "clique para conversar" do WhatsApp (wa.me). O numero vai no formato internacional, so digitos;
 * sem numero, o WhatsApp abre a lista de contatos. A mensagem e enviada pela pessoa, no aparelho dela.
 */
export function waLink(phone: string | null | undefined, text: string) {
  let digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  const number = digits.length >= 12 ? digits : '';
  return `https://wa.me/${number}${number ? '/' : ''}?text=${encodeURIComponent(text)}`;
}

export const tierText = (tiers: { minPacks: number; priceCents: number }[]) => tiers.map((t) => `${t.minPacks}+ ${money(t.priceCents)}`).join(' · ');

export const phoneText = (p: string | null | undefined) => {
  const d = (p ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return p ?? '';
};
