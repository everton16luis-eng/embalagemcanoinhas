# Backup e restauração

O que precisa ser copiado: **o banco** (pedidos, notas, estoque, clientes, auditoria) **e a pasta `storage/`**
(XML e DANFE das notas emitidas, XML das notas de compra). Notas fiscais precisam ser guardadas por anos: perder o
`storage/` é tão grave quanto perder o banco.

## Comandos

```bash
npm run backup
```

Cria `backups/AAAAMMDD-HHMMSS/` (horário UTC) com:

- `db.dump`: `pg_dump` em formato custom (comprimido, restaurável com `pg_restore`);
- `storage/`: cópia dos arquivos;
- `manifest.json`: sha256 de cada arquivo, migrations aplicadas e contagem das tabelas principais.

```bash
npm run backup:verify -- backups/AAAAMMDD-HHMMSS
```

Confere o sha256 de cada arquivo da cópia (detecta arquivo alterado, faltando ou a mais).

```bash
npm run backup:restore-test -- backups/AAAAMMDD-HHMMSS
```

Restaura a cópia num **banco temporário** (`loja_restore_xxxx`), compara contagens e migrations com o manifesto,
confere se cada arquivo fiscal registrado no banco está na cópia com o mesmo hash e apaga o banco temporário. Nunca
toca no banco em uso. Para criar o banco temporário usa o superusuário do cluster local (`.local/credentials.json`)
ou, no servidor, as variáveis `RESTORE_ADMIN_USER` e `RESTORE_ADMIN_PASSWORD` (papel com permissão de criar banco).

## Rotina recomendada no servidor (Ubuntu)

1. Backup diário de madrugada, por exemplo com cron do usuário da aplicação:

   ```cron
   30 3 * * * cd /caminho/loja-embalagens && npm run backup >> /var/log/loja-backup.log 2>&1
   ```

2. **Cópia para fora do servidor**: sem ela, perder o servidor perde os backups. Feita pelo `rclone`, cifrada no
   servidor antes de sair (seção abaixo). O `loja-backup.service` roda `backup`, depois `offsite`, depois `prune`.
3. Teste de restauração **semanal** (`backup:restore-test` na cópia mais recente) e sempre antes de atualizar o sistema.
4. Retenção (15/11/2026): **7 diárias, 4 semanais, 12 mensais**, aqui e no remoto. Conta pelas cópias que existem,
   não pelo relógio: se o backup parar, nada mais é apagado. A mais nova sempre fica. Ajustável no `.env` com
   `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY` e `BACKUP_KEEP_MONTHLY`. Simulação: `node scripts/backup.mjs prune --dry-run`.

## Cópia cifrada no Google Drive (rclone)

Conta Google da loja, só para isso. O `rclone` cifra nomes e conteúdo no servidor com uma senha que só existe no
`rclone.conf` do usuário `loja` e na sua cópia guardada: o Google não lê nada. **Sem essa senha as cópias do Drive
não servem para nada** — guarde-a num gerenciador de senhas, fora do servidor, antes de ligar o envio.

1. Instalar (no servidor): `sudo apt install rclone`.
2. No seu computador (Windows), baixar o `rclone` de rclone.org/downloads (só serve para autorizar a conta).
3. No servidor, `sudo -u loja -H rclone config`:
   - `n` (novo), nome `loja-drive`, tipo `drive`; `client_id` e `client_secret` em branco;
   - escopo `drive.file` (o rclone só enxerga o que ele mesmo criou, não o resto do Drive);
   - `root_folder_id` e `service_account_file` em branco; configuração avançada `n`;
   - "Use web browser to automatically authenticate?" → `n`. O rclone mostra um comando `rclone authorize "drive" ...`:
     rode-o no seu computador, entre na conta Google da loja, e cole no servidor o token que aparecer;
   - "Configure this as a Shared Drive?" → `n`; confirmar com `y`.
4. Ainda no `rclone config`, criar o remoto cifrado:
   - `n`, nome `loja-cripto`, tipo `crypt`, remoto `loja-drive:loja-backups`;
   - cifrar nomes `standard`, cifrar pastas `true`;
   - senha: `g` (gerar), 128 bits; senha secundária (salt): `g` também. **Anote as duas** no gerenciador de senhas;
   - confirmar com `y` e sair com `q`.
5. No `.env` do servidor: `BACKUP_REMOTE=loja-cripto:`.
6. Testar: `sudo -u loja -H node scripts/backup.mjs offsite --dry-run`, depois sem `--dry-run`. O comando envia as cópias
   dentro da retenção, confere a mais nova pelo conteúdo (`rclone cryptcheck`) e só então aplica a retenção no remoto.
7. Conferir no Drive (pasta `loja-backups`): os nomes aparecem embaralhados — é o esperado.

Recuperar do Drive num servidor novo: instalar o `rclone`, refazer os passos 3 e 4 com **as mesmas senhas** anotadas e
`rclone copy loja-cripto:AAAAMMDD-HHMMSS backups/AAAAMMDD-HHMMSS`; depois seguir a restauração abaixo.

## Restauração de verdade (perda do banco)

Feita por uma pessoa, com a API parada:

1. Conferir a cópia: `npm run backup:verify -- backups/<pasta>`.
2. Criar um banco novo vazio (dono `loja_owner`) e restaurar:
   `pg_restore -h <host> -p <porta> -U <admin> -d <banco_novo> --no-owner --role loja_owner --exit-on-error backups/<pasta>/db.dump`
3. Copiar `backups/<pasta>/storage/` para a pasta definida em `STORAGE_DIR`.
4. Apontar `DB_NAME` do `.env` para o banco novo, subir a API e conferir pedidos e notas no painel.
5. Notas emitidas **depois** do backup existem na SEFAZ e no provedor fiscal: a reconsulta da tela Nota fiscal traz a
   situação de volta, mas pedidos criados depois do backup precisam ser conferidos manualmente.
