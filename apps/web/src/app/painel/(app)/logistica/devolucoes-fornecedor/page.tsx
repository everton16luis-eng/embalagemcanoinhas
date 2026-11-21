'use client';

// SGLog Fase 9b: devolucao ao fornecedor. Rascunho nao mexe no estoque; enviar (saida fisica confirmada) tira do saldo.
// Nenhum credito, reembolso ou e-mail ao fornecedor e gerado.
import Link from '@/components/painel-link';
import { useEffect, useState } from 'react';
import { BUCKET, SUPPLIER_RETURN_STATUS } from '@/components/returns';
import { Guard, useMe } from '@/components/shell';
import { newKey, PackagingPicker, type PackagingHit } from '@/components/stock';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { parseQty, when } from '@/lib/format';

type Row = { id: string; number: number; supplier_name: string; warehouse_name: string; status: string; reason: string; document_ref: string | null; item_count: number; created_at: string };
type Line = { variantId: string; sku: string; name: string; unit: string; bucket: string; qty: string };

function NewForm({ onDone }: { onDone: (id: string) => void }) {
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  useEffect(() => {
    api<{ items: { id: string; name: string }[] }>('/admin/suppliers?active=true&pageSize=100').then((r) => setSuppliers(r.items), () => null);
    api<{ items: { id: string; name: string; active: boolean }[] }>('/admin/warehouses').then((r) => setWarehouses(r.items.filter((w) => w.active)), () => null);
  }, []);
  const add = (p: PackagingHit) => {
    if (lines.some((l) => l.variantId === p.variant_id && l.bucket === 'on_hand')) return;
    setLines([...lines, { variantId: p.variant_id, sku: p.sku, name: p.product_name, unit: p.base_unit, bucket: 'on_hand', qty: '' }]);
  };
  const valid = supplierId && reason.trim().length >= 3 && lines.length > 0 && lines.every((l) => Number(parseQty(l.qty)) > 0);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ supplierReturn: { id: string } }>('/admin/supplier-returns', {
        method: 'POST',
        body: { supplierId, warehouseId: warehouseId || null, reason, items: lines.map((l) => ({ variantId: l.variantId, bucket: l.bucket, qty: parseQty(l.qty) })), requestKey: key },
      });
      onDone(r.supplierReturn.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Nova devolução ao fornecedor" description="Rascunho: nada sai do estoque até você confirmar o envio físico.">
      <div className="space-y-3" data-testid="supplier-return-form">
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fornecedor" required>
            {(id) => (
              <Select id={id} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Escolha</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Depósito de saída">
            {(id) => (
              <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Depósito padrão</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Motivo" required>
          {(id) => <Input id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <PackagingPicker onPick={add} placeholder="Adicionar item: nome, SKU ou código de barras" />
        {lines.map((l, i) => (
          <div key={`${l.variantId}:${i}`} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_150px_120px_auto] sm:items-center">
            <span className="text-sm">
              <span className="font-medium">{l.sku}</span> <span className="text-ink-soft">{l.name}</span>
            </span>
            <Select aria-label={`Saldo de ${l.sku}`} value={l.bucket} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, bucket: e.target.value } : x)))}>
              {Object.entries(BUCKET).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Input aria-label={`Quantidade de ${l.sku}`} inputMode="decimal" placeholder={l.unit} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              Remover
            </Button>
          </div>
        ))}
        <Button variant="primary" busy={busy} disabled={!valid} onClick={submit}>
          Criar rascunho
        </Button>
      </div>
    </Panel>
  );
}

function Page() {
  const { can } = useMe();
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    api<{ items: Row[] }>(`/admin/supplier-returns?status=${status}&pageSize=50`).then((r) => setItems(r.items), (e) => setError(e.message));
  }, [status]);
  return (
    <>
      <PageHeader
        title="Devoluções ao fornecedor"
        description="Mercadoria que volta ao fornecedor (defeito, lote, troca). O estoque só sai com o envio confirmado; nenhum crédito ou abatimento é lançado automaticamente."
        actions={can('purchases.manage') && <Button onClick={() => setCreating(!creating)}>Nova devolução</Button>}
      />
      {error && (
        <div className="mb-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {creating && (
        <div className="mb-5">
          <NewForm onDone={(id) => (window.location.href = `/painel/logistica/devolucoes-fornecedor/${id}`)} />
        </div>
      )}
      <Panel>
        <Select aria-label="Situação" className="mb-3 w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Em aberto</option>
          {Object.entries(SUPPLIER_RETURN_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
          <option value="all">Todas</option>
        </Select>
        {!items ? null : items.length === 0 ? (
          <Empty title="Nenhuma devolução ao fornecedor" />
        ) : (
          <ul className="divide-y divide-line text-sm" data-testid="supplier-return-list">
            {items.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/painel/logistica/devolucoes-fornecedor/${r.id}`} className="font-medium text-act hover:underline">
                    Nº {r.number}
                  </Link>
                  <Badge tone={SUPPLIER_RETURN_STATUS[r.status]?.tone}>{SUPPLIER_RETURN_STATUS[r.status]?.label}</Badge>
                </div>
                <span className="min-w-0 flex-1 truncate text-ink-soft">
                  {r.supplier_name} · {r.item_count} item(ns) · {r.warehouse_name}
                  {r.document_ref ? ` · doc. ${r.document_ref}` : ''} · {r.reason}
                </span>
                <span className="text-xs text-ink-faint">{when(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

export default function DevolucoesFornecedorPage() {
  return (
    <Guard perm="purchases.view|purchases.manage|returns.manage|stock.view">
      <Page />
    </Guard>
  );
}
