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
  sistema). Fica registrado como ponto de atenção em §5.
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
  - São calculados por uma função de banco, `stock_location_alerts()`, que a tela usa. Uma notificação futura usa a
    mesma função, sem tabela nova agora.
  - O `products.min_stock` continua como mínimo geral (lista de estoque e reposição).
- **Pedidos da loja (requisito 10).**
  - Reserva, venda e recebimento de compra continuam lançando no depósito padrão, sem escolher depósito.
  - Se a mercadoria tiver sido transferida para outro depósito, a baixa da venda no padrão é recusada com
    `INSUFFICIENT_STOCK` e o nome do depósito, nunca com erro genérico. A tela de transferência avisa disso.
