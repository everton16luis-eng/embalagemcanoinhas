# Auditoria de segurança, desempenho e capacidade (novembro de 2026)

Executada em 13/11/2026 sobre o `main` (a partir de `f9f022e`). Escopo: API (Fastify), loja e painel (Next.js),
banco (PostgreSQL próprio), configuração de implantação (nginx, systemd) e a jornada de compra.

**Onde foi testado.** Tudo o que tem número neste relatório rodou **localmente**, num banco de demonstração separado
(`loja_demo`, dados fictícios, ~100 produtos), com a API e o site **compilados para produção** e sem pagamento real
(`PAYMENT_FAKE`). Máquina de teste: Ryzen 5 4600G (12 threads), 15 GB, Windows 11; o gerador de carga (k6) rodou na
mesma máquina. O VPS de produção é bem menor (2 vCPU e 7,9 GB, ~4,8 GB disponíveis, divididos com outros sites), então **os números de
capacidade não valem para o servidor** sem a medição lá (roteiro em [tests/carga/README.md](../tests/carga/README.md) e
pendências em [TESTES-PENDENTES.md](TESTES-PENDENTES.md)). Nada foi executado contra a loja publicada.

**Regras seguidas.** Sem teste de negação de serviço; carga sempre limitada e com parada automática (`abortOnFail`:
mais de 5% de falha ou p95 das páginas acima de 4 s); a jornada de carga **não cria pedido, pagamento nem movimento
de estoque** (o checkout vai com total esperado errado de propósito e a API recusa dentro da transação, antes de
gravar). Nenhum produto, pedido ou registro existente foi apagado. O índice novo foi medido numa transação desfeita
antes de virar migração. Segredos não aparecem neste relatório.

Legenda da classificação: **Aprovado** = testado e sem problema · **Corrigido** = problema encontrado, corrigido e
testado de novo · **Atenção** = funciona, com ressalva · **Pendente** = não dá para testar aqui (depende do servidor,
de HTTPS ou de conta externa) · **Não testado** = fora do que foi possível nesta rodada.

## 1. Resumo

| Área | Situação |
|---|---|
| Integridade comercial (estoque, checkout, preço) | **Aprovado** (testes de concorrência) |
| Autenticação e sessões | **Corrigido** (login de cliente sem bloqueio por conta) |
| Injeção, XSS, travessia de caminho, atribuição em massa, CSRF | **Aprovado** |
| Dependências | **Corrigido** (1 vulnerabilidade baixa); `npm audit` zerado |
| Cabeçalhos de segurança | **Corrigido** no painel (CSP estrita); **Atenção** na loja (CSP parcial até validar o Mercado Pago) |
| Proteção contra excesso de requisições | **Corrigido** na aplicação e no nginx do VPS |
| Configuração do servidor (SSH, firewall, portas, permissões) | Auditado: **2 achados altos** (backups legíveis por todos; SSH do root com senha), ver 3.3 |
| Desempenho do front-end | **Aprovado** (Lighthouse 97–100 em desempenho) |
| Acessibilidade | **Corrigido** (nomes de botão/link, contraste, tabela) |
| Banco de dados | **Corrigido** (índice para as fotos dos cards; limpeza de contadores) |
| Capacidade local | ver seção 5: sem degradação até ~100 usuários simultâneos; saturação entre 200 e 300 |
| Capacidade no VPS | **Pendente** |

## 2. Arquitetura avaliada

- Navegador → **nginx** (HTTPS, sobrescreve `X-Forwarded-For`) → **Next.js** (porta 3047: páginas da loja e do painel,
  todas renderizadas no servidor; `/api/*` repassado) → **API Fastify** (zod, `pg`) → **PostgreSQL** próprio
  (porta 54330, papéis `loja_owner`/`loja_app` com permissão por coluna).
- Cada página da loja chama a API de 3 a 5 vezes no servidor (departamentos, dados da loja e o conteúdo da página).
- Pagamento: Mercado Pago (Pix/cartão pelo SDK oficial; o cartão nunca passa pelo sistema). Fiscal: provedor de NF-e.
- Fotos: `storage/images/<uuid>/{320,800,1600}.webp`, servidas pela API com cache imutável.

## 3. Segurança

### 3.1 Achados e correções

