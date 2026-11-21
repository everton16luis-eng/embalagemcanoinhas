# SGLog — Fase 8: planejamento (fretes, transportadoras, etiquetas, rastreamento e custos logísticos)

**Situação: proposta para análise. Nada implementado.** Base: `main` em `b052761`. Na VPS roda `e057df4`, com a 0026
aplicada e a Fase 7 concluída funcionalmente em 20/11/2026.

Continuam como estão nesta fase:
- `ALLOCATION_AUTO` desligado;
- dropshipping e remessas múltiplas bloqueados;
- checkout, pagamentos, NF-e e marketplaces sem mudança;
- estoque e remessas: separação, conferência, embalagem, despacho e baixa de estoque da Fase 5 sem mudança.

Nada aqui contrata frete ou compra etiqueta de verdade. A compra real fica desligada até sua autorização expressa
(restrição permanente da [Fase 0](sglog-fase0-auditoria.md)).

## 1. Escopo original e o que já foi entregue

### 1.1 O que o plano geral previa ([sglog-fase0-auditoria.md](sglog-fase0-auditoria.md) §5.8 e §7)

> Fretes: adaptadores (manual mais Fake; Melhor Envio só cotação com origem real), fila `integration_jobs`, webhooks,
> rastreio deduplicado, aviso por remessa. **Contratação e etiqueta reais só com sua autorização.**

| Item previsto | Detalhe |
|---|---|
| Migração `0027_sglog_frete` | `carrier_providers`, `shipping_quotes`, `shipping_labels`, `shipments.label_id`, `integration_jobs`, `integration_logs`, `logistics_webhook_events` |
| Permissão | `shipping.labels`, com MFA, porque gasta dinheiro |
| Casos obrigatórios | 11 (falha na contratação), 12 (falha na etiqueta), 13 (rastreio duplicado) e 18 (recuperação após falha de integração) |

**O que as fases seguintes deixaram para a Fase 8:**
- **Fase 3 (D3-7):** aviso ativo de estoque mínimo pela fila de integrações.
- **Fase 4 (D4-6):** frete por origem e escolha de depósito pelo custo do frete.
- **Fase 5:**
  - cotação por origem, contratação, etiqueta e rastreio automático;
  - os estados `in_transit` e `out_for_delivery`, que existem no banco sem tela.
- **Fase 5 (D5-3):** mais de um depósito por pedido, que depende de frete por origem.
- **Fases 6 e 7:** frete e etiqueta.

**O que fica com outras fases:**
- **Fase 9:** `delivery_failed` e `returned`, ocorrências e logística reversa.
- **Fase 10:** custos completos e margem (taxas de pagamento, embalagem, alíquotas e visões de margem).

### 1.2 O que já existe e esta fase reaproveita

| Área | Já existe | Onde |
|---|---|---|
| Formas de entrega | `shipping_options`: retirada, entrega própria por faixa de CEP e peso, e transportadora (`carrier_service` do Melhor Envio, `handling_days`) | 0005, 0010, Fase 8 antiga ([08](08-whatsapp-transportadoras-relatorios.md)) |
| Cotação na loja | `CarrierProvider` com `MelhorEnvioProvider` (só `/me/shipment/calculate`) e `FakeCarrier`; cache de 30 min; seguro pelo valor dos itens | `lib/carriers.ts` |
| Origem da cotação | Sempre o CEP da empresa, ou `SHIP_FROM_CEP` | `originCep()` |
| Frete cobrado | `orders.freight_cents` e `shipping_snapshot`, gravados no checkout | 0005 |
| Remessas | Várias por pedido (bloqueadas na operação), `warehouse_id`, volumes em `packages` (peso e medidas por volume), situações até `delivered`, com `in_transit` e `out_for_delivery` reservados | 0024 |
| Histórico da remessa | `shipment_events` imutável, com `source` `carrier` e `provider_event_id` único por remessa: rastreio duplicado já é ignorado | 0024 |
| Despacho | Exige NF-e autorizada ou dispensada; grava transportadora, código e link de rastreio **à mão**; baixa o estoque | `shipments.ts` |
| Aviso ao cliente | WhatsApp `order_shipped` por remessa, com rastreio; página do pedido mostra o rastreio | `whatsapp.ts`, `order-view.tsx` |
| Marketplaces | Frete, etiqueta e rastreio ficam com o marketplace (D4). A remessa só registra o código | `kind = 'marketplace'` |
| Credenciais | `MELHOR_ENVIO_TOKEN`, `MELHOR_ENVIO_USER_AGENT` e `MELHOR_ENVIO_SANDBOX` no `.env`; `CARRIER_FAKE` proibido em produção | `config.ts` |

