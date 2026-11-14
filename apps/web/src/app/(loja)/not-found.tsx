import type { Metadata } from 'next';
import { NotFoundBody } from '@/components/loja/not-found-body';

// Produto, departamento ou pagina institucional que nao existe (notFound() dentro da loja).
export const metadata: Metadata = { title: 'Página não encontrada' };

export default function StoreNotFound() {
  return <NotFoundBody />;
}
