"use client";

// SGLog Fase 8 (docs/35-sglog-fase8.md): frete da remessa. Cotacao pelo deposito e volumes medidos, etiqueta (compra
// real bloqueada: a tela so mostra o motivo), custo pago, rastreio. Cobrado, cotado e pago sempre separados; custo
// desconhecido aparece como "não informado", nunca como zero.
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/shell";
import { newKey } from "@/components/stock";
import {
  Badge,
  Button,
  Field,
  Input,
  Notice,
  Panel,
  Select,
  type Tone,
} from "@/components/ui";
import { api } from "@/lib/api";
import { money, parseMoney, when } from "@/lib/format";

export const LABEL_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: "Pedida", tone: "act" },
  purchasing: { label: "Comprando", tone: "act" },
  uncertain: { label: "Compra a conferir", tone: "bad" },
  purchased: { label: "Comprada", tone: "good" },
  printed: { label: "Impressa", tone: "good" },
  cancel_requested: { label: "Cancelamento pedido", tone: "warn" },
  canceled: { label: "Cancelada", tone: "neutral" },
  failed: { label: "Não comprada", tone: "neutral" },
};
export const REFUND_STATUS: Record<string, string> = {
  none: "",
  pending: "estorno pendente",
  refunded: "estornada",
  denied: "estorno negado",
  unknown: "estorno não confirmado",
};
export const TRACK_ACTION: Record<string, string> = {
  dispatch: "Despachada",
  handover: "Entregue ao cliente",
  deliver: "Entregue",
  quote_select: "Frete escolhido",
  track_posted: "Postada",
  track_in_transit: "Em trânsito",
  track_out_for_delivery: "Saiu para entrega",
  track_delivered: "Entregue",
  track_delivery_failed: "Falha na entrega",
  track_returned: "Devolvida ao remetente",
  track_canceled: "Cancelada pelo transportador",
  track_info: "Atualização",
};
const COST_KIND: Record<string, string> = {
  label: "Etiqueta",
  manual: "Informado",
  adjustment: "Ajuste",
  refund: "Estorno",
};

type Quote = {
  id: string;
  service: string;
  service_name: string;
  company: string | null;
  price_cents: number;
  days: number;
  from_cep: string;
  quoted_at: string;
  expires_at: string;
  expired: boolean;
  stale: boolean;
};
type Label = {
  id: string;
  status: string;
  tracking_code: string | null;
  quoted_cents: number;
  cost_cents: number | null;
  error: string | null;
  refund_status: string;
  requested_at: string;
  version: number;
  events: {
    from: string | null;
    to: string;
    note: string | null;
    at: string;
    actor: string | null;
  }[];
};
export type Freight = {
  shipment: {
    id: string;
    kind: string;
    status: string;
    version: number;
    invoiceStatus: string;
    carrierProvider: string | null;
    warehouseName: string | null;
    warehouseCep: string | null;
    toCep: string | null;
  };
  provider: { name: string; capabilities: Record<string, boolean> } | null;
  gate: { allowed: boolean; reasons: string[]; maxCents: number | null };
  charged: { cents: number; split: boolean; shipments: number };
  quotes: Quote[];
  selectedQuote: Quote | null;
  labels: Label[];
  costs: {
    entries: {
      id: string;
      kind: string;
      amount_cents: number;
      note: string | null;
      created_at: string;
      actor_name: string | null;
    }[];
    paidCents: number | null;
    refundedCents: number | null;
    netCents: number | null;
    pendingRefunds: number;
  };
  tracking: {
    tracking_status: string | null;
    last_tracked_at: string | null;
    carrier: string | null;
    tracking_code: string | null;
    events: {
      id: string;
      action: string;
      source: string;
      note: string | null;
      occurred_at: string;
      actor_name: string | null;
    }[];
  };
};

const ACTIVE = [
  "requested",
  "purchasing",
  "uncertain",
  "purchased",
  "printed",
  "cancel_requested",
];
const SENT = ["shipped", "in_transit", "out_for_delivery", "delivered"];

