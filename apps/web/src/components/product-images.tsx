'use client';

import { ArrowLeft, ArrowRight, Camera, ImagePlus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type DragEvent, type ReactNode, type Ref } from 'react';
import { api, imageUrl, uploadWithProgress } from '@/lib/api';
import { Badge, Notice, Panel } from './ui';

// Mesmos limites da API (apps/api/src/lib/images.ts e modules/images.ts). A API confere de novo pelo conteudo.
const MAX_IMAGES = 12;
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_SIDE = 400;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export type SavedImage = { id: string; file_key: string; is_primary: boolean; position: number; alt: string | null };
type Item =
  | { key: string; kind: 'saved'; image: SavedImage; progress?: number }
  | { key: string; kind: 'local'; file: File; preview: string; progress?: number };

/** Envio das fotos escolhidas antes do produto existir (tela de novo produto). */
export const PHOTO_ISSUES_KEY = 'painel:fotos-nao-enviadas';
export type PendingImages = { count: () => number; uploadAll: (productId: string) => Promise<string[]> };

const fileId = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
const src = (it: Item, size: 320 | 800 = 320) => (it.kind === 'saved' ? imageUrl(it.image.file_key, size) : it.preview);

/** Confere tipo, tamanho e medidas no navegador, para avisar antes de enviar. */
async function precheck(file: File): Promise<string | null> {
  if (!TYPES.includes(file.type)) return `${file.name}: use JPG, PNG ou WebP.`;
  if (file.size > MAX_BYTES) return `${file.name}: tem ${(file.size / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB; o máximo é 8 MB.`;
  try {
    const bmp = await createImageBitmap(file);
    const ok = bmp.width >= MIN_SIDE && bmp.height >= MIN_SIDE;
    bmp.close();
    if (!ok) return `${file.name}: precisa ter ao menos ${MIN_SIDE} × ${MIN_SIDE} pixels.`;
  } catch {
    return `${file.name}: não foi possível abrir como imagem.`;
  }
  return null;
}

type Props = {
  /** Sem produto: as fotos ficam no navegador e sao enviadas por `pendingRef` depois de salvar. */
  productId?: string;
  images?: SavedImage[];
  editable: boolean;
  pendingRef?: Ref<PendingImages>;
};

