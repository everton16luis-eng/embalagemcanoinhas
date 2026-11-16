# SGLog — Fase 3: estoque por depósito

Escopo aprovado em 16/11/2026 (decisões D3-1 a D3-7 e os 12 requisitos adicionais), sobre o planejamento em
[19-sglog-fase3-planejamento.md](19-sglog-fase3-planejamento.md). Branch `sglog/fase3`, só local. **Nada foi
implantado nem migrado no servidor.**

## 1. Revisão antes de programar

### 1.1 Equações do estoque

Os saldos são guardados por depósito `w` e variante `v` em `stock_location_balances`. O total por variante, em
`stock_balances`, é sempre a soma dos depósitos, saldo por saldo; a trava no COMMIT e a conferência C2 garantem isso.

| Saldo | Coluna | O que é | Vendável? |
|---|---|---|---|
| Disponível fisicamente | `on_hand` | Mercadoria boa, liberada, no depósito | Sim, descontado o reservado |
| Reservado | `reserved` | Parte de `on_hand` comprometida com carrinho, pedido ou orçamento | Não |
| Bloqueado ou em quarentena | `blocked` | Mercadoria no depósito, retida para conferência, qualidade ou quarentena | Não |
| Avariado | `damaged` | Mercadoria no depósito, avariada, aguardando decisão (recuperar ou dar baixa) | Não |
| Em trânsito | `in_transit` | Enviada por transferência e ainda não recebida. Conta **no depósito de destino** | Não |

As equações, por depósito, são:

```
Físico sob custódia(w)  = on_hand(w) + blocked(w) + damaged(w)
Em trânsito para w      = in_transit(w)
Vendável(w)             = on_hand(w) − reserved(w)
Livre para movimentar(w) = on_hand(w) − reserved(w)      (teto de transferência, bloqueio e avaria)
```

Por variante, com cada termo igual à soma dos depósitos:

```
Vendável                = on_hand − reserved              (exatamente a regra de hoje)
Total gerencial         = on_hand + blocked + damaged + in_transit
```

**Compatibilidade.**

- A loja, os marketplaces, os orçamentos, o bot e os relatórios continuam lendo `on_hand − reserved` de
  `stock_balances`. A fórmula não muda.
- Mercadoria bloqueada, avariada ou em trânsito sai de `on_hand`. Por isso deixa de ser vendável sem nenhuma mudança
  nesses módulos.

**Sem dupla contagem.** Uma transferência de `q` de A para B faz, na mesma transação:

- `on_hand(A)` −q;
- `in_transit(B)` +q.

O total gerencial não muda. No recebimento de `r`, `in_transit(B)` −r e `on_hand(B)` +r. A mercadoria está sempre em
exatamente um saldo.

**Sem negativo indevido.**

- Todos os saldos têm CHECK ≥ 0 por depósito e no total.
- Transferência, bloqueio e marcação de avaria só retiram do **livre** (`on_hand − reserved`) do depósito. Assim,
  nunca tomam mercadoria já reservada.
- Ajuste, perda, avaria com baixa e inventário seguem a regra de hoje: não deixam `on_hand` negativo.

**Custo médio.** Passa a ponderar o total gerencial:

```
novo médio = (gerencial × médio + entrada × custo) / (gerencial + entrada)
```

Hoje a ponderação usa só `on_hand`. Como bloqueado, avariado e em trânsito nascem em zero, o resultado só difere
quando esses saldos existirem. Nesse caso, é o correto: a mercadoria retida continua sendo da empresa e tem custo.

### 1.2 Estados da transferência

A transferência tem cabeçalho (`stock_transfers`: origem, destino, situação) e itens. Cada item tem as
quantidades enviada, recebida, extraviada e devolvida. O pendente é o enviado menos as outras três.

