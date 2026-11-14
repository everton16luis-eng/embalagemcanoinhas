#!/usr/bin/python3 -I
# Caixas de e-mail da LOJA (embalagemcanoinhas.com.br) no Postfix + Dovecot do servidor, chamado pelo painel da loja.
#
# Adaptado do script do portal (portal-noticias-sc/scripts/servidor/portal-contas-email.py), que continua como esta.
# Diferencas:
#   - Só enxerga e altera endereços do domínio DOMINIO abaixo. Caixas e apelidos dos outros sites do servidor
#     (portal, barbasystem...) não aparecem e não podem ser alterados por aqui.
#   - Roda pelo socket do systemd (deploy/systemd/loja-contas-email.socket), não por sudo: a API da loja continua com
#     NoNewPrivileges e ProtectSystem=strict. Só o grupo "loja" abre o socket.
#   - Usa a MESMA trava do script do portal: os dois nunca gravam ao mesmo tempo nos arquivos do servidor.
#   - A versão anterior de cada arquivo alterado fica em <arquivo>.loja-bak.
#
# Instale como root FORA do repositório (o painel não pode conseguir alterar este arquivo):
#   install -o root -g root -m 755 deploy/email/loja-contas-email.py /usr/local/sbin/loja-contas-email
# Detalhes em docs/EMAIL.md.
#
# Protocolo: um objeto JSON na entrada ({"acao": ..., ...}); a resposta é um objeto JSON na saída
# ({"ok": true, ...} ou {"ok": false, "erro": "..."}). A senha chega só pela entrada, é transformada em hash pelo
# openssl (também pela entrada padrão) e nunca é escrita em log, argumento ou saída.
#
# Só mexe nestes arquivos (os mesmos da configuração atual do servidor):
#   /etc/dovecot/users                 senhas (passwd-file do Dovecot, relido sozinho a cada alteração)
#   /etc/postfix/virtual_domains       domínios aceitos (só leitura)
#   /etc/postfix/virtual_mailboxes     caixas que recebem e-mail (postmap depois de alterar)
#   /etc/postfix/virtual_aliases       apelidos/encaminhamentos (postmap depois de alterar)
#   /var/mail/vhosts/<domínio>/<nome>  pastas das caixas (excluir MOVE para /var/mail/vhosts-excluidas)

import json
import os
import re
import shutil
import subprocess
import sys
import time

ARQUIVOS = {
    'usuarios': '/etc/dovecot/users',
    'dominios': '/etc/postfix/virtual_domains',
    'caixas': '/etc/postfix/virtual_mailboxes',
    'apelidos': '/etc/postfix/virtual_aliases',
}
PASTA_CAIXAS = '/var/mail/vhosts'
PASTA_EXCLUIDAS = '/var/mail/vhosts-excluidas'
# Mesma trava do script do portal (de propósito): serializa as gravações dos dois.
TRAVA = '/run/lock/portal-contas-email.lock'
# Único domínio que este script enxerga e altera.
DOMINIO = 'embalagemcanoinhas.com.br'

RE_LOCAL = re.compile(r'^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$')
RE_DOMINIO = re.compile(r'^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$')
# Campo extra do passwd-file que bloqueia o login (IMAP e envio autenticado) sem apagar a senha.
BLOQUEIO = 'nologin=y'


class Erro(Exception):
    pass


def configurar_teste(argv):
    """--raiz <pasta>, --dominio <d> e --sem-postmap só valem fora do root: servem para os testes automáticos."""
    global PASTA_CAIXAS, PASTA_EXCLUIDAS, TRAVA, POSTMAP, DOMINIO
    if '--raiz' not in argv:
        return
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        raise Erro('--raiz não é aceito quando executado como root.')
    raiz = argv[argv.index('--raiz') + 1]
    for chave, caminho in ARQUIVOS.items():
        ARQUIVOS[chave] = os.path.join(raiz, caminho.lstrip('/'))
    PASTA_CAIXAS = os.path.join(raiz, PASTA_CAIXAS.lstrip('/'))
    PASTA_EXCLUIDAS = os.path.join(raiz, PASTA_EXCLUIDAS.lstrip('/'))
    TRAVA = os.path.join(raiz, 'trava.lock')
    if '--sem-postmap' in argv:
        POSTMAP = False
    if '--dominio' in argv:
        DOMINIO = argv[argv.index('--dominio') + 1].lower()


POSTMAP = True


# ---------------- leitura ----------------

def ler_linhas(chave):
    try:
        with open(ARQUIVOS[chave], encoding='utf-8') as f:
            return f.read().splitlines()
    except FileNotFoundError:
        return []


