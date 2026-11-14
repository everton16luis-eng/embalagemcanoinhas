export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown };

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    const first = e?.issues?.[0];
    const message = e?.code === 'VALIDATION_ERROR' && first ? `${first.message}${first.field ? ` (${first.field})` : ''}` : (e?.message ?? 'Algo deu errado. Tente novamente.');
    throw new ApiError(res.status, e?.code ?? 'ERROR', message, e?.issues);
  }
  return data as T;
}

export async function api<T = any>(path: string, options: Options = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  const res = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  }).catch(() => {
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor. Verifique a internet e tente novamente.');
  });
  return parse<T>(res);
}

export async function upload<T = any>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', body: form }).catch(() => {
    throw new ApiError(0, 'NETWORK', 'Não foi possível enviar o arquivo.');
  });
  return parse<T>(res);
}

/** Envio de arquivo com andamento (fetch nao informa o progresso do upload). */
export function uploadWithProgress<T = any>(path: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Não foi possível enviar o arquivo. Verifique a conexão.'));
    xhr.onload = () => {
      const headers = new Headers({ 'Content-Type': xhr.getResponseHeader('Content-Type') ?? 'application/json' });
      // Proxy (nginx) pode responder 413 em HTML: a mensagem fica a nossa.
      const body = xhr.status === 413 && !headers.get('Content-Type')!.includes('json') ? JSON.stringify({ error: { code: 'FILE_TOO_LARGE', message: 'A imagem deve ter no máximo 8 MB.' } }) : xhr.responseText;
      parse<T>(new Response(body || null, { status: xhr.status, headers })).then(resolve, reject);
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export const imageUrl =(key: string, size: 320 | 800 | 1600 = 320) => `/api/v1/public/images/${key}/${size}.webp`;