| Situação | Quando |
|---|---|
| `in_transit` | Enviada, nada recebido ainda |
| `partial` | Parte já recebida, extraviada ou devolvida; ainda há pendente |
| `received` | Nada pendente e tudo foi recebido |
| `closed_divergent` | Nada pendente, com extravio ou devolução em algum item |
| `canceled` | Envio estornado antes de qualquer recebimento |

| Evento | Quem | Efeito no estoque | Regras |
|---|---|---|---|
| Enviar | `stock.transfer` | Origem `on_hand` −q; destino `in_transit` +q | Origem ≠ destino, ambos ativos; q ≤ livre da origem; vários itens numa transação, com bloqueio em ordem de variante |
| Receber (total ou parcial) | `stock.transfer` | Destino `in_transit` −r, `on_hand` +r | r ≤ pendente do item; a transferência é bloqueada na linha, então dois recebimentos simultâneos não somam além do enviado; chave de requisição evita duplo clique |
| Receber agora (operação interna) | `stock.transfer` | Envio e recebimento na mesma transação | Os dois eventos e os dois conjuntos de movimentos ficam no histórico |
| Extravio | `stock.adjust` (MFA) | Destino `in_transit` −x (baixa) | Motivo obrigatório; x ≤ pendente |
| Recusa no destino | `stock.transfer` | Destino `in_transit` −y; origem `on_hand` +y | Motivo obrigatório; y ≤ pendente. Registra-se quando a mercadoria **voltou** à origem: enquanto volta, segue pendente |
| Cancelar envio (estorno) | `stock.adjust` (MFA) | Estorna os movimentos do envio | Só com nada recebido, extraviado ou devolvido. Depois disso, a volta é por recusa ou por uma nova transferência no sentido inverso |

Cada evento grava uma linha imutável em `stock_transfer_events`, com autor, data, quantidades por item, motivo e
chave de requisição. Grava também a auditoria.

### 1.3 Contradições encontradas no planejamento e como foram resolvidas

| # | Planejamento (doc 19 / Fase Zero) | Problema | Decisão |
|---|---|---|---|
| 1 | Quarentena move `on_hand` ↔ `damaged` | D3-4 agrupa "bloqueado ou em quarentena" num saldo e deixa "avariado" em outro | `block`/`unblock` cobrem bloqueio e quarentena (o motivo diz qual). `damage_hold`/`damage_release` movem para o avariado e de volta. A baixa do avariado é `damage` com `damaged_delta` negativo; o `damage` de hoje (baixa direto do disponível) continua igual |
| 2 | Localização, mínimo e máximo como colunas de `stock_location_balances`, com GRANT por coluna | O saldo por depósito só muda por movimento, e a aplicação não pode inserir linha nele. Configurar o mínimo de uma variante sem saldo exigiria INSERT | Tabela própria, `stock_location_settings` (depósito × variante: localização, mínimo, máximo). A tabela de saldo continua só com o gatilho |
| 3 | `stock_reservations.warehouse_id` na 0022 | Na Fase 3 nenhuma reserva escolhe depósito (requisito 10), e a coluna ficaria sem uso | Fica para a Fase 4, com `allocation_id`. As reservas continuam no depósito padrão |
| 4 | Transferência com `transfer_out` e `transfer_in` | Cada linha do livro deve afetar um único depósito (o gatilho aplica os deltas no depósito da linha). O envio afeta dois | O envio grava 2 linhas `transfer_out` (origem: −`on_hand`; destino: +`in_transit`), ligadas pelo mesmo `transfer_id`. O recebimento grava 1 linha `transfer_in`. Tipos novos `transfer_loss` (extravio) e `transfer_return` (recusa, 2 linhas) |
| 5 | Estornar uma perna de transferência já recebida "devolve à origem" | Contraria o requisito 6: não estornar transferência movimentada depois | O estorno só cancela envio sem nenhum evento posterior. A volta física é por recusa ou por nova transferência |
| 6 | Trocar o depósito padrão "com confirmação" | Reservas ativas e as linhas antigas do livro (`warehouse_id` nulo) estão ligadas ao padrão. Trocar o padrão faria uma liberação de reserva cair noutro depósito e quebrar o CHECK | Na Fase 3 o padrão não pode ser trocado; continua `PRINCIPAL` (D3-1). A troca volta com a Fase 4 |
| 7 | CHECK `NOT VALID` seguido de validação | Dentro de uma transação que já tem bloqueio exclusivo, não ganha nada | CHECKs normais; o ensaio na cópia mede o tempo |
| 8 | Estorno de qualquer movimento manual | Estornar venda, reserva, recebimento de compra ou inventário quebraria pedidos, compras e contagens | Só se estornam movimentos manuais, de origem `manual` ou de uma solicitação aprovada: `adjustment`, `loss`, `damage`, `return`, `block`, `unblock`, `damage_hold` e `damage_release`. Um movimento só se estorna uma vez (índice único); estorno não se estorna; o estorno não pode tirar do depósito mais que o livre (não toma reservado nem saldo já consumido); o depósito precisa estar ativo |