def entradas_mapa(chave):
    """Linhas "chave valor" de um mapa do Postfix (ignora comentários e linhas vazias)."""
    itens = []
    for i, linha in enumerate(ler_linhas(chave)):
        texto = linha.strip()
        if not texto or texto.startswith('#'):
            continue
        partes = texto.split(None, 1)
        itens.append((i, partes[0].lower(), partes[1].strip() if len(partes) > 1 else ''))
    return itens


def dominios():
    return sorted({k for _, k, _ in entradas_mapa('dominios')})


def contas_dovecot():
    contas = {}
    for i, linha in enumerate(ler_linhas('usuarios')):
        if not linha.strip() or linha.lstrip().startswith('#') or ':' not in linha:
            continue
        campos = linha.split(':')
        extras = campos[7].split() if len(campos) > 7 else []
        contas[campos[0].lower()] = {'linha': i, 'campos': campos, 'suspensa': BLOQUEIO in extras or 'nologin' in extras}
    return contas


def apelidos():
    return {k: [d for d in re.split(r'[\s,]+', v) if d] for _, k, v in entradas_mapa('apelidos')}


def tamanho_pasta(caminho):
    total = 0
    for raiz, _, arquivos in os.walk(caminho):
        for a in arquivos:
            try:
                total += os.lstat(os.path.join(raiz, a)).st_size
            except OSError:
                pass
    return total


def protocolos():
    try:
        r = subprocess.run(['doveconf', '-h', 'protocols'], capture_output=True, text=True, timeout=10)
        return r.stdout.split() if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


# ---------------- escrita ----------------

