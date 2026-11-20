// SGLog Fase 5: testes de navegador (Playwright, dependencia de desenvolvimento).
// So rodam contra a loja local (localhost) com PAYMENT_FAKE: nenhum pagamento real.
// Ver tests/e2e/README.md.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3010';
const host = new URL(baseURL).hostname;
if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !host.endsWith('.localhost') && !host.endsWith('.test')) {
  throw new Error(`E2E_BASE_URL precisa ser local (localhost, 127.0.0.1, *.localhost ou *.test); recebido: ${host}`);
}

export default defineConfig({
  testDir: '.',
  outputDir: './.resultados/artefatos',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './.resultados/relatorio', open: 'never' }]],
  use: {
    baseURL,
    // Usa o Chrome (ou o Edge) ja instalado: o projeto nao baixa navegador.
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL ?? 'chrome' } },
    { name: 'celular-375', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
});
