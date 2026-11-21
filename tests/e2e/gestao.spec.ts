// SGLog Fase 10: telas de Gestao (painel, rentabilidade, custos logisticos, fornecedores, custos e margens) e o painel
// Margem de contribuicao do pedido. Somente leitura no banco de demonstracao: formularios abertos e fechados sem enviar.
// As regras (formula, natureza de cada componente, CMV historico, versoes, duplicidade, estorno, rateio, periodos,
// volume) ficam na suite da API (apps/api/test/sglog-fase10.test.ts e sglog-fase10b.test.ts).
import { expect, test, type Page } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

const api = async (page: Page, url: string) => {
  const r = await page.request.get(`/api/v1${url}`);
  expect(r.ok(), `GET ${url}: ${r.status()}`).toBe(true);
  return r.json();
};
const doze = async (page: Page) => {
  await page.getByRole('button', { name: '12 meses' }).click();
};

test.describe('Gestão (Fase 10)', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('Painel Gestão: indicadores, cobertura, demonstração e base de data', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/gestao');
    await expect(page.getByRole('heading', { name: 'Painel Gestão', level: 1 })).toBeVisible();
    await doze(page);
    await expect(page.getByTestId('kpis').or(page.getByText('Nenhum pedido pago no período'))).toBeVisible();
    await expect(page.getByText('Margem de contribuição não é lucro líquido')).toBeVisible();
    if (await page.getByTestId('kpis').isVisible()) {
      await expect(page.getByTestId('kpis')).toContainText('Margem de contribuição');
      await expect(page.getByTestId('kpis')).toContainText('Cobertura dos custos');
      await expect(page.getByTestId('channel-bars')).toBeVisible();
      // Dados de demonstracao no banco local: aviso e filtro.
      await expect(page.getByText(/pedido\(s\) de demonstração no resultado/)).toBeVisible();
    }
    await expect(page.getByTestId('indicators')).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('gestao-painel.png'), fullPage: true });
    await page.getByLabel('Demonstração').selectOption({ label: 'Excluir' });
    await page.getByLabel('Período pela').selectOption({ label: 'Data do despacho' });
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page.getByText(/pedido\(s\) pagos de .* pela data do primeiro despacho/)).toBeVisible();
    await expect(page.getByText(/pedido\(s\) de demonstração no resultado/)).toHaveCount(0);
    await page.getByLabel('Demonstração').selectOption({ label: 'Incluir' });
    await page.getByLabel('Período pela').selectOption({ label: 'Data do pagamento' });
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('Rentabilidade: pedidos e grupos, ordenação, paginação e CSV', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/gestao/rentabilidade');
    await expect(page.getByRole('heading', { name: 'Rentabilidade', level: 1 })).toBeVisible();
    await doze(page);
    await expect(page.getByTestId('profit-orders').or(page.getByText('Nada no período'))).toBeVisible();
    await page.getByLabel('Situação').selectOption({ label: 'Parciais' });
    await expect(page.getByTestId('profit-orders').or(page.getByText('Nada no período'))).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('gestao-rentabilidade.png'), fullPage: true });
    for (const tab of ['Produto', 'Categoria', 'Canal', 'Fornecedor', 'UF']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page.getByTestId('profit-groups').or(page.getByText('Nada no período'))).toBeVisible();
      await semRolagemLateral(page);
    }
    await page.getByLabel('Ordenar por').selectOption({ label: 'Margem %' });
    await expect(page.getByTestId('profit-groups').or(page.getByText('Nada no período'))).toBeVisible();
    await page.screenshot({ path: info.outputPath('gestao-rentabilidade-uf.png'), fullPage: true });
    // CSV: o link baixa da API com a mesma sessao.
    const href = await page.getByTestId('csv-link').getAttribute('href');
    const csv = await page.request.get(href!);
    expect(csv.ok()).toBe(true);
    expect(csv.headers()['content-type']).toMatch(/text\/csv/);
    expect((await csv.text()).split('\r\n')[0]).toContain('margem_contribuicao');
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('Custos logísticos e desempenho de fornecedores', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/gestao/logistica');
    await expect(page.getByRole('heading', { name: 'Custos logísticos', level: 1 })).toBeVisible();
    await doze(page);
    await expect(page.getByTestId('freight-by-uf')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Perdas de estoque' })).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('gestao-logistica.png'), fullPage: true });
    await page.goto('/painel/gestao/fornecedores');
    await expect(page.getByRole('heading', { name: 'Desempenho de fornecedores', level: 1 })).toBeVisible();
    await doze(page);
    await expect(page.getByTestId('supplier-performance').or(page.getByText('Nenhum recebimento no período'))).toBeVisible();
    // Fornecedor nao depende da base de data nem do canal.
    await expect(page.getByLabel('Período pela')).toHaveCount(0);
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('gestao-fornecedores.png'), fullPage: true });
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('Custos e margens: abas abrem sem gravar; conferência C22-C24', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/gestao/custos');
    await expect(page.getByRole('heading', { name: 'Custos e margens', level: 1 })).toBeVisible();
    await expect(page.getByText('Só a versão')).toBeVisible();
    await expect(page.getByTestId('setting-list').or(page.getByText('Nenhuma configuração de custo'))).toBeVisible();
    if (await page.getByTestId('open-setting-form').isVisible()) {
      await page.getByTestId('open-setting-form').click();
      await expect(page.getByTestId('setting-form')).toBeVisible();
      await page.getByLabel('Tipo').selectOption({ label: 'Embalagem de envio' });
      await expect(page.getByLabel('Custo por volume (R$)')).toBeVisible();
      await semRolagemLateral(page);
      await page.screenshot({ path: info.outputPath('custos-configuracao.png'), fullPage: true });
      await page.getByRole('button', { name: 'Voltar' }).click();
      await expect(page.getByTestId('setting-form')).toHaveCount(0);
    }
    await page.getByRole('tab', { name: 'Lançamentos' }).click();
    await expect(page.getByTestId('entry-list').or(page.getByText('Nenhum lançamento'))).toBeVisible();
    await page.getByRole('tab', { name: 'Importação' }).click();
    await expect(page.getByTestId('cost-import')).toContainText('pedido;tipo;valor;data;referencia;observacao');
    await semRolagemLateral(page);
    await page.getByRole('tab', { name: 'Conferência' }).click();
    await page.getByRole('button', { name: 'Conferir C22–C24' }).click();
    await expect(page.getByText(/Nenhuma divergência/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('custos-conferencia.png'), fullPage: true });
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('Pedido de demonstração: margem de contribuição com natureza e origem', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    const list = await api(page, `/admin/management/orders?from=${new Date(Date.now() - 360 * 86_400_000).toISOString().slice(0, 10)}&demo=only&pageSize=1`);
    test.skip(!list.items.length, 'sem pedido de demonstração pago nos últimos 12 meses');
    const id = list.items[0].id as string;
    await page.goto(`/painel/pedidos/${id}`);
    await expect(page.getByTestId('order-margin')).toBeVisible();
    await expect(page.getByTestId('margin-lines')).toContainText('Mercadoria');
    await expect(page.getByTestId('order-margin')).toContainText(/Resultado parcial|Todos os componentes conhecidos/);
    await expect(page.getByTestId('margin-lines')).toContainText(/Efetivo/);
    if (await page.getByTestId('open-cost-entry').isVisible()) {
      await page.getByTestId('open-cost-entry').click();
      await expect(page.getByTestId('cost-entry-form')).toBeVisible();
      await page.getByTestId('cost-entry-form').getByRole('button', { name: 'Voltar' }).click();
      await expect(page.getByTestId('cost-entry-form')).toHaveCount(0);
    }
    await semRolagemLateral(page);
    await page.getByTestId('order-margin').screenshot({ path: info.outputPath('pedido-margem.png') });
    await expect(page.getByText('Erro interno')).toHaveCount(0);
    expect(erros).toEqual([]);
  });
});
