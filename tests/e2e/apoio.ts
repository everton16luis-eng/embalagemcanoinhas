import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Credenciais do usuario local de teste (nunca a do servidor): E2E_EMAIL e E2E_PASSWORD no ambiente. */
export const painelCreds = () => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  return email && password ? { email, password } : null;
};

/** Entra no painel pela API (o cookie de sessao fica no contexto da pagina). */
export async function entrarNoPainel(request: APIRequestContext) {
  const creds = painelCreds();
  if (!creds) throw new Error('Defina E2E_EMAIL e E2E_PASSWORD (usuario local de teste).');
  const r = await request.post('/api/v1/auth/login', { data: creds });
  expect(r.status(), 'login do painel local').toBe(200);
}

/** A pagina nao pode rolar para o lado (requisito de 375 px). */
export async function semRolagemLateral(page: Page) {
  const { w, sw } = await page.evaluate(() => ({ w: window.innerWidth, sw: document.documentElement.scrollWidth }));
  expect(sw, `largura do conteudo (${sw}) cabe na tela (${w})`).toBeLessThanOrEqual(w + 1);
}

/** CPF sintetico valido (digitos verificadores corretos), so para o formulario da loja local. */
export function cpfDeTeste() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (d.every((x) => x === d[0])) d[0] = (d[0]! + 1) % 10;
  const dv = (arr: number[]) => {
    const s = arr.reduce((acc, x, i) => acc + x * (arr.length + 1 - i), 0);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  d.push(dv(d));
  d.push(dv(d));
  return d.join('');
}

/** Junta os erros do console para conferir no fim do teste. */
export function errosDoConsole(page: Page) {
  const erros: string[] = [];
  page.on('pageerror', (e) => erros.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text());
  });
  return erros;
}
