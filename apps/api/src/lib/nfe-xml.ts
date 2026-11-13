import { XMLParser } from 'fast-xml-parser';
import { AppError } from './errors.js';

/**
 * Leitura do XML de NF-e de compra (modelo 55, layout 4.00). So extrai os dados para conferencia;
 * nada aqui confia no arquivo para movimentar estoque. DOCTYPE/ENTITY sao recusados (sem expansao de entidades).
 */
export const MAX_XML_BYTES = 2 * 1024 * 1024;

export type PurchaseItem = {
  line: number;
  code: string;
  gtin: string | null;
  description: string;
  ncm: string | null;
  cfop: string | null;
  unit: string;
  qty: string;
  unitValue: string;
  totalCents: number;
};

export type PurchaseNfe = {
  accessKey: string;
  model: string;
  series: string;
  number: string;
  issuedAt: string;
  supplier: { document: string; name: string; stateRegistration: string | null; uf: string | null };
  recipientDocument: string | null;
  totalCents: number;
  items: PurchaseItem[];
  /** cStat do protocolo de autorizacao, quando o XML traz o protocolo (nfeProc). 100 = autorizada. */
  protocolStatus: string | null;
};

/** Digito verificador da chave de acesso (modulo 11, pesos 2 a 9 da direita para a esquerda). */
export function accessKeyValid(key: string) {
  if (!/^\d{44}$/.test(key)) return false;
  let sum = 0;
  let w = 2;
  for (let i = 42; i >= 0; i -= 1) {
    sum += Number(key[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const rest = sum % 11;
  return Number(key[43]) === (rest < 2 ? 0 : 11 - rest);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jpath) => String(jpath).endsWith('infNFe.det'),
});

const text = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') || null : String(v));
const cents = (v: unknown) => Math.round(Number(text(v) ?? '0') * 100);
const invalid = (msg: string) => new AppError(422, 'INVALID_NFE_XML', msg);

export function parsePurchaseNfe(buf: Buffer): PurchaseNfe {
  if (buf.length > MAX_XML_BYTES) throw invalid('Arquivo grande demais para um XML de NF-e.');
  const xml = buf.toString('utf8').replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('XML com DOCTYPE não é aceito.');
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml, true);
  } catch {
    throw invalid('Arquivo não é um XML válido.');
  }
  const nfe = doc.nfeProc?.NFe ?? doc.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw invalid('O arquivo não é o XML de uma NF-e (falta infNFe).');
  const key = String(inf['@Id'] ?? '').replace(/^NFe/, '');
  if (!accessKeyValid(key)) throw invalid('Chave de acesso ausente ou com dígito verificador inválido.');
  const ide = inf.ide ?? {};
  const model = text(ide.mod) ?? '';
  if (model !== '55') throw invalid(`Modelo ${model || 'desconhecido'}: só NF-e modelo 55.`);
  const emit = inf.emit ?? {};
  const supplierDoc = text(emit.CNPJ) ?? text(emit.CPF);
  if (!supplierDoc) throw invalid('Emitente sem CNPJ ou CPF.');
  const det: any[] = Array.isArray(inf.det) ? inf.det : [];
  if (!det.length || det.length > 990) throw invalid('NF-e sem itens.');
  const items = det.map((d, i) => {
    const p = d.prod ?? {};
    const ean = text(p.cEAN);
    return {
      line: Number(d['@nItem'] ?? i + 1),
      code: (text(p.cProd) ?? '').slice(0, 60),
      gtin: ean && /^(\d{8}|\d{12,14})$/.test(ean) ? ean : null,
      description: (text(p.xProd) ?? '').slice(0, 120),
      ncm: text(p.NCM),
      cfop: text(p.CFOP),
      unit: (text(p.uCom) ?? '').slice(0, 6),
      qty: text(p.qCom) ?? '0',
      unitValue: text(p.vUnCom) ?? '0',
      totalCents: cents(p.vProd),
    };
  });
  const dest = inf.dest ?? {};
  return {
    accessKey: key,
    model,
    series: text(ide.serie) ?? '',
    number: text(ide.nNF) ?? '',
    issuedAt: text(ide.dhEmi) ?? text(ide.dEmi) ?? '',
    supplier: { document: supplierDoc.toUpperCase(), name: (text(emit.xNome) ?? '').slice(0, 150), stateRegistration: text(emit.IE), uf: text(emit.enderEmit?.UF) },
    recipientDocument: text(dest.CNPJ) ?? text(dest.CPF),
    totalCents: cents(inf.total?.ICMSTot?.vNF),
    items,
    protocolStatus: text(doc.nfeProc?.protNFe?.infProt?.cStat),
  };
}
