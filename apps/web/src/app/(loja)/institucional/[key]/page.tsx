import { notFound } from 'next/navigation';
import { NotFound, storeGet } from '@/lib/store';

const TITLES: Record<string, string> = { about: 'Quem somos', shipping: 'Entrega e retirada', returns: 'Trocas e devoluções', privacy: 'Privacidade', terms: 'Termos de uso' };

export default async function InstitutionalPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!TITLES[key]) notFound();
  const page = await storeGet<{ text: string }>(`/catalog/pages/${key}`).catch((e) => {
    if (e instanceof NotFound) notFound();
    throw e;
  });
  return (
    <article className="mx-auto max-w-[760px] px-4 pt-6 sm:px-8">
      <h1 className="cond border-b-[3px] border-g-ink pb-2 text-[32px] leading-none font-extrabold uppercase">{TITLES[key]}</h1>
      <div className="mt-4 leading-relaxed whitespace-pre-line text-g-soft">{page.text}</div>
    </article>
  );
}
