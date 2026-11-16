'use client';

import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentProps } from 'react';

/**
 * Link do painel: só pré-carrega a tela quando o mouse passa, o dedo toca ou o
 * foco chega no link. O pré-carregamento automático do Next buscava, a cada tela
 * aberta, todas as telas do menu e cada linha da lista (50 produtos, dezenas de
 * pedidos) de uma vez; isso passava do limite de requisições por IP do nginx
 * (20/s, rajada de 80) e parte das respostas, inclusive da API, voltava 429.
 */
export default function Link({ prefetch, onMouseEnter, onTouchStart, onFocus, ...props }: ComponentProps<typeof NextLink>) {
  const router = useRouter();
  if (prefetch !== undefined && prefetch !== null) return <NextLink prefetch={prefetch} onMouseEnter={onMouseEnter} onTouchStart={onTouchStart} onFocus={onFocus} {...props} />;
  const warm = () => {
    if (typeof props.href === 'string') router.prefetch(props.href);
  };
  return (
    <NextLink
      prefetch={false}
      onMouseEnter={(e) => {
        warm();
        onMouseEnter?.(e);
      }}
      onTouchStart={(e) => {
        warm();
        onTouchStart?.(e);
      }}
      onFocus={(e) => {
        warm();
        onFocus?.(e);
      }}
      {...props}
    />
  );
}
