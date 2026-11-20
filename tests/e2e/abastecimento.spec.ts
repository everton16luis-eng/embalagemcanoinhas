// SGLog Fase 7: telas de abastecimento, pedido ao fornecedor, confirmacao e requisicoes. Fluxo de tela e leitura;
// as regras (versoes imutaveis, confirmacao parcial/recusa, aumento com MFA, requisicoes automaticas, conversao,
// concorrencia) ficam na suite da API (apps/api/test/sglog-fase7.test.ts).
// O unico dado criado e uma requisicao manual, cancelada pela propria tela no fim do teste. Nada movimenta estoque.
import { expect, test, type Page } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

const REASON = 'Requisição do teste de tela (cancelada no fim)';
const origin = () => new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').origin;
const api = async (page: Page, method: 'GET' | 'POST', url: string, data?: object) => {
  const r = method === 'GET' ? await page.request.get(`/api/v1${url}`) : await page.request.post(`/api/v1${url}`, { data, headers: { origin: origin() } });
  expect(r.ok(), `${method} ${url}: ${r.status()}`).toBe(true);
  return r.json();
};

test.describe('abastecimento e fornecedores (Fase 7)', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('Logística → Abastecimento: situações, a caminho, encomendas e desempenho', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/abastecimento');
    await expect(page.getByRole('heading', { name: 'Abastecimento', level: 1 })).toBeVisible();
    await expect(page.getByTestId('supply-counts')).toContainText('Aguardando confirmação');
    await expect(page.getByTestId('supply-counts')).toContainText('Entrega atrasada');
    await expect(page.getByTestId('supply-orders')).toBeVisible();
    await expect(page.getByTestId('supply-inbound').or(page.getByText('Nada a caminho.'))).toBeVisible();
    await expect(page.getByTestId('supply-affected').or(page.getByText('Nenhuma encomenda afetada.'))).toBeVisible();
    await expect(page.getByTestId('supply-performance').or(page.getByText('Sem compras enviadas no período.'))).toBeVisible();
    // Encomendas afetadas mostram so o numero do pedido: nada de nome, e-mail ou telefone de cliente.
    if (await page.getByTestId('supply-affected').isVisible()) await expect(page.getByTestId('supply-affected')).not.toContainText('@');
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('abastecimento.png'), fullPage: true });
    // O inicio do painel resume o abastecimento.
    await page.goto('/painel');
    await expect(page.getByTestId('home-supply')).toContainText('Encomendas sem compra');
    await semRolagemLateral(page);
    expect(erros).toEqual([]);
  });

  test('compra enviada: pedido ao fornecedor, confirmação e acompanhamento', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    const list = await api(page, 'GET', '/admin/purchase-orders?status=sent&pageSize=5');
    test.skip(!list.items.length, 'nenhuma compra enviada no banco local');
    const id = list.items[0].id as string;
    await page.goto(`/painel/compras/${id}`);
    await expect(page.getByRole('heading', { name: /Pedido de compra nº \d+/ })).toBeVisible();
    await expect(page.getByTestId('supply-badge')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pedido ao fornecedor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Confirmação do fornecedor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Acompanhamento' })).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('compra-enviada.png'), fullPage: true });

    // Documento: versao enviada (imutavel) ou previa; sem dados de cliente. Se faltar dado, a tela lista o que falta.
    const docs = (await api(page, 'GET', `/admin/purchase-orders/${id}`)).order.documents as { version: number }[];
    await page.goto(docs.length ? `/painel/compras/${id}/documento?v=${docs[0]!.version}` : `/painel/compras/${id}/documento`);
    await expect(page.getByTestId('po-document').or(page.getByText(/Faltam dados para gerar o pedido/))).toBeVisible();
    if (await page.getByTestId('po-document').isVisible()) {
      await expect(page.getByTestId('po-document')).toContainText('Entregar em');
      await expect(page.getByRole('button', { name: 'Imprimir ou salvar em PDF' })).toBeVisible();
      if (docs.length) await expect(page.getByText(/Imutável\./)).toBeVisible();
    }
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('documento.png'), fullPage: true });
    expect(erros).toEqual([]);
  });

  test('requisições: pedir compra, listar e cancelar (sem estoque)', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    const list = await api(page, 'GET', '/admin/purchase-orders?status=sent&pageSize=5');
    test.skip(!list.items.length, 'nenhuma compra enviada no banco local');
    const base = (await api(page, 'GET', `/admin/purchase-orders/${list.items[0].id}`)).order;
    // Sobras de uma execucao interrompida: canceladas antes de criar outra.
    for (const r of (await api(page, 'GET', '/admin/purchase-requests?status=open&source=manual&pageSize=100')).items)
      if (r.reason === REASON) await api(page, 'POST', `/admin/purchase-requests/${r.id}/cancel`, { reason: 'Limpeza do teste de tela' });

    const created = await api(page, 'POST', '/admin/purchase-requests', {
      variantId: base.items[0].variant_id,
      warehouseId: base.warehouse_id,
      baseQty: String(base.items[0].base_qty_per_pack),
      reason: REASON,
      forStock: true,
    });
    const number = created.request.number as number;

    await page.goto('/painel/compras/requisicoes');
    await expect(page.getByRole('heading', { name: 'Requisições de compra' })).toBeVisible();
    await expect(page.getByTestId('new-request')).toBeVisible();
    const row = page.getByTestId('requests').locator('li', { hasText: `Nº ${number}` });
    await expect(row).toContainText(REASON);
    // Marcar abre a geracao da compra (rascunho; aprovacao e envio seguem o caminho normal). Nao gera aqui.
    await row.getByRole('checkbox').check();
    await expect(page.getByTestId('convert-requests')).toContainText(`nº ${number}`);
    await expect(page.getByRole('button', { name: 'Gerar compra' })).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('requisicoes.png'), fullPage: true });

    page.on('dialog', (d) => d.accept('Teste de tela concluído'));
    await row.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('requests').locator('li', { hasText: `Nº ${number}` })).toHaveCount(0);
    const after = (await api(page, 'GET', `/admin/purchase-requests/${created.request.id}`)).request;
    expect(after.status).toBe('canceled');
    await semRolagemLateral(page);
    expect(erros).toEqual([]);
  });
});
