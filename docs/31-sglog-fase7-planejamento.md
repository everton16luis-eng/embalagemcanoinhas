# SGLog — Fase 7: planejamento (abastecimento e solicitações a fornecedores)

**Situação: proposta para análise. Nada implementado.** Base: `main` em `5a07198` (Fase 6 implantada e validada na VPS
em 20/11/2026), mais os commits locais de documentação `21a0d60` e `85c4d3f`.

Continuam como estão, nesta fase:
- `ALLOCATION_AUTO` desligado;
- dropshipping e remessas múltiplas bloqueados;
- checkout, pagamentos, NF-e e marketplaces sem mudança.

## 1. Escopo original e o que já foi atendido

### 1.1 O que o plano geral previa

Fonte: [sglog-fase0-auditoria.md](sglog-fase0-auditoria.md), §3 (itens 7 e 8), §5.7 e §7.

| Item original da Fase 7 | Onde está hoje |
|---|---|
| Fila de separação | **Fase 5** (D5-1) |
| Checklist de conferência obrigatório (`shipment_checks`) | **Fase 5**, migração 0024 |
| Volumes e peso | **Fase 5**: volumes da remessa, mais os totais `volumes` e `weight_g` |
| Postagem manual (transportadora e rastreio digitados) | **Fase 5** |
| Solicitação ao fornecedor: **gerar** | Em parte. O pedido de compra existe, mas não há documento para enviar |
| Solicitação ao fornecedor: **copiar e imprimir** | **Falta** |
| Solicitação ao fornecedor: **confirmar** (confirmação manual do fornecedor) | **Falta**. Hoje só existe "Marcar como enviado" |
| Solicitação ao fornecedor: **rastreio** | **Fase 6**: transportadora e código, à mão |
| Solicitação ao fornecedor: **divergência** | Em parte. A **Fase 6** cobre a divergência no recebimento (quantidade, qualidade, preço, item errado). Falta a divergência na **confirmação**, antes de a mercadoria chegar |
| Tabelas `supplier_requests` e `supplier_request_events` (8 estados) | Não criadas. Ver D7-1 |

### 1.2 O que outras fases já entregaram e esta reaproveita

- **Fase 2**:
  - ofertas por fornecedor, com prazo (`lead_time_days`), histórico de preço e disponibilidade com validade;
  - contatos com e-mail e WhatsApp.
- **Fase 3**: mínimo e máximo por depósito, alertas de estoque e sugestão de reposição. A sugestão já cria pedidos de
  compra em rascunho.
- **Fase 4**: alocação "comprar para atender" (`purchase_to_order`). A reserva fica como encomenda até a mercadoria
  chegar.
- **Fase 6**:
  - finalidade da compra, depósito de destino, aprovação (limite R$ 0, MFA, quem cria não aprova);
  - pagamento informado, rastreio manual e histórico imutável (`purchase_order_events`);
  - vínculo entre encomenda e compra, divergências do recebimento e conversão das encomendas na chegada.
- **Notas de compra (XML)**: já comparam a nota com o pedido de compra vinculado, item a item (quantidade e preço),
  só na tela.

**Conclusão.** Na Fase 6, a encomenda passou a ser atendida por um **pedido de compra** de finalidade "Atender
encomendas", vinculado aos pedidos dos clientes. A "solicitação ao fornecedor" do plano original tinha exatamente
esse papel: pedir ao fornecedor o que falta para um pedido. Criar `supplier_requests` agora seria um segundo caminho
paralelo à compra para a mesma mercadoria. A proposta (D7-1) é que a solicitação ao fornecedor seja o **documento e o
acompanhamento do próprio pedido de compra**.

## 2. Funcionalidades ainda necessárias

### A. Documento do pedido ao fornecedor (gerar, copiar, imprimir)

- **Versão para imprimir ou salvar em PDF pelo navegador**, numa página própria, legível em A4 e a 375 px. Contém:
  - os dados da empresa (razão social, CNPJ e endereço, do cadastro da empresa);
  - o depósito de entrega, com o endereço do depósito;
  - os itens com o código do fornecedor (oferta), a embalagem, a quantidade, o custo e o subtotal;
  - frete e despesas, o total, a previsão e as observações.