export function FreightPanel({
  shipmentId,
  onChanged,
}: {
  shipmentId: string;
  onChanged?: () => void;
}) {
  const { can } = useMe();
  const [f, setF] = useState<Freight | null>(null);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [cost, setCost] = useState({ kind: "manual", amount: "", note: "" });
  const [track, setTrack] = useState({ status: "in_transit", note: "" });

  const load = useCallback(
    () =>
      api<{ freight: Freight }>(`/admin/freight/shipments/${shipmentId}`).then(
        (r) => setF(r.freight),
        (e) => setMsg({ tone: "bad", text: e.message }),
      ),
    [shipmentId],
  );
  useEffect(() => {
    load();
  }, [load]);

  const post = async (
    what: string,
    path: string,
    body: Record<string, unknown>,
    ok: string,
  ) => {
    setBusy(what);
    setMsg(null);
    try {
      const r = await api<{ freight: Freight }>(`/admin/freight/${path}`, {
        method: "POST",
        body,
      });
      setF(r.freight);
      setMsg({ tone: "good", text: ok });
      onChanged?.();
      return true;
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
      await load();
      return false;
    } finally {
      setBusy("");
    }
  };

  if (!f) return msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null;
  if (f.shipment.kind === "pickup" || f.shipment.kind === "marketplace")
    return null;
  const s = f.shipment;
  const packed = s.status === "packed";
  const active = f.labels.find((l) => ACTIVE.includes(l.status)) ?? null;
  const validQuotes = f.quotes.filter((q) => !q.expired && !q.stale);

  return (
    <Panel
      title="Frete"
      description="Cobrado do cliente, cotado e pago à transportadora ficam separados. Custo não informado não conta como zero."
    >
      <div data-testid="freight-panel" className="space-y-4">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <dl
          className="grid grid-cols-3 gap-2 text-sm"
          data-testid="freight-values"
        >
          <div className="rounded-md border border-line p-2">
            <dt className="text-xs text-ink-soft">Cobrado do cliente</dt>
            <dd className="num font-semibold">{money(f.charged.cents)}</dd>
            {f.charged.split && (
              <dd className="text-xs text-ink-faint">
                rateado em {f.charged.shipments} remessas
              </dd>
            )}
          </div>
          <div className="rounded-md border border-line p-2">
            <dt className="text-xs text-ink-soft">Cotado</dt>
            <dd className="num font-semibold">
              {f.selectedQuote ? money(f.selectedQuote.price_cents) : "—"}
            </dd>
            {f.selectedQuote && (
              <dd className="truncate text-xs text-ink-faint">
                {f.selectedQuote.service_name}
              </dd>
            )}
          </div>
          <div className="rounded-md border border-line p-2">
            <dt className="text-xs text-ink-soft">Pago</dt>
            <dd className="num font-semibold">
              {f.costs.netCents === null
                ? "não informado"
                : money(f.costs.netCents)}
            </dd>
            {f.costs.pendingRefunds > 0 && (
              <dd className="text-xs text-warn">estorno pendente</dd>
            )}
          </div>
        </dl>

        {packed && can("shipping.manage") && (
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Cotação</h3>
              <Button
                busy={busy === "quote"}
                onClick={() =>
                  void post(
                    "quote",
                    `shipments/${s.id}/quotes`,
                    {},
                    "Cotação atualizada.",
                  )
                }
              >
                Cotar frete
              </Button>
            </div>
            <p className="mb-2 text-xs text-ink-faint">
              Origem: {s.warehouseName}{" "}
              {s.warehouseCep
                ? `(CEP ${s.warehouseCep})`
                : "(sem CEP cadastrado)"}{" "}
              · destino CEP {s.toCep ?? "—"} · volumes medidos na embalagem.
            </p>
            {f.quotes.length === 0 ? (
              <p className="text-sm text-ink-soft">Nenhuma cotação ainda.</p>
            ) : (
              <ul
                className="divide-y divide-line text-sm"
                data-testid="freight-quotes"
              >
                {f.quotes.map((q) => (
                  <li
                    key={q.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="min-w-0">
                      <b>{q.service_name}</b>
                      {q.company && ` · ${q.company}`}
                      <span className="block text-xs text-ink-faint">
                        {money(q.price_cents)} · {q.days} dia(s) · diferença
                        para o cobrado {money(f.charged.cents - q.price_cents)}
                        {q.expired
                          ? " · vencida"
                          : q.stale
                            ? " · de outra embalagem"
                            : ` · vale até ${when(q.expires_at)}`}
                      </span>
                    </span>
                    {f.selectedQuote?.id === q.id ? (
                      <Badge tone="good">Escolhida</Badge>
                    ) : (
                      !q.expired &&
                      !q.stale &&
                      !active && (
                        <Button
                          busy={busy === `sel-${q.id}`}
                          onClick={() =>
                            void post(
                              `sel-${q.id}`,
                              `shipments/${s.id}/quote-selection`,
                              {
                                quoteId: q.id,
                                version: s.version,
                                requestKey: newKey(),
                              },
                              "Serviço escolhido.",
                            )
                          }
                        >
                          Escolher
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
            {f.quotes.length > 0 && validQuotes.length === 0 && (
              <p className="mt-1 text-xs text-warn">
                As cotações venceram ou são de outra embalagem. Cote de novo.
              </p>
            )}
          </section>
        )}

        <section>
          <h3 className="mb-1 text-sm font-semibold">Etiqueta</h3>
          {f.labels.length > 0 && (
            <ul className="mb-2 space-y-2 text-sm" data-testid="freight-labels">
              {f.labels.map((l) => {
                const st = LABEL_STATUS[l.status] ?? {
                  label: l.status,
                  tone: "neutral" as const,
                };
                return (
                  <li key={l.id} className="rounded-md border border-line p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {REFUND_STATUS[l.refund_status] && (
                        <span className="text-xs text-ink-soft">
                          {REFUND_STATUS[l.refund_status]}
                        </span>
                      )}
                      <span className="text-xs text-ink-faint">
                        cotada {money(l.quoted_cents)}
                        {l.cost_cents ? ` · custo ${money(l.cost_cents)}` : ""}
                        {l.tracking_code ? ` · ${l.tracking_code}` : ""}
                      </span>
                    </div>
                    {l.error && (
                      <p className="mt-1 text-xs text-bad">{l.error}</p>
                    )}
                    {l.status === "uncertain" && (
                      <p className="mt-1 text-xs text-bad">
                        O provedor não respondeu com clareza. Nenhuma nova
                        compra é feita até a conferência.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!f.gate.allowed ? (
            <div data-testid="freight-labels-blocked">
              <Notice tone="neutral">
                Etiqueta pelo painel do transportador: a compra pelo sistema
                está bloqueada. Informe o código de rastreio e o custo à mão no
                despacho.
                <span className="mt-1 block text-xs text-ink-soft">
                  {f.gate.reasons.join(" ")}
                </span>
              </Notice>
            </div>
          ) : (
            packed &&
            !active &&
            can("shipping.labels") && (
              <Button
                variant="primary"
                busy={busy === "label"}
                disabled={
                  !f.selectedQuote || f.shipment.invoiceStatus !== "authorized"
                }
                onClick={() =>
                  void post(
                    "label",
                    `shipments/${s.id}/labels`,
                    { version: s.version, requestKey: newKey() },
                    "Etiqueta pedida: a compra roda na fila.",
                  )
                }
              >
                Pedir etiqueta
              </Button>
            )
          )}
        </section>

        {(SENT.includes(s.status) || f.tracking.events.length > 0) && (
          <section>
            <h3 className="mb-1 text-sm font-semibold">Rastreio</h3>
            <p className="mb-2 text-xs text-ink-faint">
              {f.tracking.carrier ?? "Transportadora não informada"}
              {f.tracking.tracking_code && ` · ${f.tracking.tracking_code}`}
              {f.tracking.last_tracked_at &&
                ` · consultado ${when(f.tracking.last_tracked_at)}`}
            </p>
            {f.tracking.events.length > 0 && (
              <ol
                className="mb-2 space-y-1 border-l border-line pl-3 text-sm"
                data-testid="freight-tracking"
              >
                {f.tracking.events.map((e) => (
                  <li key={e.id}>
                    <b>{TRACK_ACTION[e.action] ?? e.action}</b>{" "}
                    <span className="text-xs text-ink-faint">
                      {when(e.occurred_at)}
                    </span>
                    {e.source === "manual" && e.actor_name && (
                      <span className="text-xs text-ink-faint">
                        {" "}
                        · {e.actor_name}
                      </span>
                    )}
                    {e.note && (
                      <span className="block text-xs text-ink-soft">
                        {e.note}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {["shipped", "in_transit", "out_for_delivery"].includes(s.status) &&
              can("shipping.manage") && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post(
                      "track",
                      `shipments/${s.id}/tracking`,
                      {
                        status: track.status,
                        ...(track.note.trim()
                          ? { note: track.note.trim() }
                          : {}),
                        requestKey: newKey(),
                      },
                      "Rastreio registrado.",
                    ).then(
                      (ok) =>
                        ok && setTrack({ status: "in_transit", note: "" }),
                    );
                  }}
                >
                  <Field label="Situação informada pela transportadora">
                    {(fid) => (
                      <Select
                        id={fid}
                        value={track.status}
                        onChange={(e) =>
                          setTrack({ ...track, status: e.target.value })
                        }
                      >
                        <option value="in_transit">Em trânsito</option>
                        <option value="out_for_delivery">
                          Saiu para entrega
                        </option>
                        <option value="delivery_failed">
                          Falha na entrega
                        </option>
                        <option value="returned">Devolvida ao remetente</option>
                        <option value="info">Outra atualização</option>
                      </Select>
                    )}
                  </Field>
                  <Field label="Observação" className="min-w-[12rem] flex-1">
                    {(fid) => (
                      <Input
                        id={fid}
                        value={track.note}
                        maxLength={200}
                        onChange={(e) =>
                          setTrack({ ...track, note: e.target.value })
                        }
                      />
                    )}
                  </Field>
                  <Button type="submit" busy={busy === "track"}>
                    Registrar
                  </Button>
                </form>
              )}
          </section>
        )}

        {SENT.includes(s.status) && can("shipping.manage") && (
          <section>
            <h3 className="mb-1 text-sm font-semibold">
              Custo pago à transportadora
            </h3>
            {f.costs.entries.length > 0 && (
              <ul className="mb-2 text-sm" data-testid="freight-costs">
                {f.costs.entries.map((c) => (
                  <li
                    key={c.id}
                    className="flex justify-between gap-2 border-b border-line py-1 last:border-0"
                  >
                    <span>
                      {COST_KIND[c.kind] ?? c.kind}
                      {c.note && (
                        <span className="text-xs text-ink-faint">
                          {" "}
                          · {c.note}
                        </span>
                      )}
                    </span>
                    <span className="num">{money(c.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const cents = parseMoney(cost.amount);
                if (!cents)
                  return setMsg({ tone: "bad", text: "Informe o valor." });
                void post(
                  "cost",
                  `shipments/${s.id}/costs`,
                  {
                    kind: cost.kind,
                    amountCents: cents,
                    ...(cost.note.trim() ? { note: cost.note.trim() } : {}),
                    requestKey: newKey(),
                  },
                  "Custo registrado.",
                ).then(
                  (ok) =>
                    ok && setCost({ kind: "adjustment", amount: "", note: "" }),
                );
              }}
            >
              <Field label="Tipo">
                {(fid) => (
                  <Select
                    id={fid}
                    value={cost.kind}
                    onChange={(e) => setCost({ ...cost, kind: e.target.value })}
                  >
                    {!f.costs.entries.some(
                      (c) => c.kind === "manual" || c.kind === "label",
                    ) && <option value="manual">Custo pago</option>}
                    <option value="adjustment">Ajuste (soma)</option>
                    <option value="refund">Estorno recebido</option>
                  </Select>
                )}
              </Field>
              <Field label="Valor (R$)">
                {(fid) => (
                  <Input
                    id={fid}
                    inputMode="decimal"
                    className="w-28"
                    value={cost.amount}
                    onChange={(e) =>
                      setCost({ ...cost, amount: e.target.value })
                    }
                  />
                )}
              </Field>
              <Field label="Motivo" className="min-w-[12rem] flex-1">
                {(fid) => (
                  <Input
                    id={fid}
                    value={cost.note}
                    maxLength={300}
                    onChange={(e) => setCost({ ...cost, note: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" busy={busy === "cost"}>
                Registrar
              </Button>
            </form>
          </section>
        )}
      </div>
    </Panel>
  );
}