### 1.4 Outras decisões técnicas

- **Ajustes sensíveis (D3-2).**
  - Permissão nova `stock.adjust`, com MFA, para: ajuste, perda, avaria (baixa, inclusive do avariado), estorno,
    extravio, cancelamento de transferência e aprovação de solicitação.
  - Recebem `stock.adjust`: dono, gerente e gerente de logística.
  - O Estoquista mantém o que já tinha (`stock.manage`): devolução de cliente, reservas, inventário, bloqueio,
    marcação de avaria, localização e mínimo/máximo. Ganha `stock.transfer`.
  - Para ajuste, perda e avaria, o Estoquista abre uma **solicitação de ajuste** (`stock_adjustment_requests`). Um
    usuário com `stock.adjust` aprova ou recusa.
    - Quem pede não aprova a própria solicitação.
    - A aprovação grava o movimento na mesma transação.
    - Se o saldo mudou e não comporta mais a saída, a solicitação continua pendente.
- **Inventário.** Continua com `stock.manage`: é contagem, não ajuste discricionário (o fechamento compara com o
  sistema). Fica registrado como ponto de atenção em §4.
- **Depósitos (D3-5).**
  - Só quem tem `settings.manage` (dono e gerente, com MFA) cadastra e altera.
  - Não há DELETE para a aplicação: depósito se **desativa**.
  - Não pode ser desativado: o padrão, depósito com qualquer saldo, com trânsito chegando, com transferência pendente
    saindo ou com inventário aberto.
- **Inventário por depósito.**
  - Uma contagem aberta por depósito.
  - O saldo do sistema e a diferença são os do `on_hand` daquele depósito.
  - O reservado não muda. Se a contagem ficar abaixo do reservado, o fechamento avisa (o item fica com reserva
    descoberta, como já acontece hoje no total).
  - Bloqueado e avariado não entram na contagem do disponível: têm operações próprias.
- **Alertas (D3-7).**
  - Mínimo: `Vendável(w) < mín`.
  - Máximo: `on_hand(w) + in_transit(w) > máx`.
  - São calculados por uma visão de banco, `stock_location_alerts`, que a tela usa. Uma notificação futura usa a
    mesma visão, sem tabela nova agora.
  - O `products.min_stock` continua como mínimo geral (lista de estoque e reposição).
- **Pedidos da loja (requisito 10).**
  - Reserva, venda e recebimento de compra continuam lançando no depósito padrão, sem escolher depósito.
  - Se a mercadoria tiver sido transferida para outro depósito, a baixa da venda no padrão é recusada com
    `INSUFFICIENT_STOCK` e o nome do depósito, nunca com erro genérico. A tela de transferência avisa disso.

## 2. O que mudou

### 2.1 Banco (`0022_sglog_estoque`)