- **Texto para copiar**, pronto para colar no WhatsApp ou no e-mail do fornecedor.
- **Versão imutável do que foi enviado:**
  - cada geração depois da aprovação grava uma cópia (`purchase_order_documents`, versão 1, 2, …);
  - "Marcar como enviado" passa a registrar o canal (impresso, e-mail, WhatsApp, telefone ou portal do fornecedor) e
    a versão enviada;
  - se a compra voltar para rascunho e for aprovada de novo, o próximo envio gera uma nova versão.
- **Só de compra aprovada ou enviada.** Rascunho e "aguardando aprovação" não geram documento para o fornecedor, só
  uma prévia marcada "não enviar".

### B. Confirmação do fornecedor

- **Situação da confirmação**, separada da situação da compra:
  - nenhuma;
  - aguardando confirmação (depois do envio);
  - confirmado;
  - confirmado com alteração;
  - recusado pelo fornecedor.
- **O que se registra:** quem registrou, quando, o canal e a referência do fornecedor (número do pedido dele). Por
  item, se houver diferença:
  - quantidade confirmada;
  - custo confirmado;
  - data prometida de despacho ou de entrega.
- **Confirmação com alteração** gera divergência de confirmação no histórico imutável. Tipos:
  - quantidade a menor;
  - preço diferente;
  - prazo diferente;
  - item indisponível.

  O que fazer com preço ou quantidade alterados fica nas decisões D7-4 e D7-5.
- **Recusa do fornecedor:** a compra não é cancelada sozinha. A tela oferece cancelar com motivo, e os vínculos de
  encomenda são liberados com pendência no pedido do cliente, como no encerramento com falta (D6-8).
- **Correção:** é um novo registro, nunca edição, como nas divergências da Fase 6.

### C. Acompanhamento de abastecimento

Página nova, **Logística → Abastecimento** (ou aba em Compras: D7-10), só de leitura e de registro de contato:
- **Sem confirmação:** enviadas há mais de N dias (D7-8) sem confirmação do fornecedor.
- **Atrasadas:** a data prometida, ou na falta dela a previsão de entrega, já passou e ainda há item pendente.
- **A caminho por produto e depósito:** o que vem, de qual compra e com que previsão.
- **Encomendas afetadas:**
  - pedidos de clientes vinculados a compras atrasadas, recusadas ou com quantidade confirmada a menor;
  - encomendas ainda sem nenhuma compra vinculada.
- **Cobranças ao fornecedor:** "Registrar contato" grava no histórico da compra o canal, a observação e a data
  combinada para o próximo contato. Não envia nada ao fornecedor.
- **Desempenho do fornecedor** (só leitura, últimos 90 dias):
  - entregas no prazo;
  - prazo real médio comparado com o cadastrado;
  - divergências por tipo;
  - taxa de confirmação.

### D. Solicitações internas de compra (requisições)

Hoje quem precisa de mercadoria fala com o comprador fora do sistema, ou o comprador usa a sugestão de reposição. A
proposta é uma requisição simples (D7-6):
- **Quem pede:** registra produto, embalagem (opcional), quantidade, depósito, motivo e "preciso até".
- **Quem compra:**
  - vê as requisições abertas, agrupadas por fornecedor principal;
  - "Gerar compra" junta várias requisições do mesmo fornecedor num rascunho de compra, ou as acrescenta a um
    rascunho existente;
  - recusa uma requisição com motivo.
- **Situações da requisição:** aberta, em compra, recusada, cancelada e atendida. Fica atendida quando a compra é
  recebida.
- **Encomenda sem compra:** a alocação "comprar para atender" sem vínculo pode virar requisição de origem
  "encomenda" (D7-7). Ao virar compra, a requisição já cria o vínculo encomenda × compra da Fase 6, sem tela extra.
- **Alerta de mínimo:** continua na sugestão de reposição, que já cria compras. Opcionalmente, o alerta vira
  requisição (D7-7).
- **Sem efeito no estoque:** a requisição não reserva nem movimenta nada.

### E. Integrações com o que já existe

- **Nota de compra (XML) vinculada:**
  - pré-preenche o formulário de recebimento com a quantidade e o custo da nota, como sugestão editável (D7-11);
  - a conferência e a entrada continuam manuais, pelo recebimento da Fase 6.
- **Detalhe logístico do pedido do cliente:** mostra a confirmação e a data prometida da compra vinculada, ou
  "compra atrasada", só para a equipe. Nada aparece para o cliente nesta fase (D7-9).
- **Reposição:** a sugestão passa a descontar o que já está em requisição aberta, para não pedir em dobro.
- **Painel inicial:** contadores de compras sem confirmação, atrasadas e requisições abertas, para quem tem
  `purchases.view`.
