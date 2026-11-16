import { describe, expect, it } from 'vitest';
import { chooseSupplier, packsFor, type ChoiceRequest, type SupplierOfferInput } from '../src/lib/supplier-choice.js';

// Funcao pura: sem banco. `now` fixo para os testes nao dependerem do relogio.
const NOW = new Date('2026-11-16T12:00:00Z');
const SETTINGS = { tieTolerancePct: 3, staleQuoteDays: 90 };
const req = (over: Partial<ChoiceRequest> = {}): ChoiceRequest => ({ need: 1000, context: 'purchase', now: NOW, ...over });

let seq = 0;
const offer = (over: Partial<SupplierOfferInput> = {}): SupplierOfferInput => {
  seq++;
  return {
    offerId: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    supplierId: `s-${seq}`,
    supplierName: `Fornecedor ${seq}`,
    supplierStatus: 'active',
    supplierBlockedReason: null,
    supplierArchived: false,
    offerStatus: 'active',
    packagingLabel: 'Caixa com 100',
    packagingActive: true,
    variantActive: true,
    costCents: 1000,
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
    ...over,
  };
};

describe('packsFor', () => {
  it.each([
    [1000, 100, null, null, 10],
    [1001, 100, null, null, 11],
    [50, 100, null, null, 1],
    [300, 100, 5, null, 5],
    [700, 100, 5, null, 7],
    [700, 100, null, 4, 8],
    [300, 100, 5, 4, 8],
    [1, 0.5, null, null, 2],
    [10, 3, 1.5, 1.5, 4.5],
  ])('necessidade %s, embalagem %s, minimo %s, multiplo %s -> %s', (need, base, min, mult, expected) => {
    expect(packsFor(need, base, min, mult)).toBe(expected);
  });
});

