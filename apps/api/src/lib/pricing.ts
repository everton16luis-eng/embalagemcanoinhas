import type { Db } from '../db/pool.js';

export type Tier = { minPacks: number; priceCents: number };

/** Preco de cada embalagem para a quantidade: a maior faixa alcancada, ou o preco cheio. */
export function unitPrice(listCents: number, tiers: Tier[], packs: number) {
  let price = listCents;
  for (const t of [...tiers].sort((a, b) => a.minPacks - b.minPacks)) if (packs >= t.minPacks) price = t.priceCents;
  return price;
}

/** Proxima faixa ainda nao alcancada, para mostrar "leve mais N e pague X". */
export function nextTier(tiers: Tier[], packs: number) {
  return [...tiers].sort((a, b) => a.minPacks - b.minPacks).find((t) => t.minPacks > packs) ?? null;
}

export type CartLine = {
  packagingId: string;
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  sku: string;
  attributes: Record<string, string>;
  label: string;
  baseQty: string;
  baseUnit: string;
  packs: number;
  listPriceCents: number;
  unitPriceCents: number;
  totalCents: number;
  tiers: Tier[];
  nextTier: Tier | null;
  imageKey: string | null;
  weightG: number | null;
  madeToOrder: boolean;
  leadTimeDays: number | null;
  /** ok | insufficient (estoque menor que o pedido) | unavailable (produto retirado da loja) */
  status: 'ok' | 'insufficient' | 'unavailable';
  available: string;
};

type Row = {
  packaging_id: string;
  packs: number;
  variant_id: string;
  product_id: string;
  product_name: string;
  slug: string;
  sku: string;
  attributes: Record<string, string>;
  label: string;
  base_qty: string;
  base_unit: string;
  price_cents: string | null;
  tiers: Tier[];
  image_key: string | null;
  weight_g: number | null;
  availability_mode: string;
  lead_time_days: number | null;
  sellable: boolean;
  available: string;
  enough: boolean;
};

/** Itens do carrinho com preco e disponibilidade do momento. O banco e a unica fonte de preco. */
export async function priceLines(db: Db | { query: Db['query'] }, items: { packagingId: string; packs: number }[]): Promise<CartLine[]> {
  if (!items.length) return [];
  const { rows } = await db.query<Row>(
    `SELECT i.packaging_id, i.packs, v.id AS variant_id, p.id AS product_id, p.name AS product_name, p.slug, v.sku, v.attributes, k.label, k.base_qty,
            p.base_unit, k.price_cents, p.availability_mode, p.lead_time_days, v.weight_g,
            coalesce((SELECT json_agg(json_build_object('minPacks', t.min_packs, 'priceCents', t.price_cents) ORDER BY t.min_packs) FROM price_tiers t WHERE t.packaging_id = k.id), '[]') AS tiers,
            (SELECT im.file_key FROM product_images im WHERE im.product_id = p.id ORDER BY im.is_primary DESC, im.position LIMIT 1) AS image_key,
            (k.active AND v.active AND p.status = 'active' AND k.kind = 'sale') AS sellable,
            (coalesce(b.on_hand, 0) - coalesce(b.reserved, 0))::numeric(14,3)::text AS available,
            coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) >= k.base_qty * i.packs AS enough
     FROM jsonb_to_recordset($1::jsonb) AS i(packaging_id uuid, packs integer)
     JOIN packagings k ON k.id = i.packaging_id JOIN product_variants v ON v.id = k.variant_id JOIN products p ON p.id = v.product_id
     LEFT JOIN stock_balances b ON b.variant_id = v.id`,
    [JSON.stringify(items.map((i) => ({ packaging_id: i.packagingId, packs: i.packs })))],
  );
  const byId = new Map(rows.map((r) => [r.packaging_id, r]));
  return items.flatMap((i) => {
    const r = byId.get(i.packagingId);
    if (!r) return [];
    const tiers = r.tiers.map((t) => ({ minPacks: Number(t.minPacks), priceCents: Number(t.priceCents) }));
    const list = Number(r.price_cents ?? 0);
    const unit = unitPrice(list, tiers, r.packs);
    const madeToOrder = r.availability_mode === 'made_to_order';
    return [
      {
        packagingId: r.packaging_id,
        variantId: r.variant_id,
        productId: r.product_id,
        productName: r.product_name,
        productSlug: r.slug,
        sku: r.sku,
        attributes: r.attributes,
        label: r.label,
        baseQty: r.base_qty,
        baseUnit: r.base_unit,
        packs: r.packs,
        listPriceCents: list,
        unitPriceCents: unit,
        totalCents: unit * r.packs,
        tiers,
        nextTier: nextTier(tiers, r.packs),
        imageKey: r.image_key,
        weightG: r.weight_g,
        madeToOrder,
        leadTimeDays: r.lead_time_days,
        status: !r.sellable || !list ? 'unavailable' : r.enough || madeToOrder ? 'ok' : 'insufficient',
        available: r.available,
      } satisfies CartLine,
    ];
  });
}

/** Peso total em gramas. Item sem peso cadastrado impede calcular frete por peso. */
export function cartWeight(lines: CartLine[]) {
  let grams = 0;
  const missing: string[] = [];
  for (const l of lines) {
    if (!l.weightG) missing.push(l.sku);
    else grams += Math.ceil(l.weightG * Number(l.baseQty) * l.packs);
  }
  return { grams, missing };
}