- **E-mail ao fornecedor** pelo servidor de e-mail existente: modelado e **desligado** (D7-2).

### Fora da Fase 7

- **Dropshipping** (solicitação para o fornecedor despachar ao cliente): continua travado (D3).
- **Frete:** cotação, contratação e etiqueta ficam na Fase 8.
- **Devolução ao fornecedor** do recusado ou avariado, ocorrências e reembolso ficam na Fase 9.
- **Margem e custos** ficam na Fase 10.
- **Portal do fornecedor e API com fornecedores:** sem fase.
- **Separação, conferência, volumes e expedição:** já entregues na Fase 5 e não são refeitos.

## 3. Regras de negócio

1. **Estoque e reconciliação.** Nada da Fase 7 movimenta estoque. As entradas continuam só pelo recebimento da Fase 6,
   e a reconciliação C1–C13 não muda.
2. **Documento enviado é imutável.** Cada versão guarda o conteúdo exato e um hash. A tela mostra qual versão foi
   enviada e por qual canal.
3. **Ordem da confirmação.** Só depois de "enviado" e antes do recebimento total. A confirmação não é obrigatória
   para receber (D7-3); sem ela, a compra aparece em "sem confirmação".
4. **Confirmação com alteração**:
   - quantidade confirmada menor que a vinculada a encomendas: os vínculos excedentes são liberados com pendência,
     sem cancelar o pedido do cliente (como D6-8). A ordem de quem perde é a inversa da prioridade da Fase 6;
   - preço ou total confirmado acima do aprovado, além da tolerância (D6-12): ver D7-4;
   - a quantidade pedida não muda sozinha. A compra guarda a quantidade pedida e a confirmada, e a pendência de
     recebimento usa a menor (D7-5).
5. **Atraso.** Há item pendente e a data de referência passou. A data de referência é a prometida do item, ou a
   prometida da compra, ou a previsão (`expected_at`). Sem nenhuma delas, a compra não conta como atrasada, mas pode
   aparecer em "sem confirmação".
6. **Requisições**:
   - **idempotentes:** a mesma requisição não vira item de duas compras;
   - **uma por encomenda:** uma alocação de encomenda tem no máximo uma requisição aberta;
   - **depósito de destino:** a requisição só entra numa compra para o mesmo depósito (D6-6);
   - **cancelamento da compra:** a requisição volta para "aberta" e não se perde.
7. **Ordem das travas** (mesma da Fase 6): compra → itens → requisições, em ordem de id. Nenhuma trava em estoque ou
   no pedido do cliente.
8. **Permissões**:

   | Permissão | O que libera | Quem tem (proposta, D7-6) |
   |---|---|---|
   | `purchases.request` (nova) | Abrir e cancelar a própria requisição | Estoquista, Logística, Gerente e Proprietário |
   | `purchases.manage` (existente) | Gerar documento, enviar, registrar confirmação e contato, e consolidar requisições em compra | Comprador, Gerente e Proprietário |
   | `purchases.approve` com MFA (existente) | Aprovar a alteração de preço da confirmação, se D7-4 for "reaprovar" | Gerente e Proprietário |
   | `purchases.view` (existente) | Ver Abastecimento e o desempenho do fornecedor | Quem já vê compras |

9. **Auditoria.** Todas as ações vão para a auditoria e para o histórico imutável da compra ou da requisição.
10. **Dados no documento.** O documento leva os dados da empresa e do depósito, nunca dados de clientes. Mesmo na
    compra de encomenda, o pedido do cliente não aparece para o fornecedor.

## 4. Riscos técnicos e operacionais