- **Preparação.** A migração começa com o mesmo padrão de travas da 0020/0021. Ela espera `stock_balances` e pega
  as demais tabelas com `NOWAIT`, tentando de novo a cada 20 ms, com teto de 10 s. Antes de mudar qualquer coisa,
  recusa o banco que não tiver exatamente um depósito padrão ou que tiver mais de uma contagem aberta.
- **Saldos.** `stock_balances` e `stock_location_balances` ganham `blocked`, `damaged` e `in_transit`, com CHECKs
  nomeados (nunca negativos). O gatilho `stock_movements_location` e a guarda diferida `stock_balances_guard` passam
  a cobrir os 5 saldos. O total continua obrigado a ser a soma dos depósitos.
- **Livro (`stock_movements`).**
  - Colunas novas:
    - `blocked_delta`, `damaged_delta` e `in_transit_delta`, com os respectivos `*_after`;
    - `counter_warehouse_id`, `transfer_id`, `document_ref` e `reverses_id`.
  - Tipos novos: `transfer_out`, `transfer_in`, `transfer_loss`, `transfer_return`, `block`, `unblock`,
    `damage_hold`, `damage_release` e `reversal`.
  - Origens novas: `transfer` e `adjustment_request`.
  - Regras do banco:
    - `stock_movements_bucket_shape`: cada tipo só mexe nos saldos que lhe cabem;
    - estorno único (índice em `reverses_id`);
    - gatilho de estorno: o estorno precisa ser o oposto exato do original.
- **Transferências.**
  - `stock_transfers`: número sequencial, situação e `request_key` único.
  - `stock_transfer_items`: enviado, recebido, extraviado e devolvido, com CHECK de "não passa do enviado".
  - `stock_transfer_events`: imutável. O motivo é obrigatório no extravio, na recusa e no cancelamento.
- **Configuração por depósito.** `stock_location_settings` guarda localização, mínimo e máximo (CHECK
  `mín ≤ máx`). A visão `stock_location_alerts` calcula os alertas.
- **Solicitações de ajuste.** `stock_adjustment_requests` tem número sequencial e CHECKs de:
  - sinal da quantidade;
  - decisão completa;
  - movimento ligado só quando aprovada;
  - quatro olhos (quem decide ≠ quem pediu).
- **Inventário.** `inventory_counts.warehouse_id` é preenchido com o padrão nas contagens existentes e depois vira
  `NOT NULL`. Passa a valer uma contagem aberta por depósito. Um gatilho preenche o padrão quando o código antigo não
  informa o depósito (janela de implantação).
- **Depósitos.** O gatilho `warehouses_guard`:
  - impede a aplicação de criar outro padrão, trocar o padrão ou mudar o código;
  - impede desativar depósito em uso.
- **Conferência.** `stock_reconcile()` passa a conferir os 5 saldos (C1–C3) e ganha duas verificações:
  - C6: `in_transit` igual ao pendente das transferências;
  - C7: estornos iguais ao oposto do original.
- **Reversão (`down`).**
  - Recusa, sem mudar nada, se existir qualquer dado da Fase 3: tipo novo no livro, saldo novo diferente de zero,
    transferência, solicitação, contagem fora do padrão ou saldo fora do padrão.
  - Sem dados da Fase 3, restaura as versões da 0020 de `stock_reconcile`, da guarda e do gatilho, e remove o que a
    0022 criou.
- A 0020 e a 0021 **não foram alteradas**.

### 2.2 API

