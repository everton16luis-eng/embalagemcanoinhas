// Registro do fluxo atual (antes de usar as telas novas): vitrine, carrinho, checkout ate o pedido criado
// com Pix simulado (PAYMENT_FAKE), e o pedido no painel. Nenhum pagamento e feito: o teste para na tela do pedido.
import { expect, test } from '@playwright/test';
import { cpfDeTeste, entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

test.describe('fluxo atual da loja', () => {
  test('vitrine → produto → carrinho → checkout cria o pedido (Pix simulado, sem pagar)', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/');
    await expect(page.locator('a[href^="/p/"]').first()).toBeVisible();
    await semRolagemLateral(page);

    // Primeiro produto com estoque.
    const links = await page.locator('a[href^="/p/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')!))].slice(0, 12));
    let adicionou = false;
    for (const href of links) {
      await page.goto(href);
      const comprar = page.getByRole('button', { name: /^Adicionar ·/ });
      if (await comprar.isEnabled({ timeout: 5_000 }).catch(() => false)) {
        await comprar.click();
        await expect(page.getByRole('button', { name: /^Adicionar ·/ })).toBeEnabled();
        adicionou = true;
        break;
      }
    }
    test.skip(!adicionou, 'nenhum produto com estoque na vitrine local');
    await semRolagemLateral(page);

    await page.goto('/carrinho');
    await expect(page.getByText(/Subtotal/i).first()).toBeVisible();
    await semRolagemLateral(page);

    await page.goto('/finalizar');
    await expect(page.getByRole('heading', { name: /Finalizar compra/i })).toBeVisible();
    await page.getByLabel(/Nome completo/).fill('Cliente Teste E2E');
    await page.getByLabel('E-mail').fill(`e2e-${Date.now()}@exemplo.invalid`);
    await page.getByLabel('Celular com DDD').fill('47900000000');
    await page.getByLabel('CPF').fill(cpfDeTeste());
    await page.getByPlaceholder('CEP').fill('89460000');
    await page.getByRole('button', { name: 'Ver opções' }).click();
    const retirada = page.getByRole('radiogroup', { name: 'Forma de entrega' }).locator('label', { hasText: /Retirada/i }).first();
    await expect(retirada).toBeVisible();
    await retirada.click();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('checkout.png'), fullPage: true });

    // So o projeto desktop cria o pedido: o de 375 px confere o layout sem gerar outro pedido.
    if (info.project.name !== 'desktop') return;
    await page.getByRole('button', { name: /Fazer pedido e pagar com Pix/ }).click();
    await page.waitForURL(/\/pedido\//);
    await expect(page.getByText(/Pix/i).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath('pedido-criado.png'), fullPage: true });
    expect(erros, 'sem erro de script na loja').toEqual([]);
  });

  test('pedidos no painel: lista e detalhe abrem sem erro', async ({ page }) => {
    test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');
    const erros = errosDoConsole(page);
    await entrarNoPainel(page.request);
    await page.goto('/painel/pedidos');
    const primeiro = page.locator('a[href^="/painel/pedidos/"]').first();
    await expect(primeiro).toBeVisible();
    await semRolagemLateral(page);
    await primeiro.click();
    await expect(page.getByRole('heading', { name: /Pedido nº/ })).toBeVisible();
    await expect(page.getByText('Itens').first()).toBeVisible();
    await semRolagemLateral(page);
    expect(erros, 'sem erro de script no painel').toEqual([]);
  });
});