| Risco | Mitigação |
|---|---|
| Duplicar o caminho de compra com `supplier_requests` | D7-1: a solicitação é o documento e a confirmação da própria compra |
| A confirmação com quantidade menor desfaz vínculos de encomendas e muda a fila de prioridade | Mesmo mecanismo testado do D6-8: pendência sem cancelar, travas na ordem da Fase 6, testes de concorrência |
| Preço confirmado maior passar sem aprovação | D7-4. Na recomendação, a alteração acima da tolerância exige aprovação com MFA |
| Documento com dados errados (endereço do depósito vazio, CNPJ ausente) enviado ao fornecedor | O documento só é gerado com o cadastro da empresa e do depósito completos. Sem isso, a tela diz o que falta |
| E-mail ao fornecedor enviado por engano ou para o contato errado, com preços | E-mail desligado nesta fase (D7-2). Quando ligar: endereço do contato principal, confirmação na tela e cópia para a empresa |
| Reputação do domínio de e-mail (DKIM e SPF do servidor compartilhado) | Só com o e-mail ligado. Volume baixo, sem anexos grandes |
| Alertas falsos de atraso sem previsão cadastrada | Sem data de referência não há atraso, só "sem confirmação". O formulário de confirmação pede a data prometida |
| Requisições acumuladas sem dono | Contador no painel inicial; requisição aberta há mais de N dias aparece em destaque. Nada expira sozinho |
| Pedir em dobro (requisição mais sugestão de reposição) | A reposição desconta as requisições abertas; o "Gerar compra" mostra o que já está a caminho |
| Desempenho da página de Abastecimento com muitas compras | Índices parciais nas compras em aberto e paginação no servidor, como na Expedição |
| Migração com o sistema no ar | 0026 aditiva e compatível com o código anterior (D7-12), com ensaio em cópia do banco como nas Fases 5 e 6 |
| Operação depende de registrar a confirmação à mão | É o mesmo modelo manual do plano original. Sem confirmação, nada trava: só aparece no acompanhamento |

## 5. Migração prevista: `0026_sglog_abastecimento`

O plano original chamava a 0026 de `sglog_expedicao`. Volumes e conferência já foram criados na 0024, então o nome
muda. A migração é **aditiva**:
- só colunas novas com valor padrão constante e tabelas novas;
- nenhuma linha existente muda de sentido;
- o código atual (`5a07198`) continua funcionando com ela (D7-12).

**Colunas novas**
- **`purchase_orders`:**
  - `supplier_ref`;
  - `sent_via` (impresso, e-mail, WhatsApp, telefone ou portal);
  - `sent_document_version`;
  - `confirmation_status`, padrão "nenhuma". As compras já enviadas ficam como "nenhuma", e não como "aguardando",
    para não gerar alertas falsos no primeiro dia (D7-8);
  - `confirmed_at` e `confirmed_by`;
  - `promised_at`.
- **`purchase_order_items`:** `confirmed_packs`, `confirmed_pack_cost_cents` e `promised_at`, nulos até a confirmação.

**Tabelas novas**
- **`purchase_order_documents`** (imutável por gatilho): compra, versão, conteúdo (`jsonb`), hash, autor e data.
  `UNIQUE (purchase_order_id, version)`.
- **`purchase_confirmation_issues`** (imutável): compra, item, tipo, pedido × confirmado, nota, autor e data. Pode
  virar um tipo novo de `purchase_receipt_issues`, a definir na implementação, sem mudar o sentido das linhas
  existentes.
- **`purchase_requests`**:
  - número em sequência, variante, embalagem opcional, depósito, quantidade base e motivo;
  - origem (`manual`, `backorder` ou `min_alert`), com a alocação quando a origem é encomenda;
  - "preciso até", situação, compra e item de compra quando consolidada, decisão, autor e datas;
  - índices únicos parciais: uma requisição aberta por alocação, e uma aberta por variante e depósito para alerta de
    mínimo.
- **`purchase_request_events`** (imutável).

**Outras mudanças**
- **`purchase_order_events`:** o CHECK de tipos ganha `document`, `confirmation`, `supplier_refused`, `followup` e
  `request_linked`. São só tipos novos; os antigos continuam válidos.
- **`logistics_settings`:**
  - `purchase_confirmation_days`, padrão 2;
  - `purchase_followup_days`;
  - `supplier_email_status`, padrão `blocked`.
- **Permissões:** `purchases.request` no código (`lib/permissions.ts`), sem mudança de papel no banco.

**Garantias da migração**
- **Bloqueios:** curtos, com espera limitada e avisos de tempo, como na 0025.
- **Ensaio:** `migrate-rehearsal` com o script já corrigido (`5a07198`).
- **Down:** recusa se a Fase 7 já foi usada (documento, confirmação, requisição ou configuração alterada). Apagar
  histórico para voltar não é opção.
- **Conferência:** `stock_reconcile()` não muda.

## 6. Testes previstos

- **Documento:**
  - só de compra aprovada ou enviada;
  - uma versão nova a cada reenvio depois de alteração;
  - imutabilidade;
  - conteúdo sem dados de cliente;
  - cadastro de empresa ou depósito incompleto bloqueia a geração.
