import type { Metadata } from 'next';
import { NotFoundBody } from '@/components/loja/not-found-body';
import StoreLayout from './(loja)/layout';

// Endereco que nao corresponde a nenhuma rota: mesma pagina, com cabecalho e rodape da loja.
export const metadata: Metadata = { title: 'Página não encontrada' };

export default function NotFound() {
  return (
    <StoreLayout>
      <NotFoundBody />
    </StoreLayout>
  );
}