| # | Achado | Criticidade | Situação | Evidência / correção |
|---|---|---|---|---|
| S1 | Login de **cliente** só tinha limite por IP (10/min). Com vários IPs dava para testar senhas de uma conta sem parar. | Média | **Corrigido** | Mesmo bloqueio progressivo do painel: 5 falhas por e-mail ou 30 por IP em 15 min bloqueiam, inclusive a senha certa, até a janela passar. Teste `audit.test.ts` (12 tentativas de IPs diferentes → 429). |
| S2 | `fast-xml-parser` 5.11.2 com GHSA-474x-hrwr-fgx4 (lê XML de nota de compra enviado pelo painel). | Baixa | **Corrigido** | 5.12.1; testes de notas de compra 4/4; `npm audit` 0. |
| S3 | Sem Content-Security-Policy. | Baixa/média | **Corrigido** no painel · **Atenção** na loja | Painel: `default-src 'self'`, `frame-ancestors 'none'`, sem script externo. Loja: `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`. A política completa da loja depende de liberar exatamente os domínios do SDK do Mercado Pago, o que só dá para conferir no sandbox. Conferido no build de produção: cabeçalhos presentes e painel sem erro no console. |
| S4 | nginx mostrava a versão e não limitava um IP disparando requisições antes do Next. | Baixa | **Corrigido** (aplicado no VPS e conferido em 14/11/2026) | `deploy/nginx/00-loja-limites.conf` (20 req/s por IP com rajada de 80; 60 conexões) e `server_tokens off` nos dois sites da loja. Instalação e reversão no próprio arquivo. |
| S5 | Contadores de limite (`rate_limits`, `auth_throttle`) nunca eram apagados: cada IP e rota deixava uma linha para sempre. | Baixa | **Corrigido** | Limpeza de hora em hora só do que já perdeu efeito (janela encerrada há mais de 1 h; bloqueio vencido). |
| S6 | Repositório no GitHub é **público**. Não há segredo no código nem no histórico (conferido: `.env`, `.local`, certificados nunca entraram), mas a estrutura do sistema fica exposta. | Informativo | **Atenção** | Recomendado tornar privado. |

### 3.2 Verificado sem problema

- **Injeção de SQL**: toda consulta usa parâmetros; os poucos trechos montados (ordenação, agrupamento, colunas) vêm de
  listas fixas. Teste com cargas maliciosas na busca e na ordenação: nenhuma resposta 500, ordenação inválida → 400.
- **XSS**: o React escapa tudo; não há `dangerouslySetInnerHTML`; texto com `<script>` volta como texto no JSON.
- **Travessia de caminho** nas fotos e arquivos fiscais: chave validada por expressão regular → 400/404.
- **Atribuição em massa**: esquemas zod estritos; campo extra (`role`, `price_cents`, `status`) → 400.
- **CSRF**: toda escrita exige `Origin` da própria loja (webhooks à parte, com assinatura); teste com origem estranha → 403.
  Cookies `httpOnly`, `SameSite=Lax`, `Secure` em produção.
- **Senhas e sessões**: argon2id, comparação com hash falso quando o e-mail não existe (sem revelar cadastro), sessão
  do painel com 2 h de inatividade e 12 h no máximo, MFA por TOTP.
- **Token público de pedido**: id ou número do pedido no lugar do token → 400/404 (não dá para enumerar pedidos).
- **SSRF**: chamadas externas só para URLs da configuração.
- **Uploads**: só JPEG/PNG/WebP conferidos pelo conteúdo, 8 MB, reprocessados pelo `sharp`; nome sempre UUID.
- **Corpo das requisições** limitado a 1 MB (fotos à parte); log com dados sensíveis mascarados.
- **Dependências**: `npm audit --omit=dev` sem vulnerabilidades.

### 3.3 Servidor (auditoria só de leitura em 14/11/2026)

Saída de `deploy/auditoria-servidor.sh` no VPS (Ubuntu 24.04.5, 2 vCPU, 7,9 GB de RAM com ~4,8 GB disponíveis, 2 GB
de swap, disco com 14% de uso). O servidor também roda outros sistemas (barbearia, vitrine, CloudPanel, e-mail).