- **Confirmação:**
  - total e parcial;
  - preço acima e abaixo da tolerância;
  - quantidade a menor com vínculos (liberação com pendência, na ordem certa);
  - recusa;
  - correção como novo registro;
  - concorrência com o recebimento.
- **Atraso e "sem confirmação":** datas de referência, compras antigas sem alerta e paginação.
- **Requisições:**
  - criar e cancelar;
  - consolidar várias numa compra, e acrescentar a um rascunho existente;
  - idempotência e uma por encomenda;
  - depósito diferente recusado;
  - compra cancelada devolve a requisição;
  - encomenda vira vínculo da Fase 6 ao consolidar.
- **Permissões:** tabela por papel, MFA na aprovação de alteração.
- **Migração:**
  - up, down e up;
  - down recusado depois do uso;
  - compatibilidade: suíte anterior (451 testes) contra o banco com a 0026;
  - ensaio com o script de cópia.
- **Regressão:** suíte completa, typecheck, builds e Playwright a 375 px (documento, confirmação, Abastecimento e
  requisições).
- **Reconciliação:** C1–C13 sem divergência depois dos cenários.

## 7. Decisões que precisam da sua aprovação

| # | Decisão | Recomendação |
|---|---|---|
| **D7-1** | A solicitação ao fornecedor do plano original vira **documento e confirmação do pedido de compra**, sem as tabelas `supplier_requests` e `supplier_request_events` | **Sim.** Evita caminho paralelo à compra. O dropshipping, que precisaria de solicitação própria, continua travado |
| **D7-2** | Canal de envio: imprimir ou PDF e copiar texto agora. **E-mail ao fornecedor** pelo servidor existente modelado e **desligado** | **Sim.** Ligar o e-mail depois, com sua autorização e um teste com fornecedor de demonstração |
| **D7-3** | Confirmação do fornecedor **obrigatória** para receber? | **Não.** Recebe sem confirmação; a falta de confirmação só aparece no acompanhamento |
| **D7-4** | Confirmação com **preço ou total maior** que o aprovado, acima da tolerância (D6-12) | **Exigir aprovação da alteração** (`purchases.approve`, MFA, quem registrou não aprova). Até aprovar, o recebimento fica bloqueado. Abaixo da tolerância, só registra |
| **D7-5** | Confirmação com **quantidade menor** | Registrar a quantidade confirmada. A pendência usa a menor. Vínculos excedentes liberados com pendência no pedido do cliente (como D6-8), sem cancelar nada |
| **D7-6** | **Requisições internas**: criar? Quem pede? | **Sim.** Estoquista, Logística, Gerente e Proprietário pedem; Comprador, Gerente e Proprietário consolidam. Vendedor não pede (a encomenda vem da alocação) |
| **D7-7** | **Geração automática** de requisições | Encomenda sem compra **vira requisição automaticamente** (idempotente, sem compra). Alerta de mínimo **não**: continua na sugestão de reposição |
| **D7-8** | Prazos | Sem confirmação após **2 dias corridos**. Atraso pela data prometida, senão pela previsão. Compras já enviadas antes da 0026 **não** entram em "sem confirmação". Ambos configuráveis |
| **D7-9** | Previsão para o cliente | **Só interno** nesta fase. Aviso ao cliente por WhatsApp ou e-mail fica para depois |
| **D7-10** | Onde fica o acompanhamento | **Logística → Abastecimento**, com atalho em Compras |
| **D7-11** | XML vinculado **pré-preenche** o recebimento | **Sim**, como sugestão editável. Nunca dá entrada sozinho |
| **D7-12** | Migração 0026 aditiva e compatível com o código atual, com ensaio em cópia | **Sim**, como D6-13 |
| **D7-13** | Desempenho do fornecedor **atualiza o prazo cadastrado** sozinho? | **Não.** Mostra o prazo real e sugere; quem altera é o comprador |

## 8. Estimativa

| Bloco | Tamanho |
|---|---|
| Migração 0026, ensaio e compatibilidade | Médio |
| Documento (versões, impressão e texto) | Médio |
| Confirmação e divergências, com liberação de vínculos | Médio-alto (concorrência com recebimento e vínculos) |
| Abastecimento e desempenho do fornecedor | Médio |
| Requisições e consolidação | Médio |
| Testes, Playwright e documentação | Médio |

Nada desta fase é implementado, enviado ou implantado sem sua autorização expressa.
