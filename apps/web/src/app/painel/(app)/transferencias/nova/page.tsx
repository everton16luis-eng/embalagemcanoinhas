'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Guard } from '@/components/shell';
import { newKey, PackagingPicker, useWarehouses } from '@/components/stock';
import { Button, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, qty } from '@/lib/format';

type Line = { variantId: string; sku: string; label: string; unit: string; qty: string; free?: string };
type Loc = { warehouse_id: string; available: string };

function NewTransfer() {
  const router = useRouter();
  const sp = useSearchParams();
  const { active: warehouses, error: whError } = useWarehouses();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [docRef, setDocRef] = useState('');
  const [notes, setNotes] = useState('');
  const [receiveNow, setReceiveNow] = useState(false);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [free, setFree] = useState<Record<string, Loc[]>>({});

  useEffect(() => {
    if (!warehouses.length || from) return;
    const def = warehouses.find((w) => w.is_default) ?? warehouses[0]!;
    setFrom(def.id);
    setTo(warehouses.find((w) => w.id !== def.id)?.id ?? '');
  }, [warehouses, from]);

  // Saldo livre por deposito de cada produto da lista (para mostrar quanto da para enviar).
  const ensureFree = async (variantId: string) => {
    if (free[variantId]) return;
    const r = await api<{ locations: Loc[] }>(`/admin/stock/variants/${variantId}`);
    setFree((f) => ({ ...f, [variantId]: r.locations }));
  };

  const add = (l: Omit<Line, 'qty'>) => {
    setLines((ls) => (ls.some((x) => x.variantId === l.variantId) ? ls : [...ls, { ...l, qty: '' }]));
    void ensureFree(l.variantId);
  };

  const preset = sp.get('variantId');
  useEffect(() => {
    if (!preset) return;
    api<{ variant: { variant_id: string; sku: string; label: string; base_unit: string }; locations: Loc[] }>(`/admin/stock/variants/${preset}`).then(
      (r) => {
        setFree((f) => ({ ...f, [preset]: r.locations }));
        setLines((ls) => (ls.length ? ls : [{ variantId: r.variant.variant_id, sku: r.variant.sku, label: r.variant.label, unit: r.variant.base_unit, qty: '' }]));
      },
      () => undefined,
    );
  }, [preset]);

  const freeAt = (variantId: string) => free[variantId]?.find((l) => l.warehouse_id === from)?.available;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ transfer: { id: string } }>('/admin/stock-transfers', {
        method: 'POST',
        body: {
          fromWarehouseId: from,
          toWarehouseId: to,
          items: lines.map((l) => ({ variantId: l.variantId, qty: parseQty(l.qty) })),
          documentRef: docRef.trim() || null,
          notes: notes.trim() || null,
          receiveNow,
          requestKey: key,
        },
      });
      router.push(`/painel/transferencias/${r.transfer.id}`);
    } catch (err) {
      setError((err as Error).message);
      setKey(newKey());
    } finally {
      setBusy(false);
    }
  };

  if (whError) return <Notice tone="bad">{whError}</Notice>;
  if (warehouses.length < 2)
    return (
      <>
        <PageHeader title="Nova transferência" />
        <Notice>É preciso ter pelo menos dois depósitos ativos para transferir. Cadastre outro em Logística › Depósitos.</Notice>
      </>
    );

  return (
    <>
      <PageHeader title="Nova transferência" description="Só sai o que está livre na origem (disponível − reservado). Bloqueado e avariado não são transferidos." />
      <form onSubmit={submit} className="space-y-5">
        <Panel title="Origem e destino">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sai de" required>
              {(id) => (
                <Select id={id} value={from} onChange={(e) => setFrom(e.target.value)} required>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Vai para" required error={from && from === to ? 'Escolha um depósito diferente da origem.' : undefined}>
              {(id) => (
                <Select id={id} value={to} onChange={(e) => setTo(e.target.value)} required>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Panel>
        <Panel title="Produtos">
          <PackagingPicker placeholder="Adicionar produto: nome, SKU ou código de barras" onPick={(h) => add({ variantId: h.variant_id, sku: h.sku, label: h.product_name, unit: h.base_unit })} />
          {lines.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">Nenhum produto adicionado.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {lines.map((l, i) => {
                const f = freeAt(l.variantId);
                return (
                  <li key={l.variantId} className="flex flex-wrap items-end gap-3 py-2.5">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="font-medium">{l.label}</p>
                      <p className="text-xs text-ink-faint">
                        <span className="font-mono">{l.sku}</span>
                        {f !== undefined && ` · livre na origem: ${qty(f)} ${l.unit}`}
                      </p>
                    </div>
                    <Field label={`Quantidade (${l.unit})`} className="w-36">
                      {(id) => (
                        <Input
                          id={id}
                          inputMode="decimal"
                          value={l.qty}
                          required
                          onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                        />
                      )}
                    </Field>
                    <Button type="button" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      Remover
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Detalhes">
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <Field label="Documento" hint="Romaneio, nota ou guia (opcional).">
              {(id) => <Input id={id} value={docRef} onChange={(e) => setDocRef(e.target.value)} maxLength={60} />}
            </Field>
            <Field label="Observações">{(id) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={receiveNow} onChange={(e) => setReceiveNow(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-act" />
            <span>
              <span className="font-medium">Já receber agora</span>
              <span className="block text-ink-soft">Para movimentação interna em que a mercadoria chega na hora. O histórico guarda o envio e o recebimento.</span>
            </span>
          </label>
        </Panel>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" busy={busy} disabled={!lines.length || !from || !to || from === to}>
            {receiveNow ? 'Transferir e receber' : 'Enviar transferência'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Voltar
          </Button>
        </div>
      </form>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="stock.transfer">
      <Suspense fallback={<p className="text-sm text-ink-faint">Carregando…</p>}>
        <NewTransfer />
      </Suspense>
    </Guard>
  );
}