| # | Achado | Criticidade | Situação |
|---|---|---|---|
| V1 | Cópias de backup (`db.dump` com o banco inteiro) e a pasta `.local` legíveis por **qualquer usuário** da máquina; um site vizinho comprometido leria clientes e hashes de senha. | Alta | **Corrigido** (`umask 077` no backup, `UMask=0077` na unidade, cópias existentes em 700/600; conferido com o script em 14/11) |
| V2 | SSH aceita **login do root com senha** (`PermitRootLogin yes`, `PasswordAuthentication yes`). fail2ban ativo reduz, mas não elimina, a força bruta. Vale para o servidor inteiro. | Alta | **Pendente** (decisão sua: exige confirmar o acesso por chave antes) |
| V3 | 13 atualizações de segurança pendentes (o `unattended-upgrades` está ligado). | Média | **Corrigido** (0 pendentes em 14/11); **reinício pendente** para o kernel novo |
| V4 | Duas unidades do systemd com falha: `cloud-final` (scripts de primeira inicialização da hospedagem) e `motd-news` (notícias da mensagem de login). Nenhuma é da loja nem afeta segurança. | Informativo | **Resolvido** (aviso limpo; nenhuma unidade com falha em 14/11) |
| V5 | Serviços de outros sistemas ouvindo em todas as interfaces (MySQL 3306/33060, FTP 21, 3000, 3001, 9443, 6081). O firewall bloqueia (padrão negar entrada), mas é uma camada só. Regra `8433:8443` provavelmente devia ser só `8443`. | Baixa | **Atenção** (não são da loja; não mexer sem os responsáveis) |
| V6 | `/backups/` e `/storage/` respondem 308 (o Next tira a barra final) em vez de 404 direto. | Baixa | **Aprovado** (seguindo o redirecionamento: 404) |
| V7 | Pasta `storage/` (fotos, XML e DANFE das notas, com dados de cliente) aberta para outros usuários (775). | Média | **Corrigido** no código (`UMask=0027` na API; o script agora confere a pasta); permissão da pasta a corrigir no servidor |

