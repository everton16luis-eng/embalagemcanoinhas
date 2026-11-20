'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean };
export function Button({ variant = 'secondary', busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-ctl)] px-3.5 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        variant === 'primary' && 'bg-act text-white hover:bg-act-dark',
        variant === 'secondary' && 'border border-line-strong bg-card text-ink hover:bg-sunken',
        variant === 'ghost' && 'text-ink-soft hover:bg-sunken hover:text-ink',
        variant === 'danger' && 'border border-bad/40 bg-card text-bad hover:bg-bad-tint',
        className,
      )}
    >
      {busy ? <span key="busy">Aguarde…</span> : <span key="idle" className="contents">{children}</span>}
    </button>
  );
}

const control = 'w-full rounded-[var(--radius-ctl)] border border-line-strong bg-card px-3 text-[15px] text-ink placeholder:text-ink-faint focus:border-act focus:outline-none disabled:bg-sunken disabled:text-ink-soft';

type FieldProps = { label: string; hint?: ReactNode; error?: string; required?: boolean; children: (id: string) => ReactNode; className?: string };
export function Field({ label, hint, error, required, children, className }: FieldProps) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {required && <span className="text-bad"> *</span>}
      </label>
      {children(id)}
      {error ? <p className="text-[13px] text-bad">{error}</p> : hint ? <p className="text-[13px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(control, 'h-9', className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(control, 'min-h-24 py-2', className)} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(control, 'h-9 pr-8', className)}>
    {children}
  </select>
);

export function Panel({ title, description, actions, children, className }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-line bg-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div>
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-ink-soft">{description}</p>}
          </div>
          {actions && <div className="flex gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'act';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-sunken text-ink-soft',
        tone === 'good' && 'bg-good-tint text-good',
        tone === 'warn' && 'bg-warn-tint text-warn',
        tone === 'bad' && 'bg-bad-tint text-bad',
        tone === 'act' && 'bg-act-tint text-act-dark',
      )}
    >
      {children}
    </span>
  );
}

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cx(
        'rounded-md border px-3.5 py-2.5 text-sm',
        tone === 'neutral' && 'border-line bg-sunken text-ink-soft',
        tone === 'good' && 'border-good/25 bg-good-tint text-good',
        tone === 'warn' && 'border-warn/25 bg-warn-tint text-warn',
        tone === 'bad' && 'border-bad/25 bg-bad-tint text-bad',
        tone === 'act' && 'border-act/25 bg-act-tint text-act-dark',
      )}
    >
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-ink-soft">{children}</div>}
    </div>
  );
}

export const FISCAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Fiscal pendente', tone: 'bad' },
  informed: { label: 'Aguardando contador', tone: 'warn' },
  validated: { label: 'Fiscal validado', tone: 'good' },
};
export const PRODUCT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  active: { label: 'Ativo', tone: 'act' },
  inactive: { label: 'Inativo', tone: 'neutral' },
};