describe('chooseSupplier', () => {
  it('mais barato vence e explica', () => {
    const a = offer({ supplierName: 'Caro', costCents: 1200 });
    const b = offer({ supplierName: 'Barato', costCents: 1000 });
    const r = chooseSupplier([a, b], req(), SETTINGS);
    expect(r.recommended!.supplierName).toBe('Barato');
    expect(r.recommended!.totalCents).toBe(10_000);
    expect(r.recommended!.reasons[0]).toMatch(/menor custo total/);
    expect(r.options[1]!.reasons[0]).toMatch(/fora do empate técnico/);
  });

  it('empate dentro de 3 %: o principal vence; acima de 3 % o mais barato vence', () => {
    const cheap = offer({ supplierName: 'Barato', costCents: 1000 });
    const primary = offer({ supplierName: 'Principal', costCents: 1030, isPrimary: true });
    let r = chooseSupplier([cheap, primary], req(), SETTINGS);
    expect(r.recommended!.supplierName).toBe('Principal');
    expect(r.recommended!.reasons[0]).toMatch(/empate técnico.*principal/);
    expect(r.options[1]!.reasons[0]).toMatch(/Principal é o fornecedor principal/);

    const primary2 = offer({ supplierName: 'Principal', costCents: 1031, isPrimary: true });
    r = chooseSupplier([cheap, primary2], req(), SETTINGS);
    expect(r.recommended!.supplierName).toBe('Barato');
  });

  it('tolerancia configuravel: 0 % desliga o empate; 10 % amplia', () => {
    const cheap = offer({ costCents: 1000 });
    const primary = offer({ costCents: 1050, isPrimary: true });
    expect(chooseSupplier([cheap, primary], req(), { ...SETTINGS, tieTolerancePct: 0 }).recommended!.offerId).toBe(cheap.offerId);
    expect(chooseSupplier([cheap, primary], req(), { ...SETTINGS, tieTolerancePct: 10 }).recommended!.offerId).toBe(primary.offerId);
  });

  it('empate sem principal: menor prazo; depois disponibilidade mais recente; depois menor excedente', () => {
    const slow = offer({ costCents: 1000, leadDays: 9 });
    const fast = offer({ costCents: 1010, leadDays: 3 });
    expect(chooseSupplier([slow, fast], req(), SETTINGS).recommended!.offerId).toBe(fast.offerId);

    const old = offer({ costCents: 1000, availableQty: 5000, availabilityConfirmedAt: '2026-11-10T10:00:00Z', availabilityValidUntil: '2026-11-30T00:00:00Z' });
    const recent = offer({ costCents: 1000, availableQty: 5000, availabilityConfirmedAt: '2026-11-15T10:00:00Z', availabilityValidUntil: '2026-11-30T00:00:00Z' });
    expect(chooseSupplier([old, recent], req(), SETTINGS).recommended!.offerId).toBe(recent.offerId);
  });

  it('minimo maior que a necessidade gera excedente e pode perder', () => {
    const bigMin = offer({ supplierName: 'Mínimo alto', costCents: 900, minOrderPacks: 20 });
    const normal = offer({ supplierName: 'Normal', costCents: 1000 });
    const r = chooseSupplier([bigMin, normal], req({ need: 1000 }), SETTINGS);
    expect(r.recommended!.supplierName).toBe('Normal');
    const m = r.options.find((o) => o.supplierName === 'Mínimo alto')!;
    expect(m.packs).toBe(20);
    expect(m.surplus).toBe(1000);
    expect(m.warnings.join()).toMatch(/quantidade mínima/);
  });

  it('multiplo de compra arredonda para cima', () => {
    const r = chooseSupplier([offer({ orderMultiplePacks: 6 })], req({ need: 1000 }), SETTINGS);
    expect(r.recommended!.packs).toBe(12);
    expect(r.recommended!.warnings.join()).toMatch(/múltiplos de 6/);
  });

  it('frete e despesas entram no total; desconhecidos nunca valem zero', () => {
    const withFreight = offer({ supplierName: 'Com frete', costCents: 900, orderFreightCents: 2000 });
    const unknown = offer({ supplierName: 'Frete desconhecido', costCents: 500, orderFreightCents: null });
    const plain = offer({ supplierName: 'Sem frete', costCents: 1000 });
    const r = chooseSupplier([withFreight, unknown, plain], req(), SETTINGS);
    // Com frete: 9.000 + 2.000 = 11.000 > 10.000. O desconhecido, apesar de mais barato, vem depois dos completos.
    expect(r.options.map((o) => o.supplierName)).toEqual(['Sem frete', 'Com frete', 'Frete desconhecido']);
    const u = r.options[2]!;
    expect(u.costComplete).toBe(false);
    expect(u.reasons[0]).toMatch(/custo total incompleto/);
    expect(r.options[1]!.totalCents).toBe(11_000);
  });

  it('todos com custo incompleto: compara o custo conhecido e avisa', () => {
    const a = offer({ costCents: 1000, orderFreightCents: null });
    const b = offer({ costCents: 800, orderExtraCents: null });
    const r = chooseSupplier([a, b], req(), SETTINGS);
    expect(r.recommended!.offerId).toBe(b.offerId);
    expect(r.recommended!.costComplete).toBe(false);
    expect(r.summary).toMatch(/não informados/);
  });

  it('custo desconhecido, bloqueado, inativo, arquivado, pausado, encerrado e catalogo inativo sao excluidos com motivo', () => {
    const offers = [
      offer({ costCents: null }),
      offer({ supplierStatus: 'blocked', supplierBlockedReason: 'atraso recorrente' }),
      offer({ supplierStatus: 'inactive' }),
      offer({ supplierStatus: 'inactive', supplierArchived: true }),
      offer({ offerStatus: 'paused' }),
      offer({ offerStatus: 'ended' }),
      offer({ packagingActive: false }),
      offer({ variantActive: false }),
    ];
    const r = chooseSupplier(offers, req(), SETTINGS);
    expect(r.recommended).toBeNull();
    expect(r.excluded.map((e) => e.reasons[0])).toEqual([
      'custo desconhecido',
      'fornecedor bloqueado: atraso recorrente',
      'fornecedor inativo',
      'fornecedor arquivado',
      'oferta pausada',
      'oferta encerrada',
      'embalagem de compra desativada no catálogo',
      'variante desativada no catálogo',
    ]);
    expect(r.summary).toMatch(/Nenhum fornecedor apto/);
  });

  it('sem ofertas', () => {
    const r = chooseSupplier([], req(), SETTINGS);
    expect(r.recommended).toBeNull();
    expect(r.summary).toMatch(/Nenhum fornecedor cadastrado/);
  });

  it('prazo-limite: quem nao atende ou tem prazo desconhecido vai para o fim, sem ser excluido', () => {
    const late = offer({ supplierName: 'Atrasa', costCents: 500, leadDays: 20 });
    const unknown = offer({ supplierName: 'Sem prazo', costCents: 600, leadDays: null });
    const ok = offer({ supplierName: 'No prazo', costCents: 1000, leadDays: 4 });
    const r = chooseSupplier([late, unknown, ok], req({ maxLeadDays: 7 }), SETTINGS);
    expect(r.recommended!.supplierName).toBe('No prazo');
    expect(r.excluded).toHaveLength(0);
    expect(r.options.find((o) => o.supplierName === 'Atrasa')!.reasons[0]).toMatch(/acima do prazo-limite/);
    expect(r.options.find((o) => o.supplierName === 'Sem prazo')!.reasons[0]).toMatch(/prazo desconhecido/);
    // Ninguem atende: escolhe mesmo assim e avisa.
    const none = chooseSupplier([late], req({ maxLeadDays: 7 }), SETTINGS);
    expect(none.recommended!.reasons.join()).toMatch(/nenhuma opção apta garante o prazo-limite/);
  });

  it('disponibilidade: vencida em compra nao exclui e vale como sem informacao, nunca como zero', () => {
    const expired = offer({ costCents: 900, availableQty: 0, availabilityConfirmedAt: '2026-11-01T00:00:00Z', availabilityValidUntil: '2026-11-05T00:00:00Z' });
    const r = chooseSupplier([expired, offer({ costCents: 1000 })], req(), SETTINGS);
    expect(r.recommended!.offerId).toBe(expired.offerId);
    expect(r.recommended!.availability).toBe('expired');
    expect(r.recommended!.warnings.join()).toMatch(/vencida/);
  });

  it('disponibilidade vigente abaixo da necessidade vai para depois em compra', () => {
    const short = offer({ supplierName: 'Pouco', costCents: 900, availableQty: 300, availabilityConfirmedAt: '2026-11-15T00:00:00Z', availabilityValidUntil: '2026-11-20T00:00:00Z' });
    const r = chooseSupplier([short, offer({ supplierName: 'Sem info', costCents: 1000 })], req(), SETTINGS);
    expect(r.recommended!.supplierName).toBe('Sem info');
    expect(r.options[1]!.reasons[0]).toMatch(/disponibilidade informada abaixo/);
  });

  it('fulfillment (Fase 4): exige dropshipping liberado, permitido e disponibilidade vigente suficiente', () => {
    const good = offer({ dropshipEnabled: true, dropshipAllowed: true, availableQty: 5000, availabilityConfirmedAt: '2026-11-15T00:00:00Z', availabilityValidUntil: '2026-11-20T00:00:00Z' });
    const expired = offer({ dropshipEnabled: true, dropshipAllowed: true, availableQty: 5000, availabilityConfirmedAt: '2026-11-01T00:00:00Z', availabilityValidUntil: '2026-11-02T00:00:00Z' });
    const noDrop = offer({ availableQty: 5000, availabilityConfirmedAt: '2026-11-15T00:00:00Z', availabilityValidUntil: '2026-11-20T00:00:00Z' });
    // Na Fase 2 o dropshipping nao esta liberado: tudo excluido.
    const blocked = chooseSupplier([good], req({ context: 'fulfillment' }), SETTINGS);
    expect(blocked.recommended).toBeNull();
    expect(blocked.excluded[0]!.reasons.join()).toMatch(/dropshipping bloqueado/);
    const r = chooseSupplier([good, expired, noDrop], req({ context: 'fulfillment', dropshipReleased: true }), SETTINGS);
    expect(r.recommended!.offerId).toBe(good.offerId);
    expect(r.excluded.find((e) => e.offerId === expired.offerId)!.reasons).toContain('disponibilidade do fornecedor vencida');
    expect(r.excluded.find((e) => e.offerId === noDrop.offerId)!.reasons).toContain('fornecedor ou item sem dropshipping');
  });

  it('avisos: cotacao antiga e pedido minimo em valor', () => {
    const r = chooseSupplier([offer({ quotedAt: '2026-07-01', minOrderCents: 50_000 })], req(), SETTINGS);
    const w = r.recommended!.warnings.join(' | ');
    expect(w).toMatch(/cotação de 138 dias/);
    expect(w).toMatch(/abaixo do pedido mínimo/);
  });

  it('deterministica: mesma saida para qualquer ordem de entrada, inclusive empate completo', () => {
    const list = [offer({ costCents: 1000 }), offer({ costCents: 1000 }), offer({ costCents: 1020, leadDays: 2 }), offer({ costCents: 1200, isPrimary: true }), offer({ costCents: null })];
    const base = JSON.stringify(chooseSupplier(list, req(), SETTINGS));
    for (let i = 0; i < 20; i++) {
      const shuffled = [...list].sort(() => (((i * 7919) % 13) / 13 > 0.5 ? 1 : -1)).reverse();
      expect(JSON.stringify(chooseSupplier(shuffled, req(), SETTINGS))).toBe(base);
    }
    const tie = chooseSupplier([list[1]!, list[0]!], req(), SETTINGS);
    expect(tie.recommended!.offerId).toBe(list[0]!.offerId);
    expect(tie.options[1]!.reasons[0]).toMatch(/desempate fixo/);
  });

  it('necessidade invalida e recusada', () => {
    expect(() => chooseSupplier([offer()], req({ need: 0 }), SETTINGS)).toThrow(RangeError);
  });
});
