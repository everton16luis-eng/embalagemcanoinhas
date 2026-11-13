// Validacoes de documentos e codigos brasileiros. So conferem formato e digito verificador:
// nao confirmam que o documento existe nem que pertence a empresa.

export const onlyDigits = (v: string) => v.replace(/\D/g, '');

/**
 * CNPJ numerico ou alfanumerico (IN RFB 2.229/2024, em vigor desde julho de 2026).
 * 12 posicoes [0-9A-Z] + 2 digitos verificadores. Cada caractere vale (codigo ASCII - 48),
 * e o calculo do modulo 11 e o mesmo do CNPJ numerico.
 */
export function normalizeCnpj(v: string) {
  return v.toUpperCase().replace(/[.\-/\s]/g, '');
}

export function isValidCnpj(raw: string) {
  const v = normalizeCnpj(raw);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(v)) return false;
  if (/^(\d)\1{13}$/.test(v)) return false;
  const values = [...v].map((c) => c.charCodeAt(0) - 48);
  const dv = (len: number) => {
    let sum = 0;
    let weight = 2;
    for (let i = len - 1; i >= 0; i--) {
      sum += values[i]! * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === values[12] && dv(13) === values[13];
}

export function isValidCpf(raw: string) {
  const v = onlyDigits(raw);
  if (v.length !== 11 || /^(\d)\1{10}$/.test(v)) return false;
  const dv = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(v[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(v[9]) && dv(10) === Number(v[10]);
}

/** GTIN-8, 12, 13 ou 14 (codigo de barras), com digito verificador. */
export function isValidGtin(raw: string) {
  const v = onlyDigits(raw);
  if (![8, 12, 13, 14].includes(v.length) || v !== raw) return false;
  const digits = [...v].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as const;

/** Codigo IBGE de municipio: 7 digitos, os dois primeiros sao a UF. */
const UF_IBGE: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};
export const ibgeMatchesUf = (ibge: string, uf: string) => UF_IBGE[uf] === ibge.slice(0, 2);

/** Texto para slug de URL: sem acento, minusculo, hifens. */
export function slugify(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150)
    .replace(/-+$/g, '');
}
