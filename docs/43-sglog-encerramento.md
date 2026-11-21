# SGLog — encerramento técnico (21/11/2026)

As 10 fases planejadas do SGLog estão implementadas, implantadas na VPS de testes e validadas funcionalmente, com as
ressalvas abaixo. Em execução na VPS: `82deb8b` (migração `0029_sglog_custos`). Na `main` do GitHub: `a48233c` (só
documentação depois de `82deb8b`).

Este documento não repete auditorias nem testes aprovados: os registros de cada fase ficam em
[TESTES-PENDENTES.md](TESTES-PENDENTES.md) (histórico) e nos documentos de cada fase. As pendências realmente abertas
estão no topo de [TESTES-PENDENTES.md](TESTES-PENDENTES.md), separadas por tipo.

**A VPS continua sendo ambiente de testes, não de operação comercial.** O banco tem dados de demonstração misturados
com alguns registros reais (seção 4, risco R2).

## 1. Situação das fases

| Fase | Tema | Migração | Implantada | Situação |
|---|---|---|---|---|
| 1 | Depósitos e conferência do estoque | 0020 | 16/11, `b5ff9f2` | Validada; falta login dos papéis novos |
| 2 | Gestão de fornecedores | 0021 | 16/11, `0ccdc74` | Validada com ressalvas (papéis, rascunho de teste nº 85) |
| 3 | Estoque por depósito | 0022 | 16/11, `394e0ab` | Validada; falta solicitação de ajuste com dois usuários e MFA do gerente |
| 4 | Alocação dos pedidos | 0023 | 20/11, `7d2ae42` + `d3c15f6` | Validada com ressalvas; falta pedido novo pago e permissões |
| 5 | Remessas e expedição | 0024 | antes de 20/11 (pré-requisito da Fase 6) | **Implantada, sem validação pelo HTTPS registrada** (despacho depende da NF-e) |
| 6 | Compras, recebimento e encomendas | 0025 | 20/11, `5a07198` | Validada com ressalvas (segundo aprovador, encomenda vinculada) |
| 7 | Abastecimento e fornecedores | 0026 | 20–21/11, `f5501d7` → `e057df4` → `3393f8a` | Concluída funcionalmente; documento ao fornecedor depende do CNPJ |
| 8 | Fretes, etiquetas, rastreio e custos | 0027 | 21/11, `d58a3dd` → `d76ca4f` | Validada com ressalvas (sem remessa nova, sem Melhor Envio) |
| 9 | Ocorrências, devoluções e logística reversa | 0028 | 21/11, `b7f7749` → `8c66097` | Validada com ressalvas (página do cliente, fiscal, troca) |
| 10 | Custos, margem de contribuição e gestão | 0029 | 21/11, `51139e8` → `82deb8b` | Validada; margens parciais até configurar custos reais |

Suíte da API no local: 546/546. E2e no desktop e a 375 px: 52 aprovados e 2 pulados (sem remessa em manuseio no banco
de demonstração).

## 2. Conferências do banco (C1–C24)

| Conferência | Último resultado documentado | Situação |
|---|---|---|
| C1–C21 (estoque, alocação, remessas, compras, devoluções) | 21/11/2026, bloco 5.1 do doc 39, depois dos testes da Fase 9: 204 variantes, 0 divergência | **Pendente depois da Fase 10.** O bloco 5.1 do [doc 42](42-sglog-fase10-implantacao.md) (C1–C21, C22–C23 e margem calculável) não tem resultado registrado. Rodar como `loja` e anotar. Não executado por mim. |
| C22–C24 (custos e margem) | 21/11/2026, pelo painel, antes e depois de `82deb8b`: 0 divergência em 299 pedidos | OK |

A Fase 10 não mudou `stock_reconcile()`. Ainda assim, o resultado depois da implantação precisa estar no registro.

## 3. Funcionalidades bloqueadas por decisão

Ficam travadas no código ou na configuração. Nenhuma se libera sozinha. Liberar qualquer uma é uma decisão sua, com
os pré-requisitos atendidos.

| Funcionalidade | Como está travada | Pré-requisito para liberar |
|---|---|---|
| Dropshipping | `logistics_settings.dropship_status = blocked` | Validação fiscal com nome de quem validou; liberação pelo proprietário ou gerente com MFA |
| Remessas múltiplas (entrega parcial) | Regra em Expedição → Regras, `blocked` | Contador define a NF-e na entrega parcial (uma nota por remessa ou outra regra) |
| Etiquetas reais (compra de frete pelo sistema) | `SHIPPING_LABELS_ENABLED` desligado e `label_status = blocked`, limite não definido | Provedor com idempotência ou busca pela nossa chave (o Melhor Envio não tem); CNPJ e NF-e em produção; saldo; teste no sandbox; limite; MFA; sua autorização expressa |
| Alocação automática | `ALLOCATION_AUTO` ausente | Decisão D4-2, depois do teste com pedido novo pago. Até lá cada pedido novo é alocado à mão |
| E-mail automático ao fornecedor | `blocked` | Decisão; hoje o documento é copiado, impresso ou salvo em PDF e enviado por você |
| NF-e e despacho da reposição de troca | Trava no código | Contador define natureza/CFOP da reposição (total zero) |
| Emissão fiscal em produção | `fiscal_settings.environment = homologacao` | Homologação completa e liberação com o nome do contador |
| Devolução de dinheiro pelo sistema | Não existe (reembolso é só registro) | Por desenho: devolução no Mercado Pago, no Pix ou no marketplace é feita fora do sistema |
| Saldo de anúncio do ML com variação | Manual | Decidir se vale implementar o envio de todas as variações |
| NF-e de venda de marketplace | Manual | Você e o contador decidem o caminho (API de faturamento de cada plataforma ou outro) |

