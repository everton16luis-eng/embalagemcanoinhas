'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { imageUrl } from '@/lib/api';
import { Photo } from './price';

type Image = { file_key: string; alt: string | null };

export function Gallery({ images, alt }: { images: Image[]; alt: string }) {
  const [i, setI] = useState(0);
  const touchX = useRef<number | null>(null);
  // min-w-0: a foto e quadrada (aspect-ratio); sem isso, a altura da linha da grade (que acompanha a caixa
  // de compra ao lado) vira largura minima da foto, e a coluna da compra muda de largura a cada troca de
  // embalagem ou de quantidade.
  // Sem foto, no celular o espaco reservado fica baixo para o preco aparecer sem rolar.
  if (!images.length) return <Photo imageKey={null} alt={alt} size={800} className="min-w-0 max-sm:aspect-[16/7]" />;
  const n = images.length;
  const cur = images[Math.min(i, n - 1)]!;
  const go = (to: number) => setI((to + n) % n);

  return (
    <div className="grid min-w-0 gap-2.5 sm:grid-cols-[72px_minmax(0,1fr)]">
      {n > 1 && (
        <ul className="order-2 flex gap-2 overflow-x-auto sm:order-1 sm:flex-col" aria-label="Fotos do produto">
          {images.map((im, k) => (
            <li key={im.file_key} className="shrink-0">
              <button type="button" onClick={() => setI(k)} aria-label={`Foto ${k + 1} de ${n}`} aria-pressed={k === i} className={`block w-16 border-2 sm:w-full ${k === i ? 'border-g-ink' : 'border-transparent outline outline-1 -outline-offset-1 outline-g-line'}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl(im.file_key, 320)} alt="" loading="lazy" className="aspect-square w-full bg-g-photo object-contain" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`relative order-1 sm:order-2 ${n > 1 ? '' : 'sm:col-span-2'}`}
        role={n > 1 ? 'group' : undefined}
        aria-roledescription={n > 1 ? 'galeria' : undefined}
        aria-label={n > 1 ? `Foto ${i + 1} de ${n}` : undefined}
        tabIndex={n > 1 ? 0 : undefined}
        onKeyDown={(e) => {
          if (n < 2) return;
          if (e.key === 'ArrowRight') go(i + 1);
          else if (e.key === 'ArrowLeft') go(i - 1);
        }}
        onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          const start = touchX.current;
          touchX.current = null;
          const end = e.changedTouches[0]?.clientX;
          if (n < 2 || start === null || end === undefined || Math.abs(end - start) < 40) return;
          go(end < start ? i + 1 : i - 1);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* Foto que define o LCP: prioridade alta e 800 px para tela que nao precisa de 1600 (auditoria 11/2026). */}
        <img
          src={imageUrl(cur.file_key, 1600)}
          srcSet={`${imageUrl(cur.file_key, 800)} 800w, ${imageUrl(cur.file_key, 1600)} 1600w`}
          sizes="(min-width: 1024px) 600px, 100vw"
          fetchPriority="high"
          alt={cur.alt ?? alt}
          className="aspect-square w-full bg-g-photo object-contain"
        />
        {n > 1 && (
          <>
            <button type="button" onClick={() => go(i - 1)} aria-label="Foto anterior" className="absolute top-1/2 left-2 grid size-10 -translate-y-1/2 place-items-center border-2 border-g-ink bg-white/90 hover:bg-white">
              <ChevronLeft size={20} aria-hidden />
            </button>
            <button type="button" onClick={() => go(i + 1)} aria-label="Próxima foto" className="absolute top-1/2 right-2 grid size-10 -translate-y-1/2 place-items-center border-2 border-g-ink bg-white/90 hover:bg-white">
              <ChevronRight size={20} aria-hidden />
            </button>
            <span className="num absolute right-2 bottom-2 bg-g-ink px-2 py-0.5 text-xs font-semibold text-white" aria-hidden>
              {i + 1}/{n}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