**Situação na VPS, que condiciona a fase:**
- não há conta nem token do Melhor Envio (pendência em [TESTES-PENDENTES](TESTES-PENDENTES.md), "WhatsApp e
  transportadoras");
- a empresa ainda não tem CNPJ nem endereço cadastrado.

**Consequências:**
- hoje nenhuma cotação por transportadora aparece na loja, porque não há origem nem provedor;
- etiqueta real de pessoa jurídica depende de NF-e, e o despacho já exige NF-e autorizada.

## 2. Funcionalidades ainda necessárias

### A. Provedor de frete completo, atrás da interface atual

`CarrierProvider` ganha operações opcionais, e cada adaptador declara o que suporta:

| Operação | Manual | Fake | Melhor Envio |
|---|---|---|---|
| Cotar (`quote`) | — | sim | sim (já existe) |
| Comprar etiqueta (`buyLabel`) | — | sim, com falhas simuladas | **desligado** até autorização (D8-3) |
| Imprimir etiqueta (`printLabel`) | — | PDF de exemplo | desligado |
| Cancelar etiqueta (`cancelLabel`) | — | sim | desligado |
| Rastrear (`track`) | — | eventos simulados, inclusive duplicados | consulta de rastreio (D8-5) |

Os endpoints reais de compra, impressão, cancelamento, rastreio e webhooks do Melhor Envio são conferidos na
documentação oficial **antes** de escrever o adaptador. A renovação do token (30 dias) segue pendente desde a Fase 8
antiga. Nada é presumido.

### B. Cotação da remessa no painel (frete real com volumes reais)

- Na remessa embalada, o botão "Cotar frete" usa:
  - a origem do **depósito** da remessa, com o endereço da Fase 7;
  - os volumes **medidos na embalagem** (`packages`), e não as medidas do cadastro.
- Mostra as opções com preço, prazo e transportadora, ao lado do **frete cobrado do cliente**, com a diferença.
- A cotação fica guardada (`shipping_quotes`) com validade. A escolhida vira o serviço da remessa.
- Retirada e marketplace não cotam.

### C. Etiqueta (preparada, compra real desligada)

- Estados: `requested` → `purchased` → `printed`, ou `canceled`, ou `failed`.
- Cada pedido de compra tem uma `idempotency_key`: clicar duas vezes, ou repetir depois de uma falha, nunca compra
  duas vezes.
- Para comprar, é preciso:
  - remessa `packed`, com volumes medidos;
  - NF-e autorizada, com a chave enviada ao transportador quando ele exigir;
  - cotação válida escolhida;
  - permissão `shipping.labels` com MFA.
- A compra roda na fila (item E), não na requisição. A tela acompanha a situação.
- O código de rastreio e o custo vêm da etiqueta e são gravados na remessa. O despacho continua manual: a etiqueta
  não despacha sozinha.
- O cancelamento só vale antes da postagem, com registro do motivo. O reembolso segue a regra do provedor, e o SGLog
  só registra.
- Com a compra desligada, a tela mostra "Etiqueta pelo painel do transportador". O operador informa o código e o
  custo à mão, como hoje.

### D. Rastreamento

- **Entrada dos eventos:**
  - consulta periódica (fila, a cada N horas) das remessas despachadas com rastreio no provedor;
  - **webhook** do provedor, quando houver, com assinatura conferida.
- **Gravação:** os eventos entram em `shipment_events` (`source = 'carrier'`), deduplicados por `provider_event_id`,
  e projetam a remessa:
  - `shipped` → `in_transit` → `out_for_delivery` → `delivered`;
  - `delivered` usa a projeção que já existe para o pedido (`projectOrder`).
- **Nunca volta situação:** evento atrasado ou fora de ordem fica no histórico sem rebaixar a remessa.
- **Falhas de entrega:** "falha na entrega" e "devolvido" ficam registrados como evento, sem mudar a situação. O
  tratamento é na Fase 9.
- **Rastreio manual:** a transportadora sem integração continua com código e link informados à mão. "Marcar
  entregue" continua manual.

### E. Fila de integrações (`integration_jobs`)

- Uma fila no banco, na rotina de 60 s, com:
  - `FOR UPDATE SKIP LOCKED`;
  - novas tentativas espaçadas;
  - limite de tentativas, depois `dead`;
  - reprocessamento manual pelo painel.
- `integration_logs` guarda operação, código HTTP, duração e resultado. **Sem corpo e sem dados pessoais.**
- Primeiros tipos de tarefa: compra de etiqueta, cancelamento e consulta de rastreio.
- O WhatsApp continua na fila própria, que já funciona.

### F. Custos logísticos (registro, sem margem)

- A remessa passa a guardar o **custo real do frete**:
  - da etiqueta, quando comprada pelo sistema;
  - informado à mão no despacho, quando comprada fora;
  - com a origem do valor (`label` ou `manual`).
- **Relatório "Frete cobrado × frete pago"** por período, transportadora e serviço, com:
  - frete cobrado do cliente (`orders.freight_cents`, rateado quando houver mais de uma remessa);
  - custo pago;
  - diferença;
  - remessas sem custo informado.
- **Fora daqui:** custo de embalagem, taxa de pagamento e margem ficam na Fase 10, que usa estes dados.

### G. Painel e cliente

- **Logística → Fretes:**
  - remessas a cotar;
  - etiquetas por situação;
  - rastreios parados há X dias (alerta interno);
  - fila de integrações com erros e reprocessamento.
- **Remessa:** cotação, etiqueta, custo e linha do tempo do rastreio.
- **Cliente:** a página do pedido mostra a linha do tempo do rastreio por remessa (situação e data, sem dados internos).
- **Aviso ao cliente:** os avisos "saiu para entrega" e "entregue" por WhatsApp só valem se você aprovar (D8-8). Cada
  um precisa de um modelo aprovado na Meta.

### Fora da Fase 8

- Escolha automática de depósito pelo custo do frete, e vários depósitos por pedido. Dependem de remessas múltiplas,
  que continuam bloqueadas.
- Logística reversa, devolução e ocorrências: Fase 9.
- Margem, custo de embalagem e taxas: Fase 10.
- Frete de marketplace (D4) e de dropshipping, que está bloqueado.
- Aviso de estoque mínimo pela fila: possível depois, porque a fila fica pronta (D8-10).

## 3. Regras de negócio

1. **Dinheiro só com autorização.** A compra real de etiqueta exige três coisas ao mesmo tempo:
   - `SHIPPING_LABELS_ENABLED=true` no `.env`;
   - `logistics_settings.label_status = 'enabled'`, com quem validou e quando;
   - `shipping.labels` com MFA.

   O padrão é tudo desligado.
2. **Limite por etiqueta.** Uma etiqueta acima de `label_max_cents` exige justificativa. O valor de produção é decisão
   sua (D8-6).
3. **Idempotência.**
   - Uma etiqueta ativa por remessa: o índice único parcial impede a segunda.
   - `idempotency_key` única.
   - Uma tarefa de compra repetida consulta o provedor antes de comprar de novo.
4. **Pré-condições da etiqueta:** remessa embalada, volumes medidos, NF-e autorizada, cotação válida, depósito com
   endereço completo, e destinatário com os dados que o transportador exige.
5. **Dados enviados ao transportador:** só o necessário para entregar: nome, endereço, telefone e documento quando
   exigido. Nada disso vai para logs.
6. **Rastreio nunca rebaixa a situação.** Evento duplicado é ignorado. Evento de entrega projeta o pedido pela regra
   atual.
7. **O despacho continua manual.** A etiqueta não baixa estoque nem despacha. O estoque só muda no despacho, como na
   Fase 5.
8. **Custo.** O custo da etiqueta comprada é o custo real. No modo manual, o custo é opcional no despacho, e a falta
   de custo aparece no relatório. A cotação nunca é tratada como custo.
9. **Webhook.**
   - Só é aceito com assinatura válida.
   - É deduplicado por `(provider, dedupe_key)`.
   - É gravado antes de processar.
   - Responde rápido e processa na fila.
10. **Marketplace e retirada** não cotam, não compram etiqueta e não são rastreados pelo SGLog.
11. **Permissões:**
    - `shipping.labels` (nova, com MFA) compra e cancela etiqueta;
    - `shipping.manage` cota e informa custo e rastreio manual;
    - `logistics.manage` reprocessa a fila.

    Os papéis estão em D8-7.

## 4. Custos operacionais e dependências externas

| Item | Custo | Dependência |
|---|---|---|
| Servidor | Nenhum novo: mesma VPS, mesma rotina de 60 s, sem fila externa | — |
| Cotação Melhor Envio | **A confirmar no contrato.** A cotação de hoje não cobra por chamada pelo que foi documentado; conferir limite de requisições | Conta, aplicativo OAuth, token e User-Agent com e-mail técnico |
| Etiqueta Melhor Envio | **Pago por etiqueta**, com o saldo da conta no provedor. Preço = frete do serviço; condições e reembolso de cancelamento **a confirmar** | Saldo na conta, CNPJ, NF-e autorizada, endereço de origem |
| Alternativas (Frenet, Kangu, contrato direto com Correios ou Jadlog) | Variam (mensalidade, contrato, volume mínimo) | Contrato próprio; adaptador novo pela mesma interface |
| WhatsApp para os novos avisos | Por conversa, pela tabela da Meta, se D8-8 for aprovada | Modelos aprovados |
| Seu tempo | Cadastrar medidas e peso das variações, CEP e endereço; validar o sandbox | — |

**Dependências que bloqueiam o uso real** (o código pode ser feito e testado com o Fake antes delas):
- CNPJ e endereço da empresa, que também bloqueiam o pedido ao fornecedor da Fase 7;
- NF-e de venda em produção, porque o despacho já a exige;
- conta no Melhor Envio, com token, sandbox validado e renovação do token conferida;
- peso e medidas das variações e caixas reais medidas na embalagem.

## 5. Riscos técnicos

| # | Risco | Tratamento |
|---|---|---|
| R1 | **Compra duplicada** (clique duplo, nova tentativa, queda no meio) | Chave de idempotência, etiqueta ativa única, compra na fila com consulta antes de repetir; caso 12 |
| R2 | **Token vence (30 dias)** e a renovação não está documentada publicamente | Alerta no painel antes de vencer; cotação falha devolve lista vazia, como hoje; renovação conferida antes de ligar |
| R3 | **Provedor fora do ar ou lento** | Tempo limite de 8 s; fila com novas tentativas e `dead`; a remessa não muda de situação por falha; casos 11 e 18 |
| R4 | **Webhook falso ou repetido** | Assinatura, deduplicação, gravação antes de processar; sem assinatura, só a consulta periódica |
| R5 | **Rastreio fora de ordem** | Situação só avança; evento antigo fica só no histórico |
| R6 | **Dados pessoais em logs** | Logs sem corpo; erros com até 500 caracteres, sem endereço nem documento |
| R7 | **Cotação ≠ custo final** (medidas reais, taxas) | Custo só da etiqueta ou informado; diferença no relatório |
| R8 | **Medidas ruins no cadastro** | A remessa usa os volumes medidos; variação sem medida continua sem cotação na loja |
| R9 | **Travas na `shipments`**, tabela quente da expedição | Migração aditiva, técnica de bloqueio da 0020–0026, ensaio em cópia |
| R10 | **Fuso** | Prazos e "parado há X dias" pelo fuso da loja (correção de 20/11/2026) |
| R11 | **Mudança de API do provedor** | Adaptador isolado com Fake e testes de contrato pelos exemplos da documentação |
| R12 | **Etiqueta comprada e remessa cancelada** | Cancelar a remessa com etiqueta ativa exige cancelar a etiqueta antes, ou registrar a perda com motivo |

## 6. Migração prevista: `0027_sglog_frete`

Ela é aditiva e compatível com o código atual (`e057df4`), inclusive na escrita, como a 0025 e a 0026. O ensaio é
feito em cópia restaurada, e a reversão é recusada depois do uso.

| Mudança | Conteúdo |
|---|---|
| `logistics_settings` | `label_status` (`blocked` padrão), quem validou e quando, `label_max_cents`, `tracking_poll_hours` (padrão 6) |
| `shipments` (colunas novas, nulas ou com padrão) | `carrier_provider`, `carrier_service`, `freight_cost_cents`, `freight_cost_source` (`label`, `manual`), `label_id`, `last_tracked_at` |
| `shipping_quotes` | Por remessa: provedor, serviço, transportadora, preço, prazo, CEP de origem e destino, volumes usados, validade, escolhida, autor |
| `shipping_labels` | Remessa, provedor, serviço, id externo, situação, custo, `idempotency_key` UNIQUE, rastreio, erro, autor e datas; uma ativa por remessa |
| `shipping_label_events` | Imutável: cada mudança da etiqueta |
| `integration_jobs` | Tipo, referência, `idempotency_key` UNIQUE, situação, tentativas, próxima tentativa, último erro (≤ 500, sem dados pessoais) |
| `integration_logs` | Imutável: provedor, operação, HTTP, duração, ok; sem corpo |
| `logistics_webhook_events` | Provedor, `dedupe_key`, carga (sem expor no painel), assinatura válida, processado, erro; `UNIQUE (provider, dedupe_key)` |

**Ajustes ao plano original:**
- `carrier_providers` **sai**. Os provedores e o que cada um suporta ficam no código, e as credenciais só no `.env`,
  como hoje. Uma tabela só duplicaria a configuração.
- `shipment_events` não muda: `source = 'carrier'` e `provider_event_id` já existem desde a 0024.
- A permissão `shipping.labels` entra só no código, como as anteriores.

Não mudam:
- `stock_reconcile()` (C1–C13), as reservas e os movimentos;
- checkout, `orders`, pagamentos, NF-e e marketplaces.

## 7. Decisões que precisam da sua aprovação

| # | Decisão | Recomendação |
|---|---|---|
| **D8-1** | Provedor | **Melhor Envio**, que já está no código e cota várias transportadoras num contrato só. Os outros ficam possíveis pela mesma interface |
| **D8-2** | Escopo desta fase | Ponta a ponta com o **Fake**; cotação da remessa com o provedor real (só leitura); rastreio; custo manual; relatório. A **compra real de etiqueta fica pronta e desligada** |
| **D8-3** | Ligar a compra real de etiqueta | **Não nesta fase.** Ligar depois, com CNPJ, NF-e em produção, saldo na conta, teste no sandbox e sua autorização expressa |
| **D8-4** | Origem da cotação da remessa | O **depósito** da remessa, com o endereço da Fase 7. A loja continua cotando pela empresa até haver mais de um depósito em uso |
| **D8-5** | Rastreio automático | **Consulta a cada 6 h**, mais o webhook quando o provedor oferecer e a assinatura for conferida. Rastreio manual continua |
| **D8-6** | Limite por etiqueta (`label_max_cents`) | Criar com **R$ 0 = sem limite** enquanto a compra estiver desligada; o valor de produção é seu |
| **D8-7** | Quem compra etiqueta (`shipping.labels`, MFA) | Proprietário, Gerente e Logística. Expedição cota e informa à mão, mas não compra |
| **D8-8** | Novos avisos ao cliente ("saiu para entrega", "entregue") | **Não nesta fase.** A página do pedido mostra a linha do tempo; o WhatsApp continua só no despacho |
| **D8-9** | Custo real no despacho manual | **Opcional**, com alerta no relatório quando faltar. Obrigatório só depois que a etiqueta pelo sistema estiver ligada |
| **D8-10** | Aviso de estoque mínimo pela fila (D3-7) | **Fora**: fica para depois, aproveitando a fila |
| **D8-11** | Remessa com etiqueta ativa cancelada | Exigir cancelar a etiqueta antes; se o provedor recusar, registrar a perda com motivo |
| **D8-12** | Migração `0027_sglog_frete` aditiva, compatível e com ensaio em cópia, sem `carrier_providers` | **Sim**, como D7-12 |

## 8. Testes previstos

- **Fila:**
  - casos 11, 12, 13 e 18 do plano geral;
  - duas compras concorrentes da mesma remessa resultam em uma etiqueta.
- **Etiqueta:**
  - pré-condições (situação, volumes, NF-e, cotação, endereço);
  - MFA e permissões por papel;
  - limite com justificativa;
  - compra desligada recusa no servidor (não só na tela).
- **Rastreio:**
  - avanço, duplicado, fora de ordem e entregue projetando o pedido;
  - falha de entrega sem mudar a situação;
  - webhook com assinatura inválida recusado.
- **Custos:** custo da etiqueta e manual; relatório cobrado × pago com rateio e sem custo.
- **Compatibilidade e regressão:**
  - o código anterior contra a 0027 (suíte inteira);
  - migração subir, descer e subir;
  - C1–C13 sem divergência;
  - nenhum movimento de estoque fora do despacho;
  - regressão das Fases 1–7.
- **Telas:** Fretes, remessa e página do pedido, em desktop e 375 px.

## 9. Estimativa

| Parte | Tamanho |
|---|---|
| Migração e ensaio | pequeno |
| Interface do provedor, Fake e adaptador (cotação e rastreio; etiqueta desligada) | médio |
| Fila de integrações e webhooks | médio |
| Cotação da remessa, etiqueta e custo (API e telas) | médio |
| Rastreio e página do cliente | pequeno a médio |
| Relatório cobrado × pago | pequeno |
| Testes e documentação | médio |

Uma fase do porte da Fase 6, sem gasto real, porque a compra fica desligada.
