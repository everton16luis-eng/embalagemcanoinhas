import { describe, expect, it } from 'vitest';
import { allocate, sortWarehouses, type EngineInput } from '../src/lib/allocation.js';
import type { SupplierOfferInput } from '../src/lib/supplier-choice.js';

// SGLog Fase 4: motor de distribuicao (funcao pura). Mesma entrada, mesma saida.

const P = { id: 'w-p', code: 'PRINCIPAL', name: 'Principal', isDefault: true, priority: 100 };
const G = { id: 'w-g', code: 'GALPAO', name: 'Galpão', isDefault: false, priority: 10 };
const H = { id: 'w-h', code: 'ANEXO', name: 'Anexo', isDefault: false, priority: 10 };
const item = (variantId: string, need: number, id = `i-${variantId}`) => ({ orderItemId: id, variantId, sku: variantId.toUpperCase(), name: variantId, need, madeToOrder: false });
const offer = (o: Partial<SupplierOfferInput> & { offerId: string }): SupplierOfferInput => ({
  supplierId: `s-${o.offerId}`,
  supplierName: `Fornecedor ${o.offerId}`,
  supplierStatus: 'active',
  supplierArchived: false,
  offerStatus: 'active',
  packagingLabel: 'Caixa 100',
  packagingActive: true,
  variantActive: true,
  costCents: 2000,
  baseQty: 100,
  minOrderPacks: null,
  orderMultiplePacks: null,
  leadDays: 5,
  isPrimary: false,
  orderFreightCents: 0,
  orderExtraCents: 0,
  minOrderCents: null,
  quotedAt: '2026-11-01',
  dropshipEnabled: false,
  dropshipAllowed: false,
  availableQty: null,
  availabilityConfirmedAt: null,
  availabilityValidUntil: null,
  ...o,
});
const base = (over: Partial<EngineInput> = {}): EngineInput => ({
  orderId: 'o1',
  channel: 'site',
  items: [item('a', 10)],
  warehouses: [G, P],
  stock: [],
  offers: {},
  choiceSettings: { tieTolerancePct: 3, staleQuoteDays: 90 },
  dropshipReleased: false,
  ownOnly: false,
  now: new Date('2026-11-16T12:00:00Z'),
  ...over,
});

describe('motor de distribuição', () => {
  it('ordem: padrão, prioridade, código', () => {
    expect(sortWarehouses([H, G, P]).map((w) => w.code)).toEqual(['PRINCIPAL', 'ANEXO', 'GALPAO']);
  });

  it('padrão cobre tudo: automático no padrão, mesmo com outro de prioridade menor', () => {
    const out = allocate(base({ stock: [{ warehouseId: 'w-p', variantId: 'a', free: 10 }, { warehouseId: 'w-g', variantId: 'a', free: 50 }] }));
    expect(out).toMatchObject({ automatic: true, analysisReason: null, recommended: { key: 'stock:w-p' } });
    expect(out.alternatives.map((p) => p.key)).toEqual(['stock:w-g']);
    expect(out.recommended!.reasons[1]).toBe('É o depósito padrão.');
  });

  it('padrão não cobre: o primeiro pela prioridade e depois pelo código', () => {
    const out = allocate(
      base({
        warehouses: [P, G, H],
        stock: [
          { warehouseId: 'w-p', variantId: 'a', free: 5 },
          { warehouseId: 'w-g', variantId: 'a', free: 10 },
          { warehouseId: 'w-h', variantId: 'a', free: 10 },
        ],
      }),
    );
    expect(out.recommended!.key).toBe('stock:w-h');
    expect(out.alternatives.map((p) => p.key)).toEqual(['stock:w-g']);
  });

  it('ninguém cobre e sem fornecedor: análise com motivo e sugestão de transferência; nada recomendado', () => {
    const out = allocate(base({ stock: [{ warehouseId: 'w-p', variantId: 'a', free: 4 }, { warehouseId: 'w-g', variantId: 'a', free: 3 }] }));
    expect(out.automatic).toBe(false);
    expect(out.recommended).toBeNull();
    expect(out.analysisReason).toContain('A (precisa 10, livre 4)');
    expect(out.suggestions[0]).toBe('Transferir até 3 de A do Galpão para o Principal e alocar de novo.');
    expect(out.excluded[0]!.key).toBe('purchase_to_order');
  });

  it('falta com fornecedor: parte própria no padrão e o resto por encomenda, entregue no padrão', () => {
    const out = allocate(base({ stock: [{ warehouseId: 'w-p', variantId: 'a', free: 4 }], offers: { a: [offer({ offerId: 'x1', isPrimary: true })] } }));
    expect(out.automatic).toBe(false);
    expect(out.recommended!.key).toBe('order:w-p:x1');
    expect(out.recommended!.lines.map((l) => [l.mode, l.qty, l.warehouseId])).toEqual([
      ['stock', 4, 'w-p'],
      ['purchase_to_order', 6, 'w-p'],
    ]);
    expect(out.recommended!.supplierCostCents).toBeGreaterThan(0);
  });

  it('marketplace: só estoque próprio; dropshipping só com a trava liberada', () => {
    // Dropshipping exige disponibilidade vigente informada pelo fornecedor (Fase 2).
    const offers = { a: [offer({ offerId: 'x1', dropshipAllowed: true, dropshipEnabled: true, availableQty: 100, availabilityConfirmedAt: '2026-11-15T12:00:00Z', availabilityValidUntil: '2026-11-20T12:00:00Z' })] };
    const mk = allocate(base({ ownOnly: true, offers }));
    expect(mk.recommended).toBeNull();
    expect(mk.excluded[0]!.key).toBe('supplier');
    const blocked = allocate(base({ offers }));
    expect(blocked.alternatives.some((p) => p.key.startsWith('dropship'))).toBe(false);
    expect(blocked.suggestions).toContain('Dropshipping indisponível: aguarda a validação fiscal (D3).');
    const released = allocate(base({ offers, dropshipReleased: true }));
    expect([released.recommended, ...released.alternatives].some((p) => p?.key.startsWith('dropship:'))).toBe(true);
  });

  it('dois itens da mesma variante somam a necessidade; determinístico', () => {
    const input = base({ items: [item('a', 6, 'i1'), item('a', 6, 'i2')], stock: [{ warehouseId: 'w-p', variantId: 'a', free: 10 }, { warehouseId: 'w-g', variantId: 'a', free: 12 }] });
    const out = allocate(input);
    expect(out.recommended!.key).toBe('stock:w-g');
    expect(JSON.stringify(allocate(input))).toBe(JSON.stringify(out));
  });

  it('pedido sem itens vai para análise', () => {
    expect(allocate(base({ items: [] })).analysisReason).toBe('Pedido sem itens.');
  });
});
