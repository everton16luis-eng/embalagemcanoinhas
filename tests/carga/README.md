# Testes de carga (k6)

Scripts da auditoria de novembro de 2026 ([docs/AUDITORIA-2026-11.md](../../docs/AUDITORIA-2026-11.md)). Servem para
repetir a medição depois de cada atualização grande.

- `jornada.js`: cliente real com pausas de leitura: página inicial → departamento → busca → produto (+ consulta de
  disponibilidade) → adiciona ao carrinho → altera a quantidade → vê o carrinho → frete → inicia o checkout.
  **Não cria pedido, pagamento nem movimento de estoque**: o checkout vai com um total esperado errado de propósito e a
  API recusa dentro da transação. Os carrinhos de teste ficam no banco até expirar.
- `resumo.mjs`: junta os resumos (`--summary-export pasta/<cenario>.json`) numa tabela com req/s, falhas e
  mediana/p95/p99 de páginas e API: `node tests/carga/resumo.mjs pasta`.
- `monitor-windows.ps1`: amostra de CPU e memória (Node e PostgreSQL) a cada 2 s, para teste local no Windows.
- Para o servidor, o monitor é o `vmstat`/`pidstat` (abaixo) e a auditoria de configuração é
  [deploy/auditoria-servidor.sh](../../deploy/auditoria-servidor.sh) (só leitura).

Os limites de segurança do script interrompem o teste sozinhos (`abortOnFail`) se mais de 5% das requisições
falharem ou se o p95 das páginas passar de 4 s.

## Cenários

| `CENARIO` | Usuários simultâneos | Duração |
|---|---:|---|
| `fumaca` | 1 | 30 s |
| `inicial` | 10 | 2 min |
| `baixo` | 25 | 2 min |
| `medio` | 50 | 3 min |
| `elevado` | 100 | 3 min |
| `avancado` | 200 | 3 min |
| `rampa` | 0 → 50 → 100 → 0 | 6 min |
| `pico` | 10 → 200 em 10 s | 2 min 20 s |
| `estresse` | degraus de 100 até 800 | até 14 min (para antes se degradar) |
| `resistencia` | `VUS` (padrão 50) | `DURACAO` (padrão 30 min) |

## Local (ambiente de teste, dados fictícios)

Banco separado com a demonstração (`loja_demo`), API compilada na porta 4011 e site de produção na 3011:

```bash
cd apps/api && DB_NAME=loja_demo npm run migrate && DB_NAME=loja_demo npm run demo -- seed --confirmar DEMO
```

```bash
npm run build -w apps/api && API_URL=http://127.0.0.1:4011 npm run build -w apps/web
```

```bash
cd apps/api && DB_NAME=loja_demo PORT=4011 RATE_LIMIT_STORE=postgres TRUST_PROXY=1 APP_ORIGIN=http://127.0.0.1:3011 node --env-file=../../.env dist/server.js
```

```bash
cd apps/web && API_URL=http://127.0.0.1:4011 npx next start -p 3011 -H 127.0.0.1
```

```bash
k6 run -e BASE_URL=http://127.0.0.1:3011 -e SIMULAR_IPS=1 -e CENARIO=medio tests/carga/jornada.js
```

`SIMULAR_IPS=1` faz cada cliente aparecer com um IP próprio (`X-Forwarded-For`, aceito só porque a API local roda
com `TRUST_PROXY=1` sem nginx na frente). Sem isso, todos os usuários virtuais dividem o limite por IP do carrinho
(120/min) e do checkout (20/min) e o teste mede o limitador, não a loja.

## No servidor (com a loja no ar)

Regras: horário de pouco movimento, avisar quem usa o painel, começar pelo `fumaca` e subir um degrau por vez,
olhando o monitor. **Nunca** usar `estresse` contra a loja em produção. Rodar o k6 de **outra máquina** (o próprio
servidor mediria a si mesmo).

No VPS, em outro terminal, o monitor:

```bash
vmstat -w 2
```

Na sua máquina:

```bash
k6 run -e BASE_URL=https://embalagemcanoinhas.com.br -e CENARIO=fumaca tests/carga/jornada.js
```

Enquanto o acesso for pelo IP provisório, acrescente `-e INSECURE=1` e use `BASE_URL=https://187.41.99.91:8447`.

No servidor o nginx sobrescreve o `X-Forwarded-For`: todos os usuários virtuais saem com o IP de quem roda o k6 e
caem no limite por IP do carrinho e do checkout. Por isso, no servidor, use no máximo o cenário `inicial` (10) para a
jornada completa; acima disso o resultado mede o limitador (respostas 429), o que é o comportamento correto contra
um único IP abusivo.