| Rota | Permissão | O que faz |
|---|---|---|
| `GET/POST/PUT /api/v1/admin/warehouses` | ver: `stock.view`; criar e alterar: `settings.manage` (MFA) | Lista com saldos, alertas e o que está chegando. Desativação em vez de exclusão |
| `GET/POST /api/v1/admin/stock-transfers` | ver: `stock.view`; enviar: `stock.transfer` | Envio com `receiveNow` opcional; repetição pela mesma chave devolve o já gravado |
| `POST …/stock-transfers/:id/receive` e `…/return` | `stock.transfer` | Recebimento total (sem itens) ou parcial; recusa com motivo |
| `POST …/stock-transfers/:id/loss` e `…/cancel` | `stock.adjust` (MFA) | Extravio; cancelamento só sem nenhum evento depois do envio |
| `GET /api/v1/admin/stock?warehouseId=&filter=held` | `stock.view` | Saldos de um depósito (ou o total, como antes) |
| `POST /api/v1/admin/stock/movements` | devolução: `stock.manage`; ajuste, perda e avaria: `stock.adjust` (MFA) | Lançamento manual no depósito escolhido (padrão se omitido) |
| `POST /api/v1/admin/stock/holds` | `stock.manage`; baixa do avariado: `stock.adjust` | Bloqueio, liberação, avaria, recuperação e baixa |
| `POST /api/v1/admin/stock/movements/:id/reverse` | `stock.adjust` (MFA) | Estorno com motivo |
| `PUT /api/v1/admin/stock/locations/:warehouseId/:variantId` | `stock.manage` | Localização, mínimo e máximo |
| `GET /api/v1/admin/stock/alerts` | `stock.view` | Alertas de mínimo e máximo |
| `…/stock/adjustment-requests` (+ `approve`, `reject`, `cancel`) | pedir: `stock.manage`; decidir: `stock.adjust` | Quatro olhos; a recusa exige motivo |
| `/api/v1/admin/inventory-counts` | como antes | `warehouseId` na abertura e no filtro; o fechamento devolve `uncoveredReservations` |

As permissões novas são `stock.transfer` e `stock.adjust`; a segunda está na lista de MFA obrigatória.

| Papel | Permissões de estoque |
|---|---|
| Dono e gerente | todas |
| Gerente de logística | `stock.transfer` e `stock.adjust` |
| Estoquista | `stock.transfer` e as que já tinha; ajuste só por solicitação |

### 2.3 Painel

O menu **LOGÍSTICA** agrupa Estoque, Inventário, Transferências (nova), Depósitos (nova), Compras, Reposição e
Fornecedores. URLs e permissões das telas antigas não mudaram. As telas novas e alteradas:

- **Depósitos.** Cartões com os 5 saldos, os alertas e o que está chegando. Cadastro e edição com endereço opcional.
  Desativar e reativar (o padrão não).
- **Estoque.** Filtro por depósito e "bloqueado, avariado ou chegando". Mostra o vendável, a localização e marcas de
  bloqueado, avariado e chegando, com atalhos para solicitações (com contador), alertas e transferir.
- **Detalhe do produto.**
  - Os 6 números: vendável, disponível, reservado, bloqueado, avariado e em trânsito.
  - Quadro por depósito com edição de localização, mínimo e máximo.
  - Bloqueio e avaria.
  - Lançamento manual com depósito. Sem `stock.adjust` com MFA, o botão vira "Enviar para aprovação".
  - Movimentações com depósito, contrapartida, outros saldos, link da transferência e "Estornar" (motivo na própria
    linha).
  - Solicitações pendentes do produto.
- **Transferências.** Lista com filtros, tela de nova transferência e detalhe:
  - a nova transferência busca por nome, SKU ou código de barras, mostra o livre na origem e tem "Já receber agora";
  - o detalhe tem receber tudo ou em parte, recusar, extravio, cancelar e o histórico de eventos.
- **Solicitações de ajuste e Alertas.** Telas próprias com filtros.
- **Inventário.** Escolha do depósito ao abrir a contagem, depósito na lista e no detalhe, e aviso de reserva
  descoberta ao fechar.
- **MFA.** Ações que exigem MFA só aparecem com a verificação ativa, como em Empresa, Fiscal e E-mails.

## 3. Testes

