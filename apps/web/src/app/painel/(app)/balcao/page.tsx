'use client';

import { MessageCircle, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { tierText, waLink } from '@/components/sales';
import { Guard, useMe } from '@/components/shell';
import { newKey } from '@/components/stock';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money, parseMoney, qty } from '@/lib/format';

type Hit = {
  packaging_id: string;
  label: string;
  base_qty: string;
  price_cents: string;
  sku: string;
  name: string;
  slug: string;
  base_unit: string;
  availability_mode: string;
  lead_time_days: number | null;
  tiers: { minPacks: number; priceCents: number }[];
  available: string;
  packs_available: number;
};
type Line = Hit & { packs: string };
type ShipOption = { id: string; name: string; kind: 'pickup' | 'delivery'; active: boolean };

/** Estimativa na tela; o preco que vale e o calculado pela API ao criar o orcamento. */
const estimate = (l: Line) => {
  const n = Number(l.packs) || 0;
  let price = Number(l.price_cents);
  for (const t of l.tiers) if (n >= t.minPacks) price = t.priceCents;
  return price * n;
};

function Availability({ h }: { h: Hit }) {
  if (h.availability_mode === 'made_to_order') return <Badge tone="warn">Sob encomenda{h.lead_time_days ? ` · ${h.lead_time_days} dias` : ''}</Badge>;
  if (h.packs_available <= 0) return <Badge tone="bad">Sem saldo</Badge>;
  return (
    <Badge tone="good">
      {h.packs_available} {h.packs_available === 1 ? 'disponível' : 'disponíveis'}
    </Badge>
  );
}

