import { describe, expect, it } from 'vitest';
import { MercadoPagoProvider } from '../src/lib/payments.js';

describe('final de cartão retornado pelo Mercado Pago', () => {
  it.each([
    { value: '***2', expected: null },
    { value: '5682', expected: '5682' },
    { value: '0002', expected: '0002' },
    { value: '', expected: null },
    { value: '12345', expected: null },
    { value: null, expected: null },
    { value: undefined, expected: null },
    { value: 5682, expected: null },
  ])('normaliza $value na criação e na reconsulta', async ({ value, expected }) => {
    const fetcher: typeof fetch = async () => Response.json({
      id: 123456789,
      status: 'rejected',
      status_detail: 'cc_rejected_other_reason',
      transaction_amount: 1.9,
      external_reference: 'pedido-de-teste',
      payment_method_id: 'visa',
      installments: 1,
      card: { last_four_digits: value },
    });
    const provider = new MercadoPagoProvider('token-simulado', 'chave-simulada', null, null, fetcher);
    const created = await provider.createCard({
      idempotencyKey: 'tentativa-simulada',
      amountCents: 190,
      description: 'Pedido de teste',
      externalReference: 'pedido-de-teste',
      card: { token: 'cartao-tokenizado', paymentMethodId: 'visa', issuerId: null, installments: 1, payerEmail: 'teste@example.com', payerDocType: null, payerDocNumber: null },
    });
    const fetched = await provider.getPayment('123456789');
    for (const payment of [created, fetched]) {
      expect(payment).toMatchObject({
        status: 'rejected',
        statusDetail: 'cc_rejected_other_reason',
        amountCents: 190,
        card: { lastFour: expected, brand: 'visa', installments: 1 },
      });
    }
  });
});