## 4. Riscos operacionais restantes (prioridade)

**Críticos: impedem operar ou comprometem pedidos, estoque ou fiscal desde o primeiro dia.**

- **R1. NF-e não configurada: o despacho de pedido que exige nota fica bloqueado.** Sem CNPJ, conta na Focus,
  certificado A1, cadastro fiscal dos produtos e homologação validada pelo contador, a loja recebe o pagamento mas não
  despacha pelo sistema. O CNPJ ainda não existe (registro da Shopee, 18/11).
- **R2. Banco de testes com demonstração e registros reais misturados.** Há 133 ou mais pedidos, estoque (cerca de
  226 mil unidades no depósito padrão) e fornecedores de demonstração. Ao lado deles estão um Pix real aprovado
  (18/11), a conta real do Mercado Livre conectada (24176353) e o pedido nº 1463 do Mercado Livre. Consequências:
  - estoque fictício aparece como vendável na loja. Se houver anúncio real vinculado a uma variante, o saldo de
    demonstração pode ser enviado ao Mercado Livre, com risco de venda sem mercadoria. **Conferir os vínculos de
    anúncio antes de qualquer venda real;**
  - o `demo:reset` previsto no lançamento **não roda** neste banco: ele recusa, de propósito, quando há pagamento
    real aprovado ou conta de marketplace conectada;
  - defeito técnico encontrado nesta revisão (sem correção, por ser etapa de encerramento): se rodasse, o reset
    apagaria a linha única `logistics_settings` (travas de dropshipping e etiqueta, regras de compra e rastreio) sem
    recriá-la. As telas de alocação, expedição, fretes e compras passariam a dar erro. Corrigir antes de qualquer
    reset (incluir a tabela nas configurações de linha única recriadas com o padrão travado).

  Decisão necessária: banco novo e limpo para a operação, com catálogo, estoque inicial por inventário e reconexão
  do Mercado Livre, ou limpeza seletiva da demonstração com roteiro próprio. Recomendação: banco novo, com o banco
  atual guardado em backup.
- **R3. O fluxo novo de expedição nunca rodou ponta a ponta na VPS.** Separar, conferir, embalar e despachar (Fase 5),
  o despacho com custo e a entrega pela remessa (Fase 8) só foram exercidos no local e no e2e: o despacho na VPS
  esbarra na NF-e. A primeira venda real passaria por um caminho sem teste no servidor. Mitigação: um pedido de teste
  completo com NF-e em homologação, antes de abrir.

**Altos: afetam pagamentos, pedidos ou entregas no dia a dia.**

- **R4. Pagamentos.**
  - O mecanismo que confirmou o Pix real (webhook ou reconsulta) não foi identificado no log.
  - O Mercado Pago devolveu HTTP 500 intermitente na geração do Pix (17 e 18/11).
  - O estorno de pedido cancelado é manual. O reembolso no sistema é só registro, e esquecer a devolução no Mercado
    Pago é um risco de processo.
  - Confirmar quais credenciais (teste ou produção) estão no `.env` e se o webhook de produção está cadastrado.
- **R5. Alocação manual obrigatória.** Com `ALLOCATION_AUTO` desligado, todo pedido novo pago fica em "Aguardando
  alocação" até alguém confirmar. Sem rotina diária, o pedido para. O painel Gestão já mostra "pagos sem despacho".
- **R6. Permissões e MFA nunca testados com contas reais.**
  - Só os proprietários (com MFA) foram usados nos testes.
  - O gerente sem MFA não faz ajuste direto, estorno, extravio nem cadastro de depósito.
  - A aprovação de compra hoje é sempre exigida (limite R$ 0) e cai nos proprietários.
- **R7. Balcão sem dinheiro e maquininha.** A necessidade foi confirmada em 18/11 e não está implementada. A venda
  presencial feita fora do sistema não baixa estoque, e o saldo diverge. Precisa de implementação (funcionalidade
  nova, fora desta etapa) ou de um procedimento manual de baixa.

**Médios.**

- **R8. Comunicação com o cliente.**
  - Não há e-mails ao cliente (recuperação de senha, avisos de pedido).
  - A API oficial do WhatsApp não está ativada (sem modelos aprovados).
  - O e-mail da loja cai em spam no Gmail e é recusado pelo Hotmail (`550 5.7.1 S3150`).
