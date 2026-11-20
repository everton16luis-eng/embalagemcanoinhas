# Testes de navegador (Playwright)

Dependência só de desenvolvimento. Roda **apenas contra a loja local** (`localhost`, `127.0.0.1`, `*.localhost` ou
`*.test`): a configuração recusa outro endereço. Nunca rodar contra o servidor.

## Antes

1. Banco local com a demonstração, API e painel no ar (`npm run dev:api` e `npm run dev:web`).
2. `.env` com `PAYMENT_FAKE=true`: o checkout cria o pedido com Pix simulado e o teste para na tela do pedido, sem
   pagar.
3. Um usuário **local** com acesso ao painel (por exemplo, proprietário criado com `create-owner`).

O projeto não baixa navegador: usa o Chrome instalado. Para usar o Edge, defina `E2E_CHANNEL=msedge`.

## Rodar

```powershell
$env:E2E_EMAIL = 'usuario-local@loja.test'; $env:E2E_PASSWORD = '<senha do usuário local>'; npm run e2e
```

`E2E_BASE_URL` muda o endereço (padrão `http://localhost:3010`). Sem `E2E_EMAIL` e `E2E_PASSWORD`, os testes do painel
são pulados.

## O que roda

- `fluxo-atual.spec.ts` registra o fluxo atual:
  - vitrine → produto com estoque → carrinho → checkout com retirada e Pix até a tela do pedido (só no desktop, para
    não criar dois pedidos);
  - lista e detalhe de pedidos no painel.
- `expedicao.spec.ts` confere as telas da Fase 5:
  - fila, contadores, abas, busca vazia;
  - regras travadas (remessas múltiplas e conferente distinto);
  - remessa aberta com a próxima ação, remessa entregue ligada ao pedido;
  - erro de remessa inexistente.

Cada teste roda em dois projetos, `desktop` e `celular-375`, e confere que a página não rola para o lado. Traces,
capturas e relatório ficam em `tests/e2e/.resultados/` (fora do git): `npx playwright show-report tests/e2e/.resultados/relatorio`.

Cada execução cria um pedido aguardando pagamento no banco local. Ele expira pelo prazo de pagamento, como qualquer
pedido não pago.
