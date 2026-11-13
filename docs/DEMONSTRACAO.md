# Dados de demonstração e reversão

Para mostrar o sistema funcionando antes de ter catálogo e vendas reais: um comando enche o banco com uma loja
fictícia e outro apaga **tudo** depois, deixando só os proprietários. Script em
[`apps/api/src/db/demo.ts`](../apps/api/src/db/demo.ts).

## Popular

Como usuário `loja`, em `/srv/loja-embalagens` (o proprietário já precisa existir):

```bash
npm run demo:seed -- --confirmar DEMO
```

Só roda num banco **sem** produtos, pedidos, orçamentos, clientes e fornecedores (não mistura com dado real). Leva
alguns segundos.

O que entra (6 meses de histórico, mais denso perto de hoje):

| Área | Conteúdo |
|---|---|
| Catálogo | 6 categorias com 17 subcategorias, ~100 produtos e ~210 variações (forminhas, caixas, copos, velas, fitas…), embalagens de venda e de compra, preço por quantidade, alguns rascunhos, inativos e itens sob encomenda, reajustes no histórico de preços |
| Estoque | Livro de movimentos completo (entradas, reservas, vendas, perdas, avarias, ajustes), saldo e custo médio coerentes com o livro, itens abaixo do mínimo, um inventário fechado com diferenças e um em andamento |
| Compras | 7 fornecedores fictícios com ofertas, ~85 pedidos de compra (recebidos, em parte, enviados, rascunho, cancelados) |
| Vendas | ~450 pedidos (loja, balcão, Mercado Livre e Shopee) em todas as situações, pagamentos simulados, despachos e entregas |
| Balcão | 240 orçamentos (em aberto, vencidos, convertidos em pedido, cancelados) |
| Clientes | 64 clientes (pessoa física e empresa) com endereço; visitantes nos pedidos |
| Entregas | Retirada, entrega em Canoinhas e entrega no Planalto Norte |
| Marketplaces | Uma conta de cada plataforma **desconectada**, anúncios ligados a produtos e vendas importadas |
| WhatsApp | Modelos dos 3 avisos, avisos enviados/lidos/com falha e mensagens recebidas para responder |
| Equipe | 6 usuários (gerente, vendas, estoque, fiscal, expedição) com senha aleatória descartada: aparecem nas telas, ninguém entra com eles |

O que **não** entra, de propósito:

- **Empresa, certificado, regras fiscais e NF-e**: seriam dados fiscais inventados. A classificação fiscal dos
  produtos fica pendente. Pedidos despachados da demonstração ficam com nota "não exigida"; os em aberto, com nota
  pendente.
- **Fotos** (a loja mostra "foto em breve"), **marca da loja** e **auditoria** das ações simuladas (a auditoria é
  imutável; só o registro `demo.seed` entra).

Dados fictícios: e-mails em `@demo.invalid` (domínio reservado, nunca entrega), telefones no padrão
`(47) 90000-NNNN`, nomes de fornecedores com "(demonstração)", contas de marketplace sem token. Nenhuma rotina da API
envia nada com esses dados: avisos de WhatsApp já estão em situação final e as contas de marketplace estão
desconectadas.

## Apagar tudo (reversão)

```bash
npm run demo:reset -- --confirmar APAGAR-TUDO
```

1. Recusa se houver algo que precisa ser guardado: emissão fiscal liberada em produção, qualquer nota fiscal ou
   inutilização (mesmo de homologação), arquivo fiscal, XML de nota de compra, pagamento real aprovado ou conta de
   marketplace conectada de verdade.
2. Faz um **backup** completo (`npm run backup`) antes; se o backup falhar, não apaga nada.
3. Numa transação só: esvazia todas as tabelas de cadastro e movimento (as de amanhã também: a lista sai do banco),
   volta as numerações (pedido 1001, orçamento 1, compra 1), volta a configuração fiscal e a marca da loja ao padrão e
   remove a equipe que não é proprietária.
4. Apaga do disco as fotos e o logotipo que estavam cadastrados.

Ficam: **proprietários** (com senha e MFA), a **auditoria** (com o registro `demo.reset`), as unidades de medida e o
controle das migrations. Quem não é proprietário mas aparece na auditoria (alguém que entrou no painel) não pode ser
apagado sem quebrar a trilha: fica desativado, sem MFA, sem permissões e sem sessão.

## Ordem recomendada

1. Instalar, criar o proprietário, `demo:seed`, demonstrar.
2. `demo:reset` **antes** de cadastrar o catálogo real e **antes** de emitir a primeira nota de homologação (depois
   dela, a reversão é recusada).
3. Cadastrar a loja de verdade.