def gravar(chave, linhas):
    """Grava de forma atômica, mantendo dono e permissões; guarda a versão anterior em .loja-bak."""
    caminho = ARQUIVOS[chave]
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    existe = os.path.exists(caminho)
    if existe:
        shutil.copy2(caminho, caminho + '.loja-bak')
    temporario = caminho + '.loja-tmp'
    with open(temporario, 'w', encoding='utf-8') as f:
        f.write('\n'.join(linhas) + ('\n' if linhas else ''))
    if existe:
        info = os.stat(caminho)
        os.chmod(temporario, info.st_mode & 0o7777)
        if hasattr(os, 'chown') and hasattr(os, 'geteuid') and os.geteuid() == 0:
            os.chown(temporario, info.st_uid, info.st_gid)
    os.replace(temporario, caminho)
    if chave in ('caixas', 'apelidos') and POSTMAP:
        r = subprocess.run(['postmap', 'hash:' + caminho], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise Erro('postmap falhou: ' + (r.stderr.strip()[:300] or 'sem detalhes'))


def gerar_hash(senha):
    validar_senha(senha)
    openssl = os.environ.get('LOJA_CONTAS_OPENSSL') if not (hasattr(os, 'geteuid') and os.geteuid() == 0) else None
    r = subprocess.run([openssl or 'openssl', 'passwd', '-6', '-stdin'], input=senha + '\n', capture_output=True, text=True, timeout=30)
    hash_ = r.stdout.strip()
    if r.returncode != 0 or not hash_.startswith('$6$') or ':' in hash_:
        raise Erro('Não foi possível gerar o hash da senha (openssl).')
    return '{SHA512-CRYPT}' + hash_


def validar_senha(senha):
    if not isinstance(senha, str) or len(senha) < 10 or len(senha) > 200:
        raise Erro('A senha precisa ter de 10 a 200 caracteres.')
    if any(ord(c) < 32 or ord(c) == 127 for c in senha):
        raise Erro('A senha não pode ter quebras de linha nem caracteres de controle.')


def validar_endereco(endereco, proprio=True):
    """proprio=True: endereço da loja (caixa ou apelido), só do DOMINIO e só se o servidor atende o domínio.
    proprio=False: destino de um apelido, que pode ser de qualquer domínio (ex.: um Gmail)."""
    if not isinstance(endereco, str):
        raise Erro('Endereço inválido.')
    endereco = endereco.strip().lower()
    if endereco.count('@') != 1:
        raise Erro('Endereço inválido.')
    local, dominio = endereco.split('@')
    if not RE_LOCAL.match(local) or '..' in local:
        raise Erro('Nome inválido: use letras minúsculas, números, ponto, hífen ou sublinhado (até 64).')
    if not RE_DOMINIO.match(dominio):
        raise Erro('Domínio inválido.')
    if proprio and dominio != DOMINIO:
        raise Erro('Só é possível usar endereços @' + DOMINIO + '.')
    if proprio and DOMINIO not in dominios():
        raise Erro('O domínio ' + DOMINIO + ' ainda não foi incluído no servidor de e-mail (virtual_domains).')
    return endereco, local, dominio


def em_uso(endereco):
    return endereco in contas_dovecot() or endereco in {k for _, k, _ in entradas_mapa('caixas')} or endereco in apelidos()


def valor_caixa(local, dominio):
    """Segue o formato das caixas existentes (ex.: "dominio/nome/"); sem nenhuma, usa esse padrão."""
    for _, chave, valor in entradas_mapa('caixas'):
        l, d = chave.split('@') if '@' in chave else (chave, '')
        if d and l and (d + '/' + l) in valor:
            return valor.replace(d + '/' + l, dominio + '/' + local)
        if valor and l not in valor and d not in valor:
            return valor  # mapa só de existência (ex.: "OK")
    return dominio + '/' + local + '/'


def linha_dovecot(endereco, hash_, modelo=None):
    """Mesma quantidade de campos das linhas existentes (ex.: "user:hash" ou "user:hash::::::")."""
    n = len(modelo) if modelo else 2
    return ':'.join([endereco, hash_] + [''] * (n - 2))


def alterar_extras(campos, bloquear):
    campos = list(campos) + [''] * (8 - len(campos)) if len(campos) < 8 else list(campos)
    extras = [e for e in campos[7].split() if e not in (BLOQUEIO, 'nologin')]
    if bloquear:
        extras.append(BLOQUEIO)
    campos[7] = ' '.join(extras)
    return campos


# ---------------- ações ----------------

def do_dominio(endereco):
    return endereco.rpartition('@')[2] == DOMINIO


def acao_info(_):
    contas = contas_dovecot()
    caixas = {k for _, k, _ in entradas_mapa('caixas')}
    lista = []
    for endereco in sorted(e for e in set(contas) | caixas if do_dominio(e)):
        local, _, dominio = endereco.partition('@')
        pasta = os.path.join(PASTA_CAIXAS, dominio, local)
        lista.append({
            'endereco': endereco,
            'login': endereco in contas,
            'recebe': endereco in caixas,
            'suspensa': contas.get(endereco, {}).get('suspensa', False),
            'uso_bytes': tamanho_pasta(pasta) if os.path.isdir(pasta) else 0,
        })
    return {'dominio': DOMINIO, 'dominio_atendido': DOMINIO in dominios(), 'contas': lista,
            'apelidos': [{'origem': k, 'destinos': v} for k, v in sorted(apelidos().items()) if do_dominio(k)],
            'protocolos': protocolos()}


def acao_criar(d):
    endereco, local, dominio = validar_endereco(d.get('endereco'))
    if em_uso(endereco):
        raise Erro('Este endereço já existe (caixa ou apelido).')
    hash_ = gerar_hash(d.get('senha'))
    contas = contas_dovecot()
    modelo = next(iter(contas.values()))['campos'] if contas else None
    gravar('usuarios', ler_linhas('usuarios') + [linha_dovecot(endereco, hash_, modelo)])
    gravar('caixas', ler_linhas('caixas') + [endereco + ' ' + valor_caixa(local, dominio)])
    return {'endereco': endereco}


def conta_existente(d):
    endereco, _, _ = validar_endereco(d.get('endereco'))
    conta = contas_dovecot().get(endereco)
    if not conta:
        raise Erro('Caixa não encontrada.')
    return endereco, conta


def acao_senha(d):
    endereco, conta = conta_existente(d)
    campos = list(conta['campos'])
    campos[1] = gerar_hash(d.get('senha'))
    linhas = ler_linhas('usuarios')
    linhas[conta['linha']] = ':'.join(campos)
    gravar('usuarios', linhas)
    return {'endereco': endereco}


def acao_bloqueio(d, bloquear):
    endereco, conta = conta_existente(d)
    linhas = ler_linhas('usuarios')
    campos = alterar_extras(conta['campos'], bloquear)
    if not bloquear:
        # Sem campo extra, volta ao formato das demais linhas (ex.: "user:hash").
        outras = [c['campos'] for e, c in contas_dovecot().items() if e != endereco]
        minimo = len(outras[0]) if outras else 2
        while len(campos) > minimo and campos[-1] == '':
            campos.pop()
    linhas[conta['linha']] = ':'.join(campos)
    gravar('usuarios', linhas)
    return {'endereco': endereco, 'suspensa': bloquear}


def acao_excluir(d):
    endereco, local, dominio = validar_endereco(d.get('endereco'))
    if not em_uso(endereco) or endereco in apelidos():
        raise Erro('Caixa não encontrada.')
    destinos = [k for k, v in apelidos().items() if endereco in v]
    if destinos:
        nomes = [k for k in destinos if do_dominio(k)]
        lista = ', '.join(nomes) if nomes else 'de outro domínio do servidor'
        raise Erro('Esta caixa recebe apelidos (' + lista + '). Remova ou altere os apelidos antes.')
    contas = contas_dovecot()
    if endereco in contas:
        linhas = ler_linhas('usuarios')
        del linhas[contas[endereco]['linha']]
        gravar('usuarios', linhas)
    caixas = [i for i, k, _ in entradas_mapa('caixas') if k == endereco]
    if caixas:
        gravar('caixas', [l for i, l in enumerate(ler_linhas('caixas')) if i not in caixas])
    pasta = os.path.join(PASTA_CAIXAS, dominio, local)
    arquivada = None
    if os.path.isdir(pasta):
        arquivada = os.path.join(PASTA_EXCLUIDAS, dominio, local + '-' + time.strftime('%Y%m%d-%H%M%S'))
        os.makedirs(os.path.dirname(arquivada), mode=0o700, exist_ok=True)
        shutil.move(pasta, arquivada)
    return {'endereco': endereco, 'mensagens_arquivadas_em': arquivada}


def acao_apelido(d):
    origem, _, _ = validar_endereco(d.get('origem'))
    destinos = d.get('destinos')
    if not isinstance(destinos, list) or not 1 <= len(destinos) <= 10:
        raise Erro('Informe de 1 a 10 destinos.')
    validos = []
    for destino in destinos:
        e, _, _ = validar_endereco(destino, proprio=False)
        if e == origem:
            raise Erro('O apelido não pode apontar para ele mesmo.')
        if e not in validos:
            validos.append(e)
    atuais = apelidos()
    if d.get('novo') and em_uso(origem):
        raise Erro('Este endereço já existe (caixa ou apelido).')
    if not d.get('novo') and origem not in atuais:
        raise Erro('Apelido não encontrado.')
    if origem in contas_dovecot() or origem in {k for _, k, _ in entradas_mapa('caixas')}:
        raise Erro('Já existe uma caixa com este endereço.')
    linhas = [l for i, l in enumerate(ler_linhas('apelidos')) if i not in {j for j, k, _ in entradas_mapa('apelidos') if k == origem}]
    gravar('apelidos', linhas + [origem + ' ' + ', '.join(validos)])
    return {'origem': origem, 'destinos': validos}


def acao_excluir_apelido(d):
    origem, _, _ = validar_endereco(d.get('origem'))
    remover = {i for i, k, _ in entradas_mapa('apelidos') if k == origem}
    if not remover:
        raise Erro('Apelido não encontrado.')
    gravar('apelidos', [l for i, l in enumerate(ler_linhas('apelidos')) if i not in remover])
    return {'origem': origem}


ACOES = {
    'info': acao_info,
    'criar': acao_criar,
    'senha': acao_senha,
    'suspender': lambda d: acao_bloqueio(d, True),
    'reativar': lambda d: acao_bloqueio(d, False),
    'excluir': acao_excluir,
    'apelido': acao_apelido,
    'excluir_apelido': acao_excluir_apelido,
}


def travar():
    try:
        import fcntl
    except ImportError:  # Windows (só nos testes)
        return None
    os.makedirs(os.path.dirname(TRAVA), exist_ok=True)
    f = open(TRAVA, 'w')
    fcntl.flock(f, fcntl.LOCK_EX)
    return f


def main():
    try:
        for fluxo in (sys.stdin, sys.stdout):
            fluxo.reconfigure(encoding='utf-8')
        configurar_teste(sys.argv[1:])
        bruto = sys.stdin.read(65536)
        dados = json.loads(bruto or '{}')
        if not isinstance(dados, dict) or dados.get('acao') not in ACOES:
            raise Erro('Ação desconhecida.')
        trava = travar()
        try:
            resposta = ACOES[dados['acao']](dados)
        finally:
            if trava:
                trava.close()
        print(json.dumps({'ok': True, **resposta}, ensure_ascii=False))
        return 0
    except Erro as e:
        print(json.dumps({'ok': False, 'erro': str(e)}, ensure_ascii=False))
        return 1
    except (ValueError, OSError) as e:
        print(json.dumps({'ok': False, 'erro': 'Falha no servidor de e-mail: ' + e.__class__.__name__}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
