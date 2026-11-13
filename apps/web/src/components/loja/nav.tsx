'use client';

import { ChevronDown, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

type Item = { name: string; slug: string; children: { name: string; slug: string }[] };

/** No celular os departamentos abrem numa lista; a barra escura vira um botao. */
export function MobileDepartments({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="sm:hidden">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-semibold tracking-wide uppercase">
        <Menu size={17} aria-hidden /> Departamentos
        <ChevronDown size={16} className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <ul className="border-t border-white/15 pb-2">
          {items.map((d) => (
            <li key={d.slug}>
              <Link href={`/c/${d.slug}`} className="block px-4 py-2.5 font-semibold">
                {d.name}
              </Link>
              {d.children.map((c) => (
                <Link key={c.slug} href={`/c/${c.slug}`} className="block py-2 pr-4 pl-8 text-[14px] text-[#cfd5d1]">
                  {c.name}
                </Link>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
