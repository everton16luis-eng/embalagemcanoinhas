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

2. **Cópia para fora do servidor** (outro provedor ou disco): sem isso, perder o servidor perde os backups. A pasta
   `backups/` tem dados de clientes: guardar cifrada e com acesso restrito.
3. Teste de restauração **semanal** (`backup:restore-test` na cópia mais recente) e sempre antes de atualizar o sistema.
4. Retenção: decisão sua (sugestão: 7 diários, 4 semanais, 12 mensais). O script não apaga cópias antigas.

## Restauração de verdade (perda do banco)

Feita por uma pessoa, com a API parada:

1. Conferir a cópia: `npm run backup:verify -- backups/<pasta>`.
2. Criar um banco novo vazio (dono `loja_owner`) e restaurar:
   `pg_restore -h <host> -p <porta> -U <admin> -d <banco_novo> --no-owner --role loja_owner --exit-on-error backups/<pasta>/db.dump`
3. Copiar `backups/<pasta>/storage/` para a pasta definida em `STORAGE_DIR`.
4. Apontar `DB_NAME` do `.env` para o banco novo, subir a API e conferir pedidos e notas no painel.
5. Notas emitidas **depois** do backup existem na SEFAZ e no provedor fiscal: a reconsulta da tela Nota fiscal traz a
   situação de volta, mas pedidos criados depois do backup precisam ser conferidos manualmente.
