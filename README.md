# Loja de embalagens — e-commerce + ERP + fiscal

Projeto independente (nome provisório até a marca ser definida). Monorepo com a API (`apps/api`, Fastify) e o
painel/loja (`apps/web`, Next.js) sobre PostgreSQL. Não compartilha banco, código nem serviços com os outros
sistemas desta pasta.

- Diagnóstico e plano: [docs/00-diagnostico-e-plano.md](docs/00-diagnostico-e-plano.md)
- Situação das fases: [docs/ACOMPANHAMENTO.md](docs/ACOMPANHAMENTO.md)
- Implantação no servidor (Ubuntu): [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md)

## Requisitos

- Node.js 22.12 ou superior
- Binários do PostgreSQL 16, 17 ou 18 (o serviço PostgreSQL da máquina não é usado nem alterado)

## Primeira instalação (desenvolvimento)

```bash
npm install
```

```bash
npm run setup
```

O `setup` cria um cluster PostgreSQL próprio em `.local/pgdata` (porta 54330), os papéis `loja_owner` (migrations)
e `loja_app` (aplicação, sem privilégios administrativos), os bancos `loja_dev` e `loja_test`, um `.env` com
segredos aleatórios, e aplica as migrations.

Crie o primeiro proprietário. A senha inicial aparece uma única vez:

```bash
npm run create-owner -w apps/api -- email@dominio.com.br "Nome"
```

No primeiro acesso, ative a verificação em duas etapas em **Minha conta**: sem ela, dados da empresa, fiscal,
preços e usuários ficam bloqueados.

## Execução

Depois de reiniciar o computador, suba o banco do projeto:

```bash
npm run db:start
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Painel em `http://localhost:3010/painel`. API em `127.0.0.1:4010`, atrás do proxy do Next (mesma origem).

## Testes

```bash
npm test
```

Usa o banco `loja_test`. Para recriar o esquema de teste após novas migrations: `npm run migrate:test`.

## Papéis do banco

`loja_owner` é dono das tabelas e só é usado nas migrations. A API conecta como `loja_app`, que não lê hash de
senha nem segredo de MFA, não altera auditoria, histórico de preços nem versões da empresa.