export function ProductImages({ productId, images = [], editable, pendingRef }: Props) {
  const [items, setItems] = useState<Item[]>(() => images.map((image) => ({ key: image.id, kind: 'saved', image })));
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  // Camera: o Android so oferece a camera quando o campo aceita image/* e um arquivo por vez.
  const cameraInput = useRef<HTMLInputElement>(null);
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(window.matchMedia('(pointer: coarse)').matches), []);
  const replaceTarget = useRef<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Libera as previas locais ao sair da tela.
  useEffect(() => () => itemsRef.current.forEach((it) => it.kind === 'local' && URL.revokeObjectURL(it.preview)), []);

  const patch = (key: string, p: Partial<Item>) => setItems((list) => list.map((it) => (it.key === key ? ({ ...it, ...p } as Item) : it)));
  const locked = !editable || busy !== '';

  // --- envio ---------------------------------------------------------------
  const send = async (productIdNow: string, it: Extract<Item, { kind: 'local' }>): Promise<string | null> => {
    try {
      const res = await uploadWithProgress<{ image: SavedImage }>(`/admin/products/${productIdNow}/images`, it.file, (f) => patch(it.key, { progress: f }));
      URL.revokeObjectURL(it.preview);
      setItems((list) => list.map((x) => (x.key === it.key ? { key: res.image.id, kind: 'saved', image: res.image } : x)));
      return null;
    } catch (e) {
      setItems((list) => list.filter((x) => x.key !== it.key));
      URL.revokeObjectURL(it.preview);
      return `${it.file.name}: ${e instanceof Error ? e.message : 'falha no envio.'}`;
    }
  };

  const addFiles = async (list: FileList | File[] | null) => {
    if (!list?.length || locked) return;
    setErrors([]);
    setDone('');
    const known = new Set(items.flatMap((it) => (it.kind === 'local' ? [fileId(it.file)] : [])));
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const f of Array.from(list)) {
      if (known.has(fileId(f))) continue; // mesma foto escolhida duas vezes
      known.add(fileId(f));
      if (items.length + accepted.length >= MAX_IMAGES) {
        problems.push(`${f.name}: limite de ${MAX_IMAGES} fotos por produto.`);
        continue;
      }
      const why = await precheck(f);
      if (why) problems.push(why);
      else accepted.push(f);
    }
    const fresh = accepted.map((file) => ({ key: `local-${crypto.randomUUID()}`, kind: 'local' as const, file, preview: URL.createObjectURL(file), progress: productId ? 0 : undefined }));
    setItems((cur) => [...cur, ...fresh]);
    if (!productId || !fresh.length) {
      setErrors(problems);
      return;
    }
    // Produto ja existe: envia na hora, uma por vez, na ordem escolhida.
    let ok = 0;
    for (const [n, it] of fresh.entries()) {
      setBusy(`Enviando ${n + 1} de ${fresh.length}…`);
      const err = await send(productId, it);
      if (err) problems.push(err);
      else ok++;
    }
    setBusy('');
    setErrors(problems);
    if (ok > 0) setDone(ok === 1 ? '1 foto enviada.' : `${ok} fotos enviadas.`);
  };

  useImperativeHandle(
    pendingRef,
    () => ({
      count: () => itemsRef.current.length,
      uploadAll: async (newId: string) => {
        const queue = itemsRef.current.filter((it): it is Extract<Item, { kind: 'local' }> => it.kind === 'local');
        const problems: string[] = [];
        for (const [n, it] of queue.entries()) {
          setBusy(`Enviando foto ${n + 1} de ${queue.length}…`);
          patch(it.key, { progress: 0 });
          const err = await send(newId, it);
          if (err) problems.push(err);
        }
        setBusy('');
        return problems;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --- ordem, principal, remover, trocar --------------------------------
  const persistOrder = async (next: Item[], previous: Item[]) => {
    setItems(next);
    if (!productId) return;
    setBusy('Salvando a ordem…');
    try {
      const ids = next.map((it) => (it.kind === 'saved' ? it.image.id : '')).filter(Boolean);
      const res = await api<{ images: SavedImage[] }>(`/admin/products/${productId}/images/order`, { method: 'PUT', body: { ids } });
      const byId = new Map(res.images.map((i) => [i.id, i]));
      setItems((cur) => cur.map((it) => (it.kind === 'saved' && byId.has(it.image.id) ? { ...it, image: byId.get(it.image.id)! } : it)));
    } catch (e) {
      setItems(previous);
      setErrors([e instanceof Error ? e.message : 'Não foi possível salvar a ordem.']);
    } finally {
      setBusy('');
    }
  };
  const move = (from: number, to: number) => {
    if (locked || to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    setErrors([]);
    setDone('');
    void persistOrder(next, items);
  };

  const remove = async (it: Item) => {
    if (locked) return;
    setErrors([]);
    setDone('');
    if (it.kind === 'local') {
      URL.revokeObjectURL(it.preview);
      setItems((cur) => cur.filter((x) => x.key !== it.key));
      return;
    }
    if (!window.confirm('Remover esta foto do produto? As outras fotos continuam.')) return;
    setBusy('Removendo…');
    try {
      await api(`/admin/products/${productId}/images/${it.image.id}`, { method: 'DELETE' });
      // A API promove a proxima foto a principal; aqui a primeira da lista ja e ela.
      setItems((cur) => cur.filter((x) => x.key !== it.key).map((x, i) => (x.kind === 'saved' ? { ...x, image: { ...x.image, is_primary: i === 0 } } : x)));
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Não foi possível remover.']);
    } finally {
      setBusy('');
    }
  };

  const replace = async (file: File | undefined) => {
    const key = replaceTarget.current;
    replaceTarget.current = null;
    if (!file || !key || !productId) return;
    const it = items.find((x) => x.key === key);
    if (!it || it.kind !== 'saved') return;
    setErrors([]);
    setDone('');
    const why = await precheck(file);
    if (why) return setErrors([why]);
    setBusy('Trocando a foto…');
    try {
      const res = await uploadWithProgress<{ image: SavedImage }>(`/admin/products/${productId}/images/${it.image.id}/file`, file, (f) => patch(key, { progress: f }));
      patch(key, { image: res.image, progress: undefined } as Partial<Item>);
      setDone('Foto trocada.');
    } catch (e) {
      patch(key, { progress: undefined });
      setErrors([e instanceof Error ? e.message : 'Não foi possível trocar a foto.']);
    } finally {
      setBusy('');
    }
  };

  // --- arrastar: arquivos do computador ou uma foto para outra posicao ------
  const isFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const onZoneDrop = (e: DragEvent) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    setDropHover(false);
    void addFiles(e.dataTransfer.files);
  };

  const remaining = MAX_IMAGES - items.length;
  const status = busy || done || (productId ? '' : items.length ? 'As fotos são enviadas quando você salvar o produto.' : '');

  return (
    <Panel
      title="Imagens do produto"
      description="JPG, PNG ou WebP de até 8 MB, com no mínimo 400 × 400 px, até 12 fotos. A primeira é a principal. O sistema remove metadados e gera versões leves para a loja."
    >
      <div
        onDragOver={(e) => {
          if (!isFiles(e) || locked) return;
          e.preventDefault();
          setDropHover(true);
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={onZoneDrop}
      >
        {editable && (
          <div className={`flex min-h-20 flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-md border border-dashed px-4 py-3 text-center text-sm transition-colors ${dropHover ? 'border-act bg-act-tint' : 'border-line-strong bg-sunken/40'}`}>
            <ImagePlus size={22} className="text-ink-faint" aria-hidden />
            <span className="text-ink-soft">{remaining > 0 ? 'Arraste as fotos para cá ou' : 'Limite de 12 fotos atingido.'}</span>
            {remaining > 0 && (
              <button type="button" disabled={locked} onClick={() => fileInput.current?.click()} className="inline-flex h-9 items-center rounded-[var(--radius-ctl)] border border-line-strong bg-card px-3.5 text-sm font-medium hover:bg-sunken disabled:opacity-55">
                Escolher fotos
              </button>
            )}
            {remaining > 0 && touch && (
              <button type="button" disabled={locked} onClick={() => cameraInput.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-ctl)] border border-line-strong bg-card px-3.5 text-sm font-medium hover:bg-sunken disabled:opacity-55">
                <Camera size={16} aria-hidden /> Tirar foto
              </button>
            )}
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-label="Tirar foto com a câmera"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={fileInput}
              type="file"
              accept={TYPES.join(',')}
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        )}

        {/* Linha de situacao com altura fixa: as mensagens nao empurram a galeria. */}
        <p className="mt-2 min-h-5 text-[13px] text-ink-soft" aria-live="polite">
          {status}
        </p>
        {errors.length > 0 && (
          <div className="mb-3">
            <Notice tone="bad">
              <ul className="space-y-0.5">
                {errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-ink-faint">Nenhuma foto ainda. A loja mostra “foto em breve” até a primeira ser enviada.</p>
        ) : (
          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
            {items.map((it, i) => {
              const uploading = it.progress !== undefined;
              return (
                <li
                  key={it.key}
                  draggable={!locked && !uploading}
                  onDragStart={(e) => {
                    setDragKey(it.key);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(e) => {
                    if (dragKey && dragKey !== it.key) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    if (!dragKey || isFiles(e)) return;
                    e.preventDefault();
                    const from = items.findIndex((x) => x.key === dragKey);
                    setDragKey(null);
                    move(from, i);
                  }}
                  className={`min-w-0 ${dragKey === it.key ? 'opacity-40' : ''}`}
                >
                  <div className={`relative overflow-hidden rounded-md border bg-sunken ${i === 0 ? 'border-act' : 'border-line'} ${!locked && !uploading ? 'cursor-grab' : ''}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src(it)} alt={`Foto ${i + 1}`} className="aspect-square w-full object-contain" draggable={false} />
                    <span className="absolute top-1.5 left-1.5 flex gap-1">
                      <span className="num grid h-5 min-w-5 place-items-center rounded bg-card/90 px-1 text-[11px] font-semibold">{i + 1}</span>
                      {i === 0 && <Badge tone="act">Principal</Badge>}
                    </span>
                    {it.kind === 'local' && !uploading && <span className="absolute right-1.5 bottom-1.5 rounded bg-card/90 px-1.5 text-[11px] text-ink-soft">não enviada</span>}
                    {uploading && (
                      <div className="absolute inset-x-0 bottom-0 bg-card/90 px-2 py-1.5">
                        <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Envio da foto ${i + 1}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((it.progress ?? 0) * 100)}>
                          <div className="h-full bg-act transition-[width] duration-150" style={{ width: `${Math.round((it.progress ?? 0) * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                  {editable && (
                    <div className="mt-1 flex items-center justify-between">
                      <span className="flex">
                        <IconBtn label="Mover para a esquerda" disabled={locked || uploading || i === 0} onClick={() => move(i, i - 1)}>
                          <ArrowLeft size={15} />
                        </IconBtn>
                        <IconBtn label="Mover para a direita" disabled={locked || uploading || i === items.length - 1} onClick={() => move(i, i + 1)}>
                          <ArrowRight size={15} />
                        </IconBtn>
                        <IconBtn label="Tornar principal" disabled={locked || uploading || i === 0} onClick={() => move(i, 0)}>
                          <Star size={15} />
                        </IconBtn>
                      </span>
                      <span className="flex">
                        {it.kind === 'saved' && (
                          <IconBtn
                            label="Trocar foto"
                            disabled={locked || uploading}
                            onClick={() => {
                              replaceTarget.current = it.key;
                              replaceInput.current?.click();
                            }}
                          >
                            <RefreshCw size={15} />
                          </IconBtn>
                        )}
                        <IconBtn label="Remover foto" tone="bad" disabled={locked || uploading} onClick={() => void remove(it)}>
                          <Trash2 size={15} />
                        </IconBtn>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <input ref={replaceInput} type="file" accept={TYPES.join(',')} className="sr-only" tabIndex={-1} onChange={(e) => void replace(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
      </div>

      {items.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-ink">Ver como fica na página do produto</summary>
          <div className="mt-3 grid max-w-md gap-2 sm:grid-cols-[56px_1fr]">
            {items.length > 1 && (
              <ul className="order-2 flex gap-1.5 overflow-x-auto sm:order-1 sm:flex-col">
                {items.map((it, i) => (
                  <li key={it.key} className={`w-12 shrink-0 border sm:w-full ${i === 0 ? 'border-2 border-ink' : 'border-line'}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src(it)} alt="" className="aspect-square w-full bg-sunken object-contain" />
                  </li>
                ))}
              </ul>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src(items[0]!, 800)} alt="" className={`order-1 aspect-square w-full bg-sunken object-contain sm:order-2 ${items.length > 1 ? '' : 'sm:col-span-2'}`} />
          </div>
          <p className="mt-2 text-[13px] text-ink-faint">A principal abre em destaque; as outras aparecem como miniaturas, nesta ordem.</p>
        </details>
      )}
    </Panel>
  );
}

function IconBtn({ label, tone, disabled, onClick, children }: { label: string; tone?: 'bad'; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-7 shrink-0 place-items-center rounded disabled:opacity-30 ${tone === 'bad' ? 'text-bad hover:bg-bad-tint' : 'text-ink-soft hover:bg-sunken hover:text-ink'}`}
    >
      {children}
    </button>
  );
}
