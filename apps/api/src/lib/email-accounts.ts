// Caixas de e-mail do dominio da loja. A API nao edita os arquivos do servidor: conversa com o script
// /usr/local/sbin/loja-contas-email pelo socket do systemd (EMAIL_ACCOUNTS_SOCKET), que so enxerga o dominio da loja.
// Sem o socket, a tela mostra o procedimento manual; nada e simulado.
//
// A senha vai so pelo socket (nunca em argumento, log ou banco) e la vira hash do Dovecot.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { config } from '../config.js';
import { AppError } from './errors.js';

export type AccountsRunner = (action: string, data?: Record<string, unknown>) => Promise<Record<string, unknown>>;

const TIMEOUT_MS = 60_000;

function parse(output: string, failure: () => AppError) {
  let res: { ok?: boolean; erro?: string } | null = null;
  try {
    res = JSON.parse(output.trim().split('\n').pop() || 'null');
  } catch {
    // resposta invalida
  }
  if (res?.ok) return res as Record<string, unknown>;
  if (res?.erro) throw new AppError(400, 'EMAIL_ACCOUNT_REJECTED', res.erro);
  throw failure();
}

const unreachable = () => new AppError(502, 'EMAIL_ACCOUNTS_UNAVAILABLE', 'O servidor de e-mail não respondeu. Confira o loja-contas-email.socket (docs/EMAIL.md).');

/** Fala com o script pelo socket do systemd: envia o pedido, fecha a escrita e le a resposta. */
export function socketRunner(path: string): AccountsRunner {
  return (action, data = {}) =>
    new Promise((resolve, reject) => {
      let out = '';
      const sock = net.createConnection(path);
      sock.setEncoding('utf8');
      sock.setTimeout(TIMEOUT_MS, () => sock.destroy(new Error('timeout')));
      sock.on('connect', () => sock.end(JSON.stringify({ acao: action, ...data })));
      sock.on('data', (d) => (out += d));
      sock.on('error', () => reject(unreachable()));
      sock.on('close', (hadError) => {
        if (hadError) return;
        try {
          resolve(parse(out, unreachable));
        } catch (e) {
          reject(e);
        }
      });
    });
}

/** Testes: roda o script direto (python + --raiz numa pasta temporaria), com o mesmo protocolo. */
export function commandRunner(command: string, args: string[]): AccountsRunner {
  return (action, data = {}) =>
    new Promise((resolve, reject) => {
      let out = '';
      const p = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: TIMEOUT_MS, windowsHide: true });
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => reject(unreachable()));
      p.on('close', () => {
        try {
          resolve(parse(out, unreachable));
        } catch (e) {
          reject(e);
        }
      });
      p.stdin.on('error', () => {});
      p.stdin.end(JSON.stringify({ acao: action, ...data }));
    });
}

export const accountsFromConfig = (): AccountsRunner | null => (config.EMAIL_ACCOUNTS_SOCKET ? socketRunner(config.EMAIL_ACCOUNTS_SOCKET) : null);
