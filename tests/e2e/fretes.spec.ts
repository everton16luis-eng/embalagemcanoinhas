// SGLog Fase 8: telas de frete (Logística → Fretes e o painel "Frete" da remessa). Somente leitura: nenhum teste
// cota, compra etiqueta, registra custo ou rastreio. As regras (trava da compra, idempotência, resposta incerta,
// avisos assinados, rastreio fora de ordem, custos e relatório) ficam na suíte da API (apps/api/test/sglog-fase8.test.ts).
import { expect, test, type Page } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

const api = async (page: Page, url: string) => {
  const r = await page.request.get(`/api/v1${url}`);
  expect(r.ok(), `GET ${url}: ${r.status()}`).toBe(true);
  return r.json();
};

test.describe('fretes (Fase 8)', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('Logística → Fretes: listas, trava da etiqueta, fila e relatório', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/fretes');
    await expect(page.getByRole('heading', { name: 'Fretes', level: 1 })).toBeVisible();
    await expect(page.getByTestId('freight-gate')).toContainText('Compra de etiqueta pelo sistema: bloqueada');
    await expect(page.getByTestId('freight-counts')).toContainText('A cotar');
    await expect(page.getByTestId('freight-counts')).toContainText('Sem custo informado');
    await expect(page.getByTestId('freight-list').or(page.getByText('Nenhuma remessa nesta lista.'))).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fila de integrações' })).toBeVisible();
    await expect(page.getByTestId('freight-report')).toContainText('Cobrado');
    // Nada nesta tela compra etiqueta.
    await expect(page.getByRole('button', { name: /Pedir etiqueta|Comprar/ })).toHaveCount(0);
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('fretes.png'), fullPage: true });

    await page.getByRole('button', { name: /Sem custo informado/ }).click();
    await expect(page.getByRole('heading', { name: 'Sem custo informado' })).toBeVisible();
    await expect(page.getByTestId('freight-list').or(page.getByText('Nenhuma remessa nesta lista.'))).toBeVisible();
    await semRolagemLateral(page);
    // O menu leva a Fretes.
    await expect(page.locator('a[href="/painel/logistica/fretes"]').first()).toBeAttached();
    expect(erros).toEqual([]);
  });

  test('remessa: cobrado, cotado e pago separados; etiqueta bloqueada; custo desconhecido não vira zero', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    let row: { id: string } | undefined;
    for (const view of ['to_quote', 'quoted', 'without_cost', 'tracking']) {
      row = (await api(page, `/admin/freight/shipments?view=${view}&pageSize=1`)).items[0];
      if (row) break;
    }
    test.skip(!row, 'nenhuma remessa de entrega embalada ou despachada no banco local');
    const f = (await api(page, `/admin/freight/shipments/${row!.id}`)).freight;
    await page.goto(`/painel/logistica/expedicao/${row!.id}`);
    await expect(page.getByTestId('freight-panel')).toBeVisible();
    const values = page.getByTestId('freight-values');
    await expect(values).toContainText('Cobrado do cliente');
    await expect(values).toContainText('Cotado');
    await expect(values).toContainText('Pago');
    if (f.costs.netCents === null) await expect(values).toContainText('não informado');
    if (!f.gate.allowed) {
      await expect(page.getByTestId('freight-labels-blocked')).toContainText('a compra pelo sistema está bloqueada');
      await expect(page.getByRole('button', { name: 'Pedir etiqueta' })).toHaveCount(0);
    }
    if (f.shipment.status === 'packed') await expect(page.getByLabel('Custo pago à transportadora (R$, opcional)')).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('remessa-frete.png'), fullPage: true });
    expect(erros).toEqual([]);
  });
});