| Verificação | Resultado |
|---|---|
| Suíte da API (25 arquivos) | **381/381** depois do merge (361 anteriores + 20 da Fase 3) |
| Typecheck da API e da web; build de produção da web | Sem erros |
| 0022 em `loja_test` e `loja_dev` (cluster local isolado, porta 54331) | `up`, `down` e `up` sem erro; trava das tabelas de estoque 150–350 ms local |
| Painel no navegador, `loja_dev`, proprietário fictício sem MFA | Ver lista abaixo |

O que `test/sglog-fase3.test.ts` cobre:

- **Depósitos:**
  - quem cadastra (dono e gerente com MFA; estoquista e gerente sem MFA, não);
  - código único;
  - nenhuma exclusão física;
  - desativação recusada com saldo ou transferência pendente.
- **Equações:** o envio tira do vendável da origem e põe em trânsito no destino, sem mudar o total gerencial.
- **Transferências:**
  - recebimento parcial e imediato (dois eventos);
  - mesma origem e destino recusado;
  - reservado ou indisponível não transfere e nada é gravado;
  - **dois envios simultâneos do mesmo saldo: só um passa**, sem negativo;
  - extravio e recusa encerram com divergência;
  - cancelar só sem movimento posterior.
- **Bloqueio e avaria:**
  - saem do vendável e voltam;
  - baixa do avariado exige `stock.adjust`;
  - o banco recusa movimento com forma errada.
- **Estorno:** uma vez só. Não estorna venda, transferência nem saldo já consumido.
- **Solicitações:** o estoquista pede, outra pessoa aprova ou recusa, quem pede não decide. O ajuste direto exige MFA.
- **Inventário:** uma contagem aberta por depósito; o fechamento ajusta só o depósito contado e avisa reserva
  descoberta.
- **Alertas:** mínimo pelo vendável do depósito; máximo pelo disponível mais o que está chegando.
- **Compatibilidade com a loja:**
  - reserva e venda continuam no padrão;
  - falta no padrão é recusada com o nome do depósito;
  - a lista sem depósito continua o total.
- **Privilégios:**
  - a aplicação não grava saldos, eventos nem livro por fora;
  - o histórico é imutável;
  - matriz de papéis.
- **Migração:** a reversão da 0022 recusa quando já houve uso da Fase 3.
- **Conferência:** `stock_reconcile()` sem divergência ao fim dos cenários.

As suítes das Fases 1 e 2, da reposição, do checkout, das compras, da importação e dos marketplaces continuam
verdes. Os únicos testes antigos alterados foram aqueles cujo resultado as decisões aprovadas mudam:

- o ajuste agora exige MFA;
- o gerente de logística ganhou `stock.adjust` e `stock.transfer`;
- a aplicação pode cadastrar depósito (a exclusão continua proibida);
- a "linha sem depósito" passou a "só no depósito padrão".

**Teste manual no painel (local, 16/11/2026).** Feito com o Galpão 2 de demonstração e um envio de 5 UN:

- bloqueio de 2 UN pela tela (vendável −2, bloqueado +2);
- perda pedida pelo proprietário sem MFA, que virou a solicitação nº 1 (só com "Cancelar pedido" para quem pediu);
- recebimento parcial de 3 UN, depois recusa de 2 UN com motivo: "Encerrada com divergência";
- nova transferência de 10 UN recusada ("livre … 3, pedido 10"), depois 1 UN com recebimento imediato, com os dois
  eventos no histórico;
- alertas, solicitações, inventário e depósitos com os dados certos;
- 9 telas sem rolagem horizontal a 375 px;
- `stock_reconcile()` sem divergência no fim.

## 4. Riscos e pontos de atenção

