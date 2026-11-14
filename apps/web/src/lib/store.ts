// Leitura do catalogo publico no servidor (paginas da loja renderizadas no Next).
// O navegador continua falando so com a propria origem; aqui o Next chama a API direto.
// Usar somente em componentes de servidor.

const API = process.env.API_URL ?? 'http://127.0.0.1:4010';

export class NotFound extends Error {}

/**
 * Preco, estoque, carrinho e pedido: sempre frescos (`no-store`).
 * `revalidate` (segundos) so para dado de vitrine que muda raramente e nao decide compra: departamentos e
 * identificacao da loja. Auditoria 11/2026: eram 2 das 3 a 5 chamadas a API por pagina.
 */
export async function storeGet<T>(path: string, revalidate?: number): Promise<T> {
  const res = await fetch(`${API}/api/v1/public${path}`, revalidate ? { next: { revalidate } } : { cache: 'no-store' });
  if (res.status === 404) throw new NotFound();
  if (!res.ok) throw new Error(`Falha ao carregar ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export type Category = { id: string; parent_id: string | null; name: string; slug: string; description: string | null; position: number; product_count: number };
export type StoreInfo = {
  store: { name: string | null; tagline: string | null; logoKey: string | null; whatsapp: string | null; email: string | null; pages: string[] };
  company: { legal_name: string | null; trade_name: string | null; cnpj: string | null; street: string | null; number: string | null; district: string | null; city: string | null; uf: string | null; cep: string | null; phone: string | null; email: string | null } | null;
};
export type Card = {
  id: string;
  name: string;
  slug: string;
  summary: string | null;
  base_unit: string;
  availability_mode: 'stock' | 'made_to_order';
  lead_time_days: number | null;
  category_name: string | null;
  category_slug: string | null;
  packaging_id: string;
  packaging_label: string;
  base_qty: string;
  price_cents: string;
  unit_price_cents: string;
  sku: string;
  first_tier: { minPacks: number; priceCents: number } | null;
  variant_count: number;
  image_key: string | null;
  in_stock: boolean;
};
export type Listing = { products: Card[]; total: number; page: number; pageSize: number; category: { id: string; name: string; slug: string; description: string | null; parent_id: string | null } | null };

export const getCategories = () => storeGet<{ categories: Category[] }>('/catalog/categories', 60).then((r) => r.categories);
export const getStore = () => storeGet<StoreInfo>('/catalog/store', 60);

/** Arvore de departamentos: raiz com filhos, contando produtos dos filhos. */
export function departments(cats: Category[]) {
  const roots = cats.filter((c) => !c.parent_id);
  return roots.map((r) => {
    const children = cats.filter((c) => c.parent_id === r.id);
    return { ...r, children, total: r.product_count + children.reduce((s, c) => s + c.product_count, 0) };
  });
}
