// SGLog Fase 5: telas de expedicao. So leitura e navegacao: as regras (separar, conferir, despachar,
// concorrencia, idempotencia) ficam na suite da API (apps/api/test/sglog-fase5.test.ts).
import { expect, test } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

test.describe('expedição', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('fila: contadores, abas, busca vazia e regras travadas', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/expedicao');
    await expect(page.getByRole('heading', { name: 'Expedição' })).toBeVisible();
    for (const c of ['A separar', 'Em separação', 'Em conferência', 'Embaladas']) await expect(page.getByRole('button', { name: new RegExp(c) }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Em aberto' })).toHaveAttribute('aria-selected', 'true');
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('fila.png'), fullPage: true });

    // Remessas multiplas comecam travadas (D5-3) e o conferente distinto desligado (D5-7).
    await expect(page.getByText('Remessas múltiplas (entrega parcial)')).toBeVisible();
    await expect(page.getByText('Travadas', { exact: true })).toBeVisible();
    await expect(page.getByText('Não exigido', { exact: true })).toBeVisible();

    await page.getByLabel('Buscar').fill('zz-nao-existe-zz');
    await page.getByRole('button', { name: 'Buscar' }).click();
    await expect(page.getByText('Nenhuma remessa encontrada.')).toBeVisible();

    await page.getByLabel('Buscar').fill('');
    await page.getByRole('button', { name: 'Buscar' }).click();
    await page.getByRole('tab', { name: 'Canceladas' }).click();
    await expect(page.getByRole('tab', { name: 'Canceladas' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('a[href^="/painel/logistica/expedicao/"]').first().or(page.getByText('Nenhuma remessa nesta situação.'))).toBeVisible();
    await semRolagemLateral(page);
    expect(erros).toEqual([]);
  });

  test('remessa aberta: etapas, itens e próxima ação', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/expedicao');
    const aberta = page.locator('a[href^="/painel/logistica/expedicao/"]').first();
    const vazia = page.getByText('Nenhuma remessa nesta situação.');
    await expect(aberta.or(vazia)).toBeVisible();
    test.skip(await vazia.isVisible(), 'nenhuma remessa aberta no banco local');
    await aberta.click();
    await expect(page.getByRole('heading', { name: /Pedido nº \d+ · remessa \d+/ })).toBeVisible();
    await expect(page.getByText(/^Itens \(\d+\)$/)).toBeVisible();
    // Sempre ha uma acao clara para a etapa atual.
    await expect(
      page
        .getByRole('button', { name: 'Iniciar separação' })
        .or(page.getByRole('button', { name: 'Concluir separação' }))
        .or(page.getByRole('button', { name: 'Conferir' }))
        .or(page.getByRole('button', { name: /Despachar|Entregar ao cliente/ }))
        .first(),
    ).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('remessa-aberta.png'), fullPage: true });
    expect(erros).toEqual([]);
  });

  test('remessa entregue: histórico e pedido ligado', async ({ page }, info) => {
    await page.goto('/painel/logistica/expedicao');
    await page.getByRole('tab', { name: 'Entregues' }).click();
    const entregue = page.locator('a[href^="/painel/logistica/expedicao/"]').first();
    const vazia = page.getByText('Nenhuma remessa nesta situação.');
    await expect(entregue.or(vazia)).toBeVisible();
    test.skip(await vazia.isVisible(), 'nenhuma remessa entregue no banco local');
    await entregue.click();
    await expect(page.getByText('Histórico').first()).toBeVisible();
    await expect(page.getByText(/^Entregue/).first()).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('remessa-entregue.png'), fullPage: true });
    await page.getByRole('link', { name: 'Ver pedido' }).click();
    await expect(page.getByText('Remessas', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir na expedição' }).first()).toBeVisible();
    await semRolagemLateral(page);
  });

  test('remessa inexistente mostra erro claro', async ({ page }) => {
    await page.goto('/painel/logistica/expedicao/00000000-0000-4000-8000-000000000000');
    await expect(page.getByText(/não encontrad/i)).toBeVisible();
  });
});
