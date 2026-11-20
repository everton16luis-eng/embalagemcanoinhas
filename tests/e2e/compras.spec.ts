// SGLog Fase 6: telas de compras e encomendas. Fluxo de tela e leitura; as regras (aprovacao, recebimento,
// conversao, concorrencia, idempotencia) ficam na suite da API (apps/api/test/sglog-fase6.test.ts).
// O unico dado criado e um rascunho de compra, cancelado no fim do proprio teste.
import { expect, test, type Page } from '@playwright/test';
import { entrarNoPainel, errosDoConsole, painelCreds, semRolagemLateral } from './apoio';

const NOTE = 'Rascunho do teste de tela (cancelado no fim)';
const origin = () => new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').origin;
const api = async (page: Page, method: 'GET' | 'POST', url: string, data?: object) => {
  const r = method === 'GET' ? await page.request.get(`/api/v1${url}`) : await page.request.post(`/api/v1${url}`, { data, headers: { origin: origin() } });
  expect(r.ok(), `${method} ${url}: ${r.status()}`).toBe(true);
  return r.json();
};

test.describe('compras e encomendas (Fase 6)', () => {
  test.skip(!painelCreds(), 'sem E2E_EMAIL/E2E_PASSWORD');

  test.beforeEach(async ({ page }) => {
    await entrarNoPainel(page.request);
  });

  test('rascunho, envio para aprovação e aprovação exige verificação em duas etapas', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    // Base: embalagem e fornecedor de uma compra que ja existe no banco local.
    const list = await api(page, 'GET', '/admin/purchase-orders?status=sent&pageSize=5');
    test.skip(!list.items.length, 'nenhuma compra enviada no banco local');
    const base = (await api(page, 'GET', `/admin/purchase-orders/${list.items[0].id}`)).order;
    // Rascunhos deste teste que ficaram de uma execucao interrompida: cancelados antes de criar outro.
    for (const st of ['draft', 'pending_approval']) {
      for (const o of (await api(page, 'GET', `/admin/purchase-orders?status=${st}&pageSize=50`)).items) {
        if (o.notes === NOTE) await api(page, 'POST', `/admin/purchase-orders/${o.id}/cancel`, { reason: 'Limpeza do teste de tela' });
      }
    }
    const created = await api(page, 'POST', '/admin/purchase-orders', {
      supplierId: base.supplier_id,
      items: [{ packagingId: base.items[0].packaging_id, packs: '1', packCostCents: 100, minExceptionReason: 'Teste de tela' }],
      notes: NOTE,
    });
    const id = created.order.id as string;
    page.on('dialog', (d) => d.accept(d.message().includes('Justifique') ? 'Teste de tela: aprovação própria' : 'Teste de tela concluído'));

    await page.goto(`/painel/compras/${id}`);
    await expect(page.getByRole('heading', { name: /Pedido de compra nº \d+/ })).toBeVisible();
    await expect(page.getByText('Rascunho', { exact: true })).toBeVisible();
    await expect(page.getByText(/Reposição do estoque · destino /)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Marcar como enviado' })).toHaveCount(0);
    await semRolagemLateral(page);
    await page.getByRole('button', { name: 'Enviar para aprovação' }).click();
    await expect(page.getByText('Aguardando aprovação', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Histórico da compra' })).toBeVisible();
    await expect(page.getByTestId('po-events')).toContainText('Enviado para aprovação');
    await page.screenshot({ path: info.outputPath('aguardando-aprovacao.png'), fullPage: true });

    // Aprovar: o servidor decide (MFA, quem criou). Sem MFA, a tela mostra o motivo e nada muda.
    await page.getByRole('button', { name: 'Aprovar' }).click();
    const blocked = page.getByRole('alert').filter({ hasText: 'verificação em duas etapas' });
    const approved = page.getByText('Aprovado', { exact: true });
    await expect(blocked.or(approved)).toBeVisible();
    if (await blocked.isVisible()) await expect(page.getByText('Aguardando aprovação', { exact: true })).toBeVisible();

    // Pagamento informado e so registro: o painel diz isso.
    await expect(page.getByTestId('payment-informed')).toContainText('Não informado.');

    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('Cancelado', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('po-events')).toContainText('Cancelado');
    await semRolagemLateral(page);
    expect(erros).toEqual([]);
  });

  test('recebimento: destino da compra e divergências do item (sem dar entrada)', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    const list = await api(page, 'GET', '/admin/purchase-orders?status=sent&pageSize=5');
    test.skip(!list.items.length, 'nenhuma compra enviada no banco local');
    await page.goto(`/painel/compras/${list.items[0].id}`);
    await expect(page.getByRole('heading', { name: 'Receber mercadoria' })).toBeVisible();
    await expect(page.getByText(/Destino: .*O recebimento só entra neste depósito\./)).toBeVisible();
    await page.getByRole('button', { name: 'Recusa, preço da nota ou falta' }).first().click();
    for (const l of ['Recusadas (embalagens)', 'Destino do recusado', 'Motivo da recusa', 'Custo da embalagem na nota (R$)', 'Justificativa do preço', 'Falta frente à nota'])
      await expect(page.getByLabel(l).first()).toBeVisible();
    await expect(page.getByLabel('Destino do recusado').first().locator('option')).toHaveText(['Avariado', 'Bloqueado (quarentena)']);
    await expect(page.getByRole('heading', { name: 'Aprovação e pagamento' })).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('recebimento.png'), fullPage: true });
    expect(erros).toEqual([]);
  });

  test('encomendas: fila por depósito e reprocessamento só com prévia', async ({ page }, info) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/logistica/encomendas');
    await expect(page.getByRole('heading', { name: 'Encomendas' })).toBeVisible();
    await expect(page.getByTestId('backorder-queue').first().or(page.getByText('Nenhuma encomenda aguardando mercadoria.'))).toBeVisible();
    await semRolagemLateral(page);
    await page.getByRole('button', { name: 'Reprocessar encomendas' }).click();
    await expect(page.getByRole('heading', { name: 'Prévia do reprocessamento' })).toBeVisible();
    await expect(page.getByText('Nada mudou ainda. Confira e aplique.')).toBeVisible();
    await semRolagemLateral(page);
    await page.screenshot({ path: info.outputPath('encomendas.png'), fullPage: true });
    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByRole('heading', { name: 'Prévia do reprocessamento' })).toHaveCount(0);
    expect(erros).toEqual([]);
  });

  test('lista de compras: novas situações no filtro', async ({ page }) => {
    const erros = errosDoConsole(page);
    await page.goto('/painel/compras');
    await expect(page.getByTestId('purchase-rules')).toContainText('Toda compra passa por aprovação.');
    const sel = page.getByLabel('Situação');
    await expect(sel.locator('option', { hasText: 'Aguardando aprovação' })).toHaveCount(1);
    await expect(sel.locator('option', { hasText: 'Aprovado' })).toHaveCount(1);
    await sel.selectOption('pending_approval');
    await expect(page.getByText('Nenhum pedido de compra nesta situação.').or(page.getByText('Aguardando aprovação', { exact: true }).nth(1))).toBeVisible();
    await semRolagemLateral(page);
    expect(erros).toEqual([]);
  });
});
