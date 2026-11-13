'use client';

import { useState } from 'react';
import { imageUrl } from '@/lib/api';
import { Photo } from './price';

type Image = { file_key: string; alt: string | null };

export function Gallery({ images, alt }: { images: Image[]; alt: string }) {
  const [i, setI] = useState(0);
  if (!images.length) return <Photo imageKey={null} alt={alt} size={800} />;
  const cur = images[Math.min(i, images.length - 1)]!;
  return (
    <div className="grid gap-2.5 sm:grid-cols-[72px_1fr]">
      {images.length > 1 && (
        <ul className="order-2 flex gap-2 overflow-x-auto sm:order-1 sm:flex-col">
          {images.map((im, n) => (
            <li key={im.file_key} className="shrink-0">
              <button type="button" onClick={() => setI(n)} aria-label={`Foto ${n + 1}`} aria-pressed={n === i} className={`block w-16 border sm:w-full ${n === i ? 'border-2 border-g-ink' : 'border-g-line'}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl(im.file_key, 320)} alt="" className="aspect-square w-full bg-g-photo object-contain" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={`order-1 sm:order-2 ${images.length > 1 ? '' : 'sm:col-span-2'}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl(cur.file_key, 1600)} alt={cur.alt ?? alt} className="aspect-square w-full bg-g-photo object-contain" />
      </div>
    </div>
  );
}