| Risco | Impacto | Mitigação |
|---|---|---|
| A 0022 pega `stock_balances` com exclusividade | Leituras e vendas da loja esperam enquanto a migração roda (150–350 ms local) | Rodar fora do pico; o ensaio na cópia mede o tempo real; o teto de 10 s aborta sem mudar nada |
| Dono e gerente **sem MFA** perdem o ajuste direto na VPS | Ajuste, perda, avaria, estorno, extravio e cancelamento de transferência ficam bloqueados para eles | Ativar a verificação em duas etapas antes de implantar; enquanto isso, usar a solicitação (que outra pessoa com MFA aprova) |
| O Estoquista perde ajuste, perda e avaria diretos | Precisa pedir e esperar aprovação | Decisão D3-2; combinar com a equipe quem aprova |
| Fechamento de inventário continua com `stock.manage` | O Estoquista ainda corrige saldo pela contagem, sem aprovação | Decisão registrada em §1.4; rever se a equipe preferir aprovação também no inventário |
| Reservas e vendas continuam no depósito padrão (até a Fase 4) | Se a mercadoria for toda transferida para outro depósito, a venda no site é recusada com `INSUFFICIENT_STOCK` (com o nome do depósito) | A tela de transferência só envia o livre (não toma reservado); manter no padrão o que se vende |
| Custo médio passa a ponderar sobre o total gerencial | Pequena diferença no custo médio de quem tem bloqueado, avariado ou em trânsito | É o correto para a empresa como um todo; o custo continua igual onde só há disponível |
| O depósito padrão não pode ser trocado nesta fase | — | Volta na Fase 4 |
| Reversão depois de uso | O `down` recusa; voltar ao estado anterior só com backup | Preferir voltar só o código (a API anterior não conhece os saldos novos, mas não grava neles) e corrigir para a frente |
| `/me` lista permissões que exigem MFA mesmo sem ela | Já era assim; o painel esconde as ações, e a API recusa | Sem mudança de comportamento em relação às fases anteriores |

## 5. Implantação (quando autorizada, só por você)

Nada foi executado no servidor. Os comandos prontos, na ordem, estão em
[21-sglog-fase3-implantacao.md](21-sglog-fase3-implantacao.md). Resumo:

1. **Antes.**
   - Ativar a verificação em duas etapas do dono e do gerente.
   - Confirmar `schema_migrations` terminando em `0021_sglog_fornecedores`.
2. **Backup e ensaio.** `npm run backup`, `backup:verify` e `node scripts/backup.mjs migrate-rehearsal <pasta>` na
   cópia restaurada. Anotar:
   - o tempo de trava;
   - os avisos da 0022 (depósitos, contagens preenchidas e resumo dos saldos);
   - a conferência sem divergência.
3. **Integrar.** Merge de `sglog/fase3` na `main`, quando autorizado.
4. **Aplicar.** Atualizar o código, aplicar a 0022 fora do pico e fazer o build de API e web. Reiniciar os serviços
   **como root**.
5. **Validar (etapa F estendida).**
   - Usar o bloco da [etapa F da Fase 1](16-sglog-fase1-implantacao.md#etapa-f--validação-depois-da-0020), com a
     última migração esperada `0022_sglog_estoque`.
   - Somar também `blocked`, `damaged` e `in_transit` (total = soma dos depósitos).
   - A conferência deve terminar com 0 divergência, agora incluindo C6 e C7.
   - Depois, o roteiro do painel em [TESTES-PENDENTES.md](TESTES-PENDENTES.md#sglog-fase-3--estoque-por-depósito-20-sglog-fase3md).
6. **Se algo falhar.**
   - Antes de concluir: a 0022 é desfeita inteira e nada muda.
   - Depois, sem uso: `npm run migrate -- down`.
   - Depois, com uso: voltar só o código e corrigir para a frente. Backup só com autorização expressa.

## 6. Fora desta fase

- escolha de depósito por pedido, reserva por depósito e troca do padrão (Fase 4);
- notificações por WhatsApp ou e-mail (D3-7);
- etiquetas e endereçamento físico detalhado.
