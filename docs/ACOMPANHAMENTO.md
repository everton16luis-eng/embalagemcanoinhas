# Acompanhamento

## Fase 1 — Diagnóstico — concluída (13/11/2026)

Ver [00-diagnostico-e-plano.md](00-diagnostico-e-plano.md).

## Fase 2 — Base do sistema — entregue para validação (13/11/2026)

### Pronto

- Monorepo novo, banco próprio em cluster isolado, papéis separados (dono e aplicação) e migrations com `down`.
- Equipe: login, sessão em cookie `httpOnly` com expiração por inatividade (2 h) e absoluta (12 h), bloqueio após
  tentativas, recuperação de senha de uso único, troca de senha que derruba as outras sessões, MFA (TOTP) com código
  de uso único, lista e encerramento de sessões.
- Permissões por papel (proprietário, gerente, atendimento, estoque, fiscal, expedição) com exceções individuais.
  Permissões sensíveis exigem MFA. Ninguém altera o próprio papel; o sistema não fica sem proprietário.
- Auditoria somente inclusão, com antes/depois, protegida por gatilho até contra o dono das tabelas.
- Proteções: CSRF por origem, rate limit, validação no servidor (zod), SQL parametrizado, cabeçalhos de segurança.
- Catálogo: categorias em até 3 níveis, produtos com variações (SKU único, GTIN validado), unidade base,
  embalagens de venda (com preço) e de compra (com conversão para a unidade base), ficha técnica, giro,
  sob encomenda com prazo opcional, busca sem acento por nome/SKU/código de barras.
- Histórico de preços gravado por gatilho, com autor; alterar preço exige permissão própria + MFA.
- Concorrência otimista no produto (duas pessoas não se sobrescrevem). Variação retirada fica inativa, não some.
- Fotos: conteúdo verificado, metadados removidos, WebP em 320/800/1600 px, foto principal.
- Classificação fiscal do produto (NCM, CEST, origem, unidade tributável) com quem informou e quem validou.
  Qualquer mudança derruba a validação; histórico completo.
- Empresa: dados do emitente e do contador em versões imutáveis; CNPJ numérico e alfanumérico validado; IBGE
  conferido com a UF. Configuração fiscal começa em homologação e não vai para produção sem liberação registrada
  (regra no banco).
- Assistente de configuração: o que falta, quem informa (empresa, contador, sistema) e o que fica para fases seguintes.
- Painel: configuração inicial, produtos, categorias, empresa e fiscal, marca da loja, usuários, auditoria, conta.

### Testes

- 39 testes de integração da API (`npm test`): autenticação, MFA, CSRF, varredura de todas as rotas sem sessão e
  com papel sem permissão, privilégios do papel do banco, catálogo, conversão de embalagens, preços, fiscal,
  empresa e assistente.
- Navegador: login, assistente, cadastro e edição de produto pela tela (histórico de preço atualizado), páginas do
  painel sem erro e sem rolagem horizontal em 375 px.

### Não verificado

- Inspeção visual por captura de tela: o painel do navegador estava oculto durante a verificação.
- Build de produção (`next build`) e implantação em servidor.
- Envio de e-mail (recuperação de senha): não há provedor configurado; o link não é entregue.

### Decisões em aberto

| Decisão | Necessária até |
|---|---|
| Servidor de produção (mesmo VPS da barbearia?) e medição de memória | Primeira implantação |
| Provedor de e-mail transacional | Primeira implantação |
| Primeiro gateway de pagamento (sugestão: Mercado Pago) | Fase 4 |
| Provedor fiscal | Fase 5 |

## Fase 3 — ERP e estoque — próxima

Saldos (físico, reservado, disponível), movimentos imutáveis, reservas, fornecedores, pedidos de compra, custo com
frete rateado, inventário, alertas de mínimo, sugestão de reposição por giro.
