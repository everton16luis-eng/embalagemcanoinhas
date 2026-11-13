type Tone = 'neutral' | 'act' | 'warn' | 'good' | 'bad';

export const DOC_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Enviando', tone: 'warn' },
  processing: { label: 'Em processamento', tone: 'warn' },
  authorized: { label: 'Autorizada', tone: 'good' },
  rejected: { label: 'Rejeitada', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
};

export const EVENT_LABEL: Record<string, string> = {
  created: 'Criada',
  submitted: 'Enviada ao provedor',
  status: 'Situação consultada',
  submit_failed: 'Falha de comunicação',
  cancel: 'Cancelamento',
  cancel_failed: 'Cancelamento recusado',
  correction: 'Carta de correção',
  correction_failed: 'Carta de correção recusada',
  webhook: 'Aviso do provedor',
  file: 'Arquivo guardado',
};

export const FILE_LABEL: Record<string, string> = {
  nfe_xml: 'XML da NF-e',
  danfe_pdf: 'DANFE (PDF)',
  cancel_xml: 'XML do cancelamento',
  cce_xml: 'XML da carta de correção',
  cce_pdf: 'Carta de correção (PDF)',
  inut_xml: 'XML da inutilização',
};

export const DESTINATION: Record<string, string> = { internal: 'Dentro do estado', interstate: 'Para outro estado' };
export const BUYER_KIND: Record<string, string> = { pf: 'Pessoa física', pj_contribuinte: 'Empresa contribuinte de ICMS', pj_nao_contribuinte: 'Empresa não contribuinte' };
export const PRESENCE: Record<number, string> = {
  0: '0 · Não se aplica',
  1: '1 · Presencial',
  2: '2 · Não presencial, internet',
  3: '3 · Não presencial, teleatendimento',
  4: '4 · Entrega em domicílio (NFC-e)',
  5: '5 · Presencial fora do estabelecimento',
  9: '9 · Não presencial, outros',
};

export const CERT_ALERT: Record<string, { label: (d: number) => string; tone: Tone }> = {
  ok: { label: (d) => `Válido · ${d} dias`, tone: 'good' },
  d30: { label: (d) => `Vence em ${d} dias`, tone: 'warn' },
  d15: { label: (d) => `Vence em ${d} dias`, tone: 'warn' },
  d7: { label: (d) => (d === 0 ? 'Vence hoje' : `Vence em ${d} dias`), tone: 'bad' },
  expired: { label: () => 'Vencido', tone: 'bad' },
};

/** Chave de acesso em grupos de 4, como no DANFE. */
export const accessKey = (k: string | null) => (k ? k.replace(/(\d{4})(?=\d)/g, '$1 ') : '—');
