// SGLog Fase 9a: telas de ocorrencias e devolucoes (Logistica → Ocorrencias, Logistica → Devolucoes e o painel do
// pedido). Somente leitura no banco de demonstracao: os formularios sao abertos e fechados sem enviar. As regras
// (estoque so na conferencia, limites por item, concorrencia, custo historico, quarentena, estorno, prazos so
// informativos, rastreio idempotente) ficam na suite da API (apps/api/test/sglog-fase9.test.ts).
import { expect, test, type Page } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

const api = async (page: Page, url: string) => {
  const r = await page.request.get(`/api/v1${url}`);
  expect(r.ok(), `GET ${url}: ${r.status()}`).toBe(true);
  return r.json();
};

test.describe('ocorrências e devoluções (Fase 9a)', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('Logística → Ocorrências: filtros sem erro', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/ocorrencias');
    await expect(page.getByRole('heading', { name: 'Ocorrências', level: 1 })).toBeVisible();
    await expect(page.getByTestId('occurrence-counts')).toContainText('em aberto');
    for (const st of ['Resolvidas', 'Canceladas', 'Todas', 'Em aberto']) {
      await page.getByLabel('Situação').selectOption({ label: st });
      await expect(page.getByTestId('occurrence-list').or(page.getByText('Nenhuma ocorrência'))).toBeVisible();
    }
    await page.getByLabel('Tipo').selectOption({ label: 'Avaria' });
    await expect(page.getByTestId('occurrence-list').or(page.getByText('Nenhuma ocorrência'))).toBeVisible();
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('ocorrencias.png'), fullPage: true });
    await expect(page.locator('a[href="/painel/logistica/ocorrencias"]').first()).toBeAttached();
    expect(erros).toEqual([]);
  });

  test('Logística → Devoluções: lista, quarentena e política (prazos só informam)', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/devolucoes');
    await expect(page.getByRole('heading', { name: 'Devoluções', level: 1 })).toBeVisible();
    await expect(page.getByTestId('return-counts')).toContainText('para conferir');
    for (const st of ['Recebidas (conferir)', 'Encerradas', 'Todas', 'Em aberto']) {
      await page.getByLabel('Situação').selectOption({ label: st });
      await expect(page.getByTestId('return-list').or(page.getByText('Nenhuma devolução'))).toBeVisible();
    }
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('devolucoes.png'), fullPage: true });
    await page.getByRole('tab', { name: /Quarentena/ }).click();
    await expect(page.getByTestId('quarantine-list').or(page.getByText('Nada em quarentena'))).toBeVisible();
    await page.getByRole('tab', { name: 'Política' }).click();
    await expect(page.getByTestId('return-policy')).toBeVisible();
    await expect(page.getByText('nenhum pedido é recusado por prazo')).toBeVisible();
    await expect(page.getByLabel('Arrependimento (dias)')).toHaveValue(/\d*/);
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('devolucoes-politica.png'), fullPage: true });
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('pedido entregue: painel de ocorrências e devoluções, formulário com limites (sem enviar)', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    const list = await api(page, '/admin/orders?status=delivered&pageSize=5');
    const order = (list.items ?? list.orders ?? [])[0] as { id: string } | undefined;
    test.skip(!order, 'nenhum pedido entregue no banco local');
    await page.goto(`/painel/pedidos/${order!.id}`);
    const panel = page.getByTestId('order-returns');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ocorrências e devoluções' })).toBeVisible();
    await page.getByTestId('open-return-form').click();
    const form = page.getByTestId('return-form');
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Autorizar devolução' })).toBeDisabled();
    await expect(form.locator('thead')).toContainText('Entregue');
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('pedido-devolucao.png'), fullPage: true });
    await form.getByRole('button', { name: 'Voltar' }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole('button', { name: 'Abrir ocorrência' }).click();
    await expect(page.getByTestId('occurrence-form')).toBeVisible();
    await expect(page.getByTestId('occurrence-form').getByRole('button', { name: 'Abrir ocorrência' })).toBeDisabled();
    await page.getByTestId('occurrence-form').getByRole('button', { name: 'Voltar' }).click();
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('9b: reembolsos, relatório, devoluções ao fornecedor e o painel de reembolso do pedido (sem enviar)', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/devolucoes');
    await page.getByRole('tab', { name: 'Reembolsos' }).click();
    await expect(page.getByTestId('refund-queue').or(page.getByText('Nenhum reembolso'))).toBeVisible();
    await page.getByRole('tab', { name: 'Relatório' }).click();
    await expect(page.getByTestId('returns-report')).toContainText('pendência fiscal');
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('devolucoes-relatorio.png'), fullPage: true });

    await page.goto('/painel/logistica/devolucoes-fornecedor');
    await expect(page.getByRole('heading', { name: 'Devoluções ao fornecedor', level: 1 })).toBeVisible();
    await expect(page.getByTestId('supplier-return-list').or(page.getByText('Nenhuma devolução ao fornecedor'))).toBeVisible();
    await page.getByRole('button', { name: 'Nova devolução' }).click();
    await expect(page.getByTestId('supplier-return-form')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Criar rascunho' })).toBeDisabled();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('devolucoes-fornecedor.png'), fullPage: true });

    const list = await api(page, '/admin/orders?status=delivered&pageSize=5');
    const order = (list.items ?? list.orders ?? [])[0] as { id: string } | undefined;
    if (order) {
      await page.goto(`/painel/pedidos/${order.id}`);
      await expect(page.getByTestId('refunds-panel')).toContainText('Ainda elegível');
      await page.getByTestId('open-refund-form').click();
      await expect(page.getByTestId('refund-form').getByRole('button', { name: 'Registrar' })).toBeDisabled();
      await semRolagemLateral(page);
      await page.screenshot({ path: info.outputPath('pedido-reembolso.png'), fullPage: true });
    }
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });
});