- **R9. Marketplaces.**
  - Mercado Livre: cancelamento, aviso reenviado ou perdido e saldo no anúncio não foram validados.
  - Shopee: nada validado (sem CNPJ nem loja).
  - A nota fiscal das vendas de marketplace é manual.
- **R10. Frete.**
  - Sem Melhor Envio, o frete é manual.
  - Variante sem peso e medidas não mostra opção de frete.
  - O CEP de origem e os serviços oferecidos não estão definidos.
- **R11. Segurança e capacidade.**
  - SSH do root ainda aceita senha.
  - A visibilidade do repositório no GitHub não foi confirmada como privada.
  - A CSP da loja ainda está aberta para o SDK do Mercado Pago.
  - Não há monitor externo de disponibilidade nem teste de carga.

**Baixos.**

- **R12. Margens parciais.** Até informar as taxas reais, o custo das caixas e a alíquota estimada validada pelo
  contador, o painel Gestão mostra cobertura 0%. Não serve para decidir preço.
- **R13. Manutenção do servidor.**
  - Cópias em `backups/sglog/` e 5 pastas de 14/11 com dono root ficam fora da retenção.
  - `loja-web` registra falha ao parar (status 143, cosmético).
  - Falta o destino de `.env.antes-dominio` e de `embalagemcanoinhas.inc.php,` (não apagar sem sua decisão).

## 5. Checklist de prontidão para a operação comercial

Em ordem. Cada bloco depende dos anteriores.

**A. Empresa e fiscal (bloqueia vender com nota)**
- [ ] CNPJ ativo; razão social, endereço e regime em Empresa; credenciamento na SEF-SC.
- [ ] Conta na Focus NFe, token de homologação, certificado A1 e gatilho (hook) cadastrado.
- [ ] Contador: regras fiscais por operação e cadastro fiscal dos produtos (NCM, CEST, origem, CST/CSOSN).
- [ ] Homologação completa: autorizada, rejeição e reenvio, clique duplo, queda de rede, carta de correção,
      cancelamento, inutilização, aviso da Focus.
- [ ] Contador confere DANFE e XML; liberação de produção registrada com o nome dele.

**B. Banco e catálogo (bloqueia vender o que existe)**
- [ ] Decisão sobre a limpeza da demonstração (R2) e, se houver reset, correção do `logistics_settings` antes.
- [ ] Catálogo real (planilha de importação), fotos, preços, peso e medidas de todas as variantes.
- [ ] Estoque inicial por inventário no depósito padrão; conferência C1–C21 sem divergência depois.
- [ ] Fornecedores reais e ofertas; fornecedor principal onde houver mais de um.
- [ ] Nome, logotipo, favicon, textos de trocas e privacidade revisados pelo jurídico.

**C. Pagamentos e frete**
- [ ] Credenciais de produção do Mercado Pago e webhook de produção conferidos; CSP da loja fechada.
- [ ] CEP de origem, serviços de entrega e regras de frete definidos; Melhor Envio (sandbox, depois produção) ou
      frete manual assumido como processo.
- [ ] Balcão: decisão sobre dinheiro e maquininha (implementar ou procedimento manual de baixa).

**D. Fluxo completo com pedido de teste (com a NF-e em homologação)**
- [ ] Pedido pago → alocação → separar, conferir, embalar → NF-e → despacho com custo → rastreio → entrega.
- [ ] Página do cliente com o rastreio e uma devolução de teste.
- [ ] Cancelamento de pedido pago com devolução manual no Mercado Pago (processo).
- [ ] Bloco 5.1 depois: C1–C24 sem divergência.

**E. Equipe**
- [ ] Usuários reais por função, cada um com MFA onde a permissão exige.
- [ ] Teste dos perfis com login próprio (seção "Testes que dependem de outras contas" em TESTES-PENDENTES).
- [ ] Decisões D6-1, D6-3 e D6-12 (quem recebe, limite de aprovação, tolerância de preço); quem aprova ajuste.
- [ ] Rotina diária combinada: alocar pedidos pagos, olhar "pagos sem despacho", "rastreio parado" e ocorrências.

**F. Canais e comunicação (podem vir depois da abertura da loja própria)**
- [ ] WhatsApp oficial com os 3 modelos aprovados; e-mail entregue na caixa de entrada (Hotmail desbloqueado) e só
      então DMARC `quarantine`.
- [ ] Mercado Livre: conferir vínculos e saldo dos anúncios; cancelamento e reenvio de aviso.
- [ ] Shopee, depois do CNPJ.

**G. Segurança e operação do servidor**
- [ ] SSH só com chave; repositório privado; monitor externo; teste de carga fora do horário.
- [ ] Taxas reais do Mercado Pago e dos marketplaces e custo das caixas em Custos e margens (margens deixam de ser
      parciais).

## 6. O que esta etapa não fez

- Nenhum comando na VPS, nenhuma implantação, nenhuma regra de negócio alterada, nenhuma funcionalidade nova, nenhuma
  Fase 11.
- O defeito do `demo:reset` (R2) ficou registrado, sem correção.