function Desk() {
  const { can } = useMe();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [storeUrl, setStoreUrl] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [ships, setShips] = useState<ShipOption[]>([]);
  const [buyer, setBuyer] = useState({ kind: 'pf' as 'pf' | 'pj', name: '', phone: '', email: '', document: '' });
  const [shipId, setShipId] = useState('');
  const [addr, setAddr] = useState({ recipient: '', cep: '', street: '', number: '', complement: '', district: '', city: '', uf: 'SC' });
  const [discount, setDiscount] = useState('');
  const [validDays, setValidDays] = useState('7');
  const [notes, setNotes] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ options: ShipOption[] }>('/admin/shipping-options').then((r) => setShips(r.options.filter((o) => o.active)), () => setShips([]));
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (!term) return setHits(null);
    const t = setTimeout(() => {
      api<{ results: Hit[]; storeUrl: string }>(`/admin/sales-desk/search?q=${encodeURIComponent(term)}`).then(
        (r) => {
          setHits(r.results);
          setStoreUrl(r.storeUrl);
        },
        (e) => setError(e.message),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const add = (h: Hit) => setLines((ls) => (ls.some((l) => l.packaging_id === h.packaging_id) ? ls : [...ls, { ...h, packs: '1' }]));
  const share = (h: Hit) =>
    waLink(
      null,
      `${h.name} · ${h.label} (${qty(h.base_qty)} ${h.base_unit})\n${money(h.price_cents)}${h.tiers.length ? `\nNa quantidade: ${tierText(h.tiers)}` : ''}\n${storeUrl}/p/${h.slug}`,
    );
  const ship = ships.find((s) => s.id === shipId);
  const subtotal = lines.reduce((s, l) => s + estimate(l), 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const discountCents = discount.trim() ? parseMoney(discount) : 0;
    if (discountCents === null) {
      setBusy(false);
      return setError('Desconto inválido.');
    }
    try {
      const r = await api<{ quote: { id: string } }>('/admin/sales-desk/quotes', {
        method: 'POST',
        body: {
          requestKey: key,
          buyer: { kind: buyer.kind, name: buyer.name, phone: buyer.phone, email: buyer.email.trim() || null, document: buyer.document.trim() || null },
          items: lines.map((l) => ({ packagingId: l.packaging_id, packs: Number(l.packs) })),
          shippingOptionId: shipId || null,
          address: ship?.kind === 'delivery' ? { ...addr, complement: addr.complement || null } : null,
          discountCents,
          notes: notes.trim() || null,
          validDays: Number(validDays),
        },
      });
      router.push(`/painel/orcamentos/${r.quote.id}`);
    } catch (err) {
      setError((err as Error).message);
      setKey(newKey());
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Balcão" description="Consulte preço e disponibilidade, compartilhe pelo WhatsApp e monte o orçamento. O orçamento vira pedido sem redigitar." />
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Panel title="Busca rápida">
          <Input type="search" autoFocus aria-label="Buscar produto" placeholder="Nome, SKU ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits && hits.length === 0 && <p className="mt-3 text-sm text-ink-soft">Nada encontrado.</p>}
          {hits && hits.length > 0 && (
            <ul className="mt-3 divide-y divide-line">
              {hits.map((h) => (
                <li key={h.packaging_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium">{h.name}</p>
                    <p className="text-xs text-ink-faint">
                      {h.sku} · {h.label} ({qty(h.base_qty)} {h.base_unit})
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="num font-semibold">{money(h.price_cents)}</p>
                    {h.tiers.length > 0 && <p className="text-xs text-ink-soft">{tierText(h.tiers)}</p>}
                  </div>
                  <Availability h={h} />
                  <div className="flex gap-1">
                    <a href={share(h)} target="_blank" rel="noopener noreferrer" aria-label={`Compartilhar ${h.name}, ${h.label}, no WhatsApp`} className="inline-flex h-9 items-center rounded-[var(--radius-ctl)] px-2.5 text-ink-soft hover:bg-sunken hover:text-ink">
                      <MessageCircle className="size-4" aria-hidden />
                    </a>
                    <Button onClick={() => add(h)} disabled={lines.some((l) => l.packaging_id === h.packaging_id)} aria-label={`Adicionar ${h.name}, ${h.label}, ao orçamento`}>
                      <Plus className="size-4" aria-hidden />
                      Orçamento
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <form onSubmit={submit}>
          <Panel title="Novo orçamento" description="Preços congelados até a validade. Saldo é reservado só quando vira pedido.">
            {lines.length === 0 ? (
              <p className="text-sm text-ink-soft">Adicione itens pela busca.</p>
            ) : (
              <ul className="divide-y divide-line">
                {lines.map((l, i) => (
                  <li key={l.packaging_id} className="flex items-center gap-2 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{l.name}</p>
                      <p className="text-xs text-ink-faint">{l.label}</p>
                    </div>
                    <Input
                      aria-label={`Quantidade de ${l.name}`}
                      inputMode="numeric"
                      className="w-16 text-right"
                      value={l.packs}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, packs: e.target.value.replace(/\D/g, '') } : x)))}
                    />
                    <span className="num w-24 text-right">{money(estimate(l))}</span>
                    <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remover ${l.name}`} className="p-1 text-ink-faint hover:text-bad">
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
                <li className="flex justify-between pt-2 text-sm font-semibold">
                  <span>Itens (estimativa)</span>
                  <span className="num">{money(subtotal)}</span>
                </li>
              </ul>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Tipo" className="sm:col-span-2">
                {(id) => (
                  <Select id={id} value={buyer.kind} onChange={(e) => setBuyer({ ...buyer, kind: e.target.value as 'pf' | 'pj' })}>
                    <option value="pf">Pessoa física</option>
                    <option value="pj">Empresa</option>
                  </Select>
                )}
              </Field>
              <Field label={buyer.kind === 'pf' ? 'Nome do cliente' : 'Razão social'} required className="sm:col-span-2">
                {(id) => <Input id={id} required minLength={2} maxLength={150} value={buyer.name} onChange={(e) => setBuyer({ ...buyer, name: e.target.value })} />}
              </Field>
              <Field label="WhatsApp" required hint="Com DDD.">
                {(id) => <Input id={id} required inputMode="tel" value={buyer.phone} onChange={(e) => setBuyer({ ...buyer, phone: e.target.value })} />}
              </Field>
              <Field label="E-mail" hint="Opcional.">
                {(id) => <Input id={id} type="email" value={buyer.email} onChange={(e) => setBuyer({ ...buyer, email: e.target.value })} />}
              </Field>
              <Field label={buyer.kind === 'pf' ? 'CPF' : 'CNPJ'} hint="Opcional: o cliente completa ao aceitar." className="sm:col-span-2">
                {(id) => <Input id={id} value={buyer.document} onChange={(e) => setBuyer({ ...buyer, document: e.target.value })} />}
              </Field>
              <Field label="Entrega" className="sm:col-span-2">
                {(id) => (
                  <Select id={id} value={shipId} onChange={(e) => setShipId(e.target.value)}>
                    <option value="">A combinar (cliente escolhe ao aceitar)</option>
                    {ships.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {ship?.kind === 'delivery' && (
                <>
                  {(
                    [
                      ['recipient', 'Quem recebe', 'sm:col-span-2'],
                      ['cep', 'CEP', ''],
                      ['number', 'Número', ''],
                      ['street', 'Rua', 'sm:col-span-2'],
                      ['complement', 'Complemento', ''],
                      ['district', 'Bairro', ''],
                      ['city', 'Cidade', ''],
                      ['uf', 'UF', ''],
                    ] as const
                  ).map(([k, label, cls]) => (
                    <Field key={k} label={label} required={k !== 'complement'} className={cls}>
                      {(id) => <Input id={id} required={k !== 'complement'} value={addr[k]} onChange={(e) => setAddr({ ...addr, [k]: e.target.value })} />}
                    </Field>
                  ))}
                </>
              )}
              {can('prices.manage') && (
                <Field label="Desconto (R$)" hint="Sobre o total dos itens.">
                  {(id) => <Input id={id} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />}
                </Field>
              )}
              <Field label="Validade (dias)">
                {(id) => <Input id={id} type="number" min={1} max={30} value={validDays} onChange={(e) => setValidDays(e.target.value)} />}
              </Field>
              <Field label="Observação" className="sm:col-span-2">
                {(id) => <Textarea id={id} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />}
              </Field>
            </div>
            <Button type="submit" variant="primary" className="mt-4 w-full" busy={busy} disabled={!lines.length || lines.some((l) => !Number(l.packs))}>
              Criar orçamento
            </Button>
          </Panel>
        </form>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="sales_desk.use">
      <Desk />
    </Guard>
  );
}