**Aprovado no servidor:** firewall ativo com entrada negada por padrão; PostgreSQL da loja só em 127.0.0.1 com
`scram-sha-256`; `.env` e `credentials.json` com permissão 600 e `pgdata` 700; serviços da loja ativos, sem
reinício e sem erro nem resposta 5xx nas últimas 24 h; nenhum simulador ligado em produção; nginx válido, com
`server_tokens off` e o limite por IP instalado; HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` e CSP da loja presentes; `.env`, `.git`, `.local`, `package.json` e travessia de caminho
inacessíveis pela web; `npm audit` sem vulnerabilidades; backup diário rodando.

### 3.4 Não testado ou pendente

- CSP do painel e da loja, HSTS e `X-Frame-Options` pelo domínio: **Aprovado** (14/11/2026, certificado Let's Encrypt
  até 12/02/2027). Cookies `Secure`/`HttpOnly` e IP real na Auditoria: **Pendente** (conferir no navegador).
- CSP completa da loja com o SDK do Mercado Pago: **Pendente** (sandbox).
- Teste de intrusão externo (varredura de portas, TLS) contra o servidor: **Não testado** (fora do escopo sem
  autorização e janela combinadas).

## 4. Integridade comercial

Testes automatizados em `apps/api/test/audit.test.ts`, contra o banco de teste:

| Cenário | Resultado |
|---|---|
| Última unidade: 8 clientes finalizam ao mesmo tempo | Exatamente 1 pedido; estoque 1 em mãos / 1 reservado. **Aprovado** |
| Mesmo checkout enviado 6 vezes ao mesmo tempo (clique duplo, rede lenta) | 1 pedido (chave de idempotência + carrinho travado). **Aprovado** |
| 20 ajustes de estoque simultâneos no mesmo item | Saldo final certo e igual à soma do histórico de movimentos. **Aprovado** |
| Preço alterado entre o carrinho e o checkout | 409 `PRICE_CHANGED`, nenhum pedido criado. **Aprovado** |
| Checkout com carrinho esvaziado por falha anterior (visto no teste de estresse) | 422 `CART_EMPTY`, nada gravado. **Aprovado** |
| Pagamento real, webhook real e estorno | **Pendente** (sandbox do Mercado Pago) |

## 5. Desempenho e capacidade (local)

Jornada de cada usuário virtual, com pausas de leitura reais: página inicial → departamento → busca → produto (+
disponibilidade) → adiciona ao carrinho → altera quantidade → carrinho → frete → inicia o checkout. Cada usuário
aparece com IP próprio, para medir a loja e não o limitador por IP.

Tempos em milissegundos. "Páginas" = HTML renderizado pelo Next; "API" = chamadas JSON do navegador (carrinho,
disponibilidade, frete, checkout). Falhas = erro de rede ou status inesperado (as recusas planejadas do checkout,
409/503, não contam).

### 5.1 Antes das otimizações

| Cenário | Usuários | Req/s | Falhas | Páginas mediana | p95 | p99 | API mediana | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| inicial | 10 | 5,7 | 0% | 31 | 60 | 317 | 8,8 | 18 | 26 |
| baixo | 25 | 14 | 0% | 32 | 69 | 624 | 9,4 | 18 | 26 |
| médio | 50 | 28 | 0% | 32 | 66 | 993 | 9,0 | 16 | 22 |
| elevado | 100 | 55 | 0% | 41 | 118 | 1.874 | 10 | 20 | 30 |
| avançado | 200 | 103 | 0% | 102 | 1.340 | 3.482 | 15 | 63 | 209 |
| pico (10 → 200 em 10 s) | 200 | 59 | 0% | 86 | 654 | 1.139 | 14 | 72 | 139 |
| estresse (degraus até 800) | parou em 500 | 111 | 0,02% | 657 | 4.029 | 5.134 | 154 | 1.621 | 2.037 |

Recursos (média / máximo no cenário, núcleos em uso): avançado — Node 1,2 / 2,5 núcleos, 837 MB; PostgreSQL 1,0 / 2,4
núcleos, 68 MB; máquina 45% / 62%. Estresse — Node até 4,6 núcleos e 1,9 GB; PostgreSQL até 3,7 núcleos.

### 5.2 Depois das otimizações

| Cenário | Usuários | Req/s | Falhas | Páginas mediana | p95 | p99 | API mediana | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| médio | 50 | 28 | 0% | 35 | 68 | 1.415 | 9,5 | 18 | 29 |
| elevado | 100 | 54 | 0% | 37 | 98 | 1.801 | 9,6 | 19 | 27 |
| avançado | 200 | 101 | 0% | 161 | 1.734 | 3.670 | 18 | 95 | 188 |
| pico (10 → 200 em 10 s) | 200 | 60 | 0% | 74 | 520 | 767 | 15 | 65 | 142 |
| estresse (degraus até 800) | parou em 500 | 111 | 0% | 815 | 4.034 | 5.284 | 181 | 1.325 | 1.673 |
| resistência (50 por 15 min) | 50 | 29 | 0% | 36 | 65 | 104 | 10 | 19 | 26 |

Recursos: avançado — Node 1,1 / 2,3 núcleos, 681 MB (antes 837 MB); estresse — Node até 1,7 GB (antes 1,9 GB).

### 5.3 Leitura dos resultados

- **Até 100 usuários simultâneos: sem degradação.** Mediana das páginas em ~35–40 ms e p95 abaixo de 120 ms; API
  com p95 de 20 ms. Nenhuma falha.
- **200 usuários: degradação moderada, sem erro.** p95 das páginas sobe para 1,3–1,7 s (a mediana segue em 0,1–0,16 s).
- **Saturação entre 200 e 300 usuários** nesta máquina: a vazão estaciona em ~110 req/s e daí em diante só a fila cresce.
  O estresse parou sozinho em 500 usuários (p95 das páginas acima de 4 s), nas duas rodadas.
- **Pico súbito** (10 → 200 em 10 s) absorvido sem falha.
- **Resistência** (50 usuários por 15 min, ~26 mil requisições): sem falha e sem piora no tempo; memória do Node
  estável (média por trecho de 3 min: 524, 497, 533, 504, 482 MB) e conexões do PostgreSQL constantes. Sem sinal de
  vazamento **nesse intervalo**; um teste de horas fica para o servidor.
- **O gargalo é a renderização das páginas no Next** (um processo, uma thread de JavaScript), não o banco nem a API:
  sob 200 usuários a API respondia em p95 de 63–95 ms enquanto as páginas passavam de 1 s. Custo de cada página sem
  carga: inicial 63 ms, busca 49 ms, departamento 47 ms, produto 31 ms, carrinho 15 ms (mediana de 20 acessos); o HTML
  tem 46–147 KB sem compressão, dos quais ~60% são os dados de hidratação do React (6–13 KB comprimidos).
- **Antes × depois**: dentro da variação entre rodadas na mesma máquina. O cache de departamentos e dados da loja tirou
  2 das 3–5 chamadas à API por página (conferido no log da API), mas a API não era o gargalo; a memória do Node caiu
  ~15–20%. **Não houve ganho de capacidade mensurável** e este relatório não afirma um.
- **Falhas no estresse (12 de 48 mil, só na rodada "antes")**: 4 conexões encerradas pelo servidor em
  `POST /cart/items` acima da saturação e, em consequência, 4 carrinhos vazios no checkout (422 `CART_EMPTY`, nada
  gravado) e 4 atualizações de item inexistente. Sem erro no log da API nem do Next. Causa provável: limite de sockets
  do Windows com o gerador de carga na mesma máquina; **não confirmado**.
- **Para o VPS (2 vCPU divididos com o banco, a API e outros sites)**, a expectativa é bem menor que os números acima.
  Só a medição lá dá o número real.

## 6. Banco de dados

EXPLAIN ANALYZE no banco de demonstração (sem carga):

| Consulta | Tempo |
|---|---:|
| Listagem: contagem total | 6,0 ms |
| Listagem: página com 24 cards | 7,7 ms |
| Busca "caixa" | 6,1 ms |
| Departamentos com contagem | 0,4 ms |
| Produto pelo endereço | 0,2 ms |

- As varreduras sequenciais que aparecem são corretas para o tamanho atual (~200 variações): o PostgreSQL prefere ler a
  tabela inteira a usar o índice. Os índices de produto, variação, embalagem, estoque e busca (trigrama) existem.
- **Índice novo** (`0011_indice_fotos`): o card busca a foto principal por `product_id` ordenando por principal e
  posição, e só existia o índice parcial das principais. Medido numa transação desfeita com 20 mil fotos fictícias:
  página de 24 cards de **57 ms para 8 ms**. Custo: uma escrita a mais ao enviar foto (operação rara, do painel).
- Conexões: pool de 10 por instância da API, `statement_timeout` 30 s; no pico do estresse o PostgreSQL usou até
  3,7 núcleos e 69 MB, sem fila de conexão visível.
- **Atenção**: sessões vencidas e carrinhos abandonados ficam no banco para sempre. Não foram apagados porque são
  histórico (sessão) e dado comercial (carrinho); recomendação: política de retenção decidida por você (ex.: carrinho
  sem pedido há mais de 90 dias).

## 7. Front-end (Lighthouse 12.8, build de produção, local)

Perfil celular = Moto G simulado com 4G lento e CPU 4× mais lenta (padrão do Lighthouse); computador = preset desktop.

| Página | Perfil | Desempenho | Acessibilidade (antes → depois) | Boas práticas | SEO (antes → depois) | LCP | CLS | TBT |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Inicial | celular | 96–97 | 86 → **100** | 96 | 100 | 2,5 s | 0,002 | 67–69 ms |
| Inicial | computador | 100 | 96 → **100** | 96 | 100 | 0,55 s | 0,008 | 0 ms |
| Departamento | celular | 96–97 | 87 → **100** | 96 | 90 → **100** | 2,5 s | 0,009 | 56–75 ms |
| Departamento | computador | 100 | 96 → **100** | 96 | 90 → **100** | 0,55 s | 0,004 | 0 ms |
| Produto | celular | 96–97 | 86 → **100** | 96 | 100 | 2,6 s | 0,019 | 58–72 ms |
| Produto | computador | 100 | 96 → **100** | 96 | 100 | 0,56 s | 0,003 | 1–2 ms |

- LCP no celular em 2,5–2,6 s fica no limite do "bom" (2,5 s) **no 4G lento simulado**; CLS bem abaixo de 0,1
  (página de produto estável, conferido na rodada anterior). INP não é medido pelo Lighthouse sem interação
  (**Não testado**; TBT baixo é o indicador indireto).
- "Boas práticas" 96: o único item é o `favicon.ico` inexistente (404 no console). **Pendente**: depende do logotipo da
  loja, que ainda não foi definido.
- Medido sem fotos de produto (o demo não tem): com fotos reais o LCP passa a ser a imagem. As fotos saem em WebP em
  3 tamanhos. **Corrigido**: a foto principal da página de produto baixava sempre a versão de 1600 px e sem prioridade;
  agora tem `srcSet` 800/1600 e `fetchPriority="high"`. **Atenção**: as fotos dos cards são todas `loading="lazy"`,
  inclusive as da primeira dobra da página inicial. Refazer o Lighthouse com o catálogo real antes de mexer nisso.

## 8. Correções feitas nesta auditoria

| Correção | Onde | Reversão |
|---|---|---|
| Bloqueio progressivo no login de cliente (S1) | `apps/api/src/modules/customers.ts`, `auth.ts` | reverter o commit |
| `fast-xml-parser` 5.12.1 (S2) | `apps/api/package.json` | — |
| CSP no painel e parcial na loja (S3) | `apps/web/next.config.ts` (só em produção) | reverter o commit |
| Limite por IP e `server_tokens off` no nginx (S4) | `deploy/nginx/` | instruções em `00-loja-limites.conf` |
| Limpeza de contadores vencidos (S5) | `apps/api/src/server.ts` (de hora em hora) | reverter o commit |
| Índice das fotos dos cards | migração `0011_indice_fotos` | `0011_indice_fotos.down.sql` |
| Cache de 60 s para departamentos e dados da loja (preço, estoque, carrinho e pedido continuam sempre frescos) | `apps/web/src/lib/store.ts` | reverter o commit |
| Acessibilidade: nome no botão de busca e no link da conta (celular), rótulo do carrinho igual ao texto visível, contraste do "Foto em breve", cabeçalhos na tabela de preço por quantidade | componentes da loja | reverter o commit |
| Foto principal do produto com `srcSet` 800/1600 e prioridade alta | `apps/web/src/components/loja/gallery.tsx` | reverter o commit |
| SEO: departamento sem descrição própria herda a descrição da loja | `apps/web/src/app/(loja)/c/[slug]/page.tsx` | reverter o commit |
| Testes de auditoria (11) | `apps/api/test/audit.test.ts` | — |

Após as correções: 154 testes da API passando e verificação de tipos da API e do site sem erro.

Efeito colateral conhecido do cache: um departamento criado, renomeado ou desativado no painel leva até 60 s para
aparecer no menu da loja.

## 9. Recomendações de infraestrutura

Em ordem de prioridade. Nenhuma foi aplicada no servidor.

1. **Corrigir os achados do servidor** (seção 3.3): permissões das cópias de backup já existentes, SSH só com
   chave e sem senha para o root, atualizações de segurança numa janela de pouco movimento.
2. **Aplicar o limite por IP do nginx** (`00-loja-limites.conf`), com `nginx -t` antes do reload.
3. **Medir no VPS** com o roteiro de `tests/carga/README.md` (cenário `fumaca` e depois `inicial`, fora do horário de
   movimento, com `vmstat -w 2` aberto). É o único jeito de saber a capacidade real.
4. **Backup fora do servidor** e teste de restauração lá (já pendente em TESTES-PENDENTES).
5. **Monitoramento**: aviso quando a loja não responder (ex.: verificador externo de disponibilidade a cada minuto
   na página inicial) e alerta de disco/memória do VPS. Hoje não há nenhum.
6. **Se a medição no VPS mostrar fila nas páginas com movimento real**, as opções, da mais barata para a mais cara:
   - cache curto da página inteira só para página inicial e departamentos (ex.: 30 s). Preço e estoque nessas páginas
     passariam a ter até 30 s de atraso; o checkout continua seguro (confere preço e reserva estoque na transação).
     **Decisão sua**, por mudar o que o cliente vê;
   - segunda instância do Next atrás do nginx (cada uma usa ~1 núcleo sob carga; com 2 vCPU divididos, ganho limitado);
   - VPS maior ou separar o banco.
7. **Retenção** de sessões vencidas e carrinhos abandonados (seção 6).
8. Tornar o repositório do GitHub **privado** (S6).

## 10. Como repetir

- Testes automatizados: `npm test -w apps/api` (inclui `audit.test.ts`).
- Carga: [tests/carga/README.md](../tests/carga/README.md) (`jornada.js`, cenários e regras para o servidor).
- Servidor: `sudo bash /srv/loja-embalagens/deploy/auditoria-servidor.sh 2>&1 | tee ~/auditoria-$(date +%F).txt`.
