// SGLog Fase 5: telas de expedicao. So leitura e navegacao: as regras (separar, conferir, despachar,
// concorrencia, idempotencia) ficam na suite da API (apps/api/test/sglog-fase5.test.ts).
import { expect, test, type Page } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

test.describe('expedição', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('fila: contadores, abas, busca vazia e regras travadas', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/expedicao');
    await expect(page.getByRole('heading', { name: 'Expedição', exact: true })).toBeVisible();
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

  // Alocacao no pedido: trocar e desfazer so aparecem quando o servidor aceitaria (sem remessa em manuseio).
  type Remessa = { order_id: string; status: string; order_status: string; logistics_status: string | null; picked_qty: string };
  async function remessaCom(page: Page, statuses: string[], ok: (r: Remessa) => boolean) {
    for (const st of statuses) {
      const r = await page.request.get(`/api/v1/admin/shipments?status=${st}&page=1&pageSize=30`);
      expect(r.status()).toBe(200);
      const achada = ((await r.json()).items as Remessa[]).find(ok);
      if (achada) return achada;
    }
    return null;
  }

  test('alocação: remessa em manuseio esconde trocar e desfazer e mostra o motivo', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    const alvo = await remessaCom(page, ['packed', 'checking', 'picking'], (r) => r.logistics_status === 'processing');
    test.skip(!alvo, 'nenhuma remessa em manuseio no banco local');
    await page.goto(`/painel/pedidos/${alvo!.order_id}`);
    const aviso = page.getByTestId('allocation-lock');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('A origem não pode ser alterada após o início da separação.');
    await expect(aviso).toContainText('A alocação não pode ser desfeita após o início da separação.');
    await expect(aviso.getByRole('link', { name: /Remessa nº \d+/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trocar origem' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Desfazer alocação' })).toHaveCount(0);
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('alocacao-travada.png'), fullPage: true });
    expect(erros).toEqual([]);
  });

  test('alocação: remessa pendente sem nada separado mantém desfazer', async ({ page }) => {
    const erros = errosDoConsole(page);
    const alvo = await remessaCom(page, ['pending'], (r) => r.logistics_status === 'processing' && Number(r.picked_qty) === 0);
    test.skip(!alvo, 'nenhuma remessa pendente no banco local');
    await page.goto(`/painel/pedidos/${alvo!.order_id}`);
    await expect(page.getByRole('button', { name: 'Desfazer alocação' })).toBeVisible();
    await expect(page.getByTestId('allocation-lock')).toHaveCount(0);
    await semRolagemLateral(page);
    expect(erros).toEqual([]);
  });

  test('remessa inexistente mostra erro claro', async ({ page }) => {
    await page.goto('/painel/logistica/expedicao/00000000-0000-4000-8000-000000000000');
    await expect(page.getByText(/não encontrad/i)).toBeVisible();
  });
});
