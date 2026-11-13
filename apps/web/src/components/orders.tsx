type Tone = 'neutral' | 'act' | 'warn' | 'good' | 'bad';

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: 'Aguardando pagamento', tone: 'warn' },
  paid: { label: 'Pago', tone: 'act' },
  preparing: { label: 'Em separação', tone: 'act' },
  ready: { label: 'Pronto', tone: 'good' },
  shipped: { label: 'Despachado', tone: 'good' },
  delivered: { label: 'Entregue', tone: 'neutral' },
  canceled: { label: 'Cancelado', tone: 'bad' },
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  created: { label: 'Iniciado', tone: 'neutral' },
  pending: { label: 'Pendente', tone: 'warn' },
  approved: { label: 'Aprovado', tone: 'good' },
  rejected: { label: 'Recusado', tone: 'bad' },
  canceled: { label: 'Cancelado', tone: 'neutral' },
  refunded: { label: 'Devolvido', tone: 'neutral' },
  charged_back: { label: 'Contestado', tone: 'bad' },
  error: { label: 'Erro', tone: 'bad' },
};

export const INVOICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'NF-e pendente', tone: 'warn' },
  processing: { label: 'NF-e em processamento', tone: 'warn' },
  authorized: { label: 'NF-e autorizada', tone: 'good' },
  rejected: { label: 'NF-e rejeitada', tone: 'bad' },
  canceled: { label: 'NF-e cancelada', tone: 'bad' },
  not_required: { label: 'Sem NF-e', tone: 'neutral' },
};

export const METHOD_LABEL: Record<string, string> = { pix: 'Pix', card: 'Cartão' };
