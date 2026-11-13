# Fase 5 — NF-e modelo 55: decisões

Consultas feitas em 13/11/2026. Tudo que depende do contador ou da empresa fica **configurável e marcado como
pendente**; o sistema não preenche CFOP, CST/CSOSN, alíquotas nem natureza da operação por conta própria.

## 1. Autorizador

Santa Catarina usa a **SVRS (Sefaz Virtual do RS)** como autorizador de NF-e e NFC-e (aviso da SEF/SC de 2024).
A integração não fala direto com a SEFAZ: quem transmite é o provedor fiscal, que acompanha as notas técnicas.

Fontes: [SEF/SC, aviso](https://sef.sc.gov.br/api-portal/Documento/Ver/6351) ·
[LegisWeb, orientação da SEF/SC](https://www.legisweb.com.br/noticia/?id=28843)

## 2. Provedor fiscal: comparação

| Critério | Focus NFe | NFE.io | PlugNotas (Tecnospeed) | Nuvem Fiscal |
|---|---|---|---|---|
| Documentação pública da API | Completa, com OpenAPI por operação (`doc.focusnfe.com.br`) | Completa (`nfe.io/docs`) | Só material de blog encontrado | Portal de desenvolvedor não respondeu na consulta |
| Homologação separada | Sim: `homologacao.focusnfe.com.br` | Sim (Test/Production) | Não confirmado | Não confirmado |
| Idempotência | `ref` escolhida pelo integrador, única por nota | `externalId` | Não confirmado | Não confirmado |
| Emissão | Assíncrona (202) e consulta por `ref` | Assíncrona + webhook | Assíncrona + webhook | — |
| Cancelamento, CC-e, inutilização | Documentados | Documentados | Não confirmado | — |
| Webhook | Cadastro por API; header de autorização definido pelo integrador; reenvio por até 48 h | Entrega "ao menos uma vez" | Reenvio por ~6 h | — |
| IBS/CBS | Guia de campos pela NT 2025.002-RTC | Layout RTC documentado | — | — |

**Escolha: Focus NFe**, de forma reversível: tudo passa pela interface `FiscalProvider`
(`apps/api/src/lib/fiscal.ts`). Trocar de provedor é escrever outro adaptador, sem mexer em banco ou telas.
Preço, SLA e contrato **não foram conferidos** (dependem de cadastro comercial) e ficam com a empresa antes da
produção. NFE.io é a alternativa documentada se a Focus não fechar comercialmente.

Fontes: [Focus NFe, documentação](https://doc.focusnfe.com.br/) ·
[NFE.io, processamento e contingência](https://nfe.io/docs/emissao-nfe-nfce-processamento-resiliencia-e-contingencia/) ·
[NFE.io, webhooks](https://nfe.io/docs/documentacao/webhooks/payloads-de-emissao/) ·
[Tecnospeed, webhooks PlugNotas](https://blog.tecnospeed.com.br/inteligencia-plugnotas-notificacoes-webhook/)

## 3. Contrato da Focus usado (só o que está documentado)

- **Autenticação**: HTTP Basic, token como usuário e senha vazia. Um token por ambiente.
- **Ambientes**: `https://homologacao.focusnfe.com.br/v2` e `https://api.focusnfe.com.br/v2`.
- **Emitir**: `POST /nfe?ref=REF` → 201 (autorizada) ou 202 (`processando_autorizacao`); 422 com `codigo`
  (`erro_validacao_schema`, `already_processed`, `pending_operation`, `permissao_negada`).
- **Consultar**: `GET /nfe/REF` → `status` ∈ `processando_autorizacao`, `autorizado`, `cancelado`, `erro_autorizacao`;
  `chave_nfe`, `numero`, `serie`, `caminho_xml_nota_fiscal`, `caminho_danfe`, `caminho_xml_cancelamento`, `erros`.
- **Cancelar**: `DELETE /nfe/REF` com `justificativa` (15 a 255), síncrono, até 24 h após a emissão.
- **CC-e**: `POST /nfe/REF/carta_correcao` com `correcao` (15 a 1000), até 20 por nota.
- **Inutilizar**: `POST /nfe/inutilizacao` com `cnpj`, `serie`, `numero_inicial`, `numero_final`, `justificativa`.
- **Webhook**: `POST /hooks` com `event: "nfe"`, `url`, `authorization` e `authorization_header`. O corpo traz os
  mesmos dados da consulta; **não há assinatura**. Por isso o aviso só serve de gatilho: a API sempre reconsulta
  a nota pela `ref` antes de mudar qualquer coisa (a própria Focus recomenda a consulta como confirmação).

**Numeração**: no esquema de emissão `numero` e `serie` só aparecem na resposta, então quem numera é o provedor
(série e próximo número configurados no painel da Focus). `fiscal_settings.nfe_series`/`nfe_next_number` ficam
para conferência. Rejeição não consome número na SEFAZ; se houver salto, há a tela de inutilização.

## 4. Modelo de dados (migration 0006)

- `fiscal_rules`: regra por operação (dentro/fora da UF × tipo de comprador): natureza da operação, CFOP,
  CST/CSOSN do ICMS, CST de PIS e COFINS, consumidor final, presença do comprador e campos extras do provedor
  (IBS/CBS etc.). Mesmo ciclo do cadastro fiscal do produto: **informada → validada pelo contador**; alterou, a
  validação cai. Histórico imutável.
- `fiscal_documents`: uma linha por tentativa. Só uma ativa (pendente, processando ou autorizada) por pedido e
  finalidade (índice único parcial). Rejeitada fica no histórico e a nova tentativa usa outra `ref`.
  **Não pode ser apagada**; o que foi enviado (`payload`), a `ref`, o ambiente e a versão da empresa não mudam;
  autorizada só passa a cancelada.
- `fiscal_document_events`: somente inclusão (envio, retorno, cancelamento, CC-e, aviso do provedor).
- `fiscal_files`: XML, DANFE, XML de cancelamento e de CC-e com SHA-256 e tamanho. Imutável. O hash é conferido a
  cada download.
- `fiscal_inutilizations`, `fiscal_certificates` (só metadados) e `fiscal_webhook_notifications`.
- `orders.invoice_status` ganha `processing`, `rejected` e `canceled`. A expedição continua exigindo `authorized`.

## 5. Certificado A1

O certificado é enviado **pela empresa diretamente ao provedor** (painel da Focus), porque é o provedor que
assina o XML. A loja **não guarda a chave privada**: guardá-la só aumentaria o risco sem uso. A loja registra os
metadados (titular, CNPJ, validade, impressão digital) e avisa no painel com 30, 15 e 7 dias de antecedência.
Isso muda o item 5.4 do plano inicial ("certificado A1 cifrado") e fica registrado aqui.

## 6. Fluxo

1. Pedido pago → painel mostra a **conferência fiscal**: dados da empresa, provedor configurado, regra validada
   para a operação, produtos com cadastro fiscal validado, endereço do destinatário.
2. Emitir (botão no pedido; ou automático ao pagar, se `emission_policy = on_paid`, decisão do contador).
   Cria o documento e grava `processing` no pedido **antes** de chamar o provedor: dois cliques ou duas
   instâncias não emitem duas notas.
3. Falha de rede: o documento fica `pending` e a rotina de 1 minuto consulta a `ref`; se o provedor não a
   conhece, reenvia **com a mesma `ref`** (sem risco de nota dupla).
4. Autorizada → XML e DANFE baixados, com hash; pedido `authorized`; expedição liberada; cliente baixa o DANFE
   e o XML na conta ou no link do pedido.
5. Rejeitada → motivo da SEFAZ no pedido; corrige-se o cadastro e emite-se de novo (nova `ref`).
6. Cancelar (justificativa) e CC-e: eventos com arquivos. Pedido com nota autorizada não é cancelado sem
   antes cancelar a nota.

## 7. Trava de produção

A emissão começa em homologação. Para liberar produção (permissão `fiscal.validate`, com MFA):
credenciamento marcado como concluído, ao menos uma nota **autorizada em homologação**, token de produção
configurado e nome do contador que validou. Quem liberou e quando fica gravado.

## 8. Mapeamento que depende de confirmação em homologação

- Rateio de frete e desconto por item: o esquema documentado só tem os totais (`valor_frete`, `valor_desconto`).
- Formas de pagamento (`detPag`): o trecho do esquema consultado não traz os campos; se a SEFAZ exigir, a regra
  aceita os campos extras definidos com o provedor.
- `regime_tributario_emitente` documentado com 1, 2 e 3; MEI fica bloqueado até a confirmação.
- Pedido de retirada sem endereço: usa o endereço principal do cliente; sem ele, a emissão é bloqueada com aviso.
- Em homologação o nome do destinatário é o texto exigido pela SEFAZ, como no exemplo oficial da Focus.

## 9. Pendências com a empresa e o contador

- Contrato com o provedor e tokens de homologação e produção (no `.env`, nunca no código).
- Certificado A1 enviado ao provedor e cadastro da empresa lá.
- Regras fiscais por operação e validação do cadastro fiscal dos produtos.
- IBS/CBS: quais campos e códigos (cClassTrib) usar em 2026/2027.
- Política de emissão (manual ou ao pagar) e de pedido sob encomenda.

## 10. Importação do XML de NF-e de compra

- **O que faz**: lê o XML da NF-e do fornecedor (modelo 55, layout 4.00) e mostra a conferência. **Não movimenta
  estoque**: a entrada continua sendo o recebimento do pedido de compra, feito por uma pessoa.
- **Segurança do arquivo**: até 2 MB; XML com DOCTYPE/ENTITY é recusado (sem expansão de entidades); a chave de acesso
  precisa ter 44 dígitos e dígito verificador válido (módulo 11); só modelo 55. Leitor `fast-xml-parser` 5.11.2 (versão
  exata; a 5.12.1 tinha saído no dia e foi evitada).
- **Uma vez só**: chave de acesso única; reenviar a mesma nota devolve a importação existente.
- **Guarda**: o XML original fica no armazenamento com sha256 conferido na leitura; a nota importada não pode ser
  apagada e só o vínculo (fornecedor e pedido de compra) pode mudar, com auditoria.
- **Conferência**: fornecedor pelo CNPJ do emitente; item pelo código do fornecedor (oferta) e, sem ele, pelo código
  de barras da embalagem; com pedido vinculado (só do mesmo CNPJ), compara quantidade pendente e preço item a item e
  lista o que o pedido tem e a nota não. Avisa quando o destinatário não é o CNPJ da empresa e quando o XML não traz o
  protocolo de autorização (cStat 100).
- **Limite conhecido**: a quantidade da nota é comparada direto com a do pedido (em embalagens de compra). Se o
  fornecedor fatura em outra unidade, a divergência aparece e a pessoa decide no recebimento. Não consultamos a SEFAZ
  para confirmar a situação atual da nota (exigiria certificado e serviço próprio).

