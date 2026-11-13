'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BUYER_KIND, CERT_ALERT, DESTINATION, DOC_STATUS, PRESENCE } from '@/components/fiscal';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Empty, Field, Input, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, money, when } from '@/lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = { tone: 'good' | 'bad' | 'warn'; text: string } | null;
const TABS = [
  ['geral', 'Visão geral'],
  ['notas', 'Notas emitidas'],
  ['regras', 'Regras fiscais'],
  ['numeracao', 'Certificado e numeração'],
] as const;
type Tab = (typeof TABS)[number][0];

const ACCREDITATION: Record<string, string> = { not_started: 'Não iniciado', in_progress: 'Em andamento', accredited: 'Concluído' };

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${ok ? 'bg-good' : 'bg-warn'}`}>
        {ok ? '✓' : '!'}
      </span>
      <span className={ok ? 'text-ink-soft' : ''}>{children}</span>
    </li>
  );
}

// ---------------- visao geral e configuracao ----------------

function Overview({ ov, reload }: { ov: any; reload: () => void }) {
  const { can, me } = useMe();
  const s = ov.settings;
  const editable = can('fiscal.manage') && me.user.mfaEnabled;
  const [acc, setAcc] = useState(s.accreditation_status);
  const [notes, setNotes] = useState(s.accreditation_notes ?? '');
  const [policy, setPolicy] = useState(s.emission_policy);
  const [validator, setValidator] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState('');

  const patch = async (body: Record<string, unknown>, ok: string) => {
    setBusy(ok);
    setMsg(null);
    try {
      await api('/admin/fiscal/settings', { method: 'PATCH', body });
      setMsg({ tone: 'good', text: ok });
      reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  const release = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('release');
    setMsg(null);
    try {
      await api('/admin/fiscal/production-release', { method: 'POST', body: { validatorName: validator, confirm: true } });
      setMsg({ tone: 'good', text: 'Produção liberada. Mude o ambiente quando for começar a emitir notas válidas.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy('');
    }
  };

  const c = ov.productionChecklist;
  const cert = ov.certificate;
  return (
    <div className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!ov.provider && <Notice tone="warn">Provedor fiscal não configurado no servidor. Os tokens da Focus NFe vão no arquivo .env (FOCUS_TOKEN_HOMOLOGACAO e FOCUS_TOKEN_PRODUCAO).</Notice>}
      {cert && cert.alert.level !== 'ok' && <Notice tone={CERT_ALERT[cert.alert.level]!.tone === 'bad' ? 'bad' : 'warn'}>Certificado digital: {CERT_ALERT[cert.alert.level]!.label(cert.alert.days)}. Renove e envie o novo ao provedor fiscal.</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Antes de emitir" description="O que a conferência de cada pedido exige.">
          <ul className="space-y-2">
            <Check ok={Boolean(ov.provider?.[s.environment])}>
              Credencial do provedor para {s.environment === 'producao' ? 'produção' : 'homologação'}
              {ov.provider && <span className="text-ink-faint"> · {ov.provider.name === 'fake' ? 'simulado (desenvolvimento)' : 'Focus NFe'}</span>}
            </Check>
            <Check ok={Boolean(cert) && cert?.alert.level !== 'expired'}>
              Certificado A1 enviado ao provedor{cert ? ` · ${CERT_ALERT[cert.alert.level]!.label(cert.alert.days)}` : ' (registre a validade em Certificado e numeração)'}
            </Check>
            <Check ok={ov.rules.validated > 0 && ov.rules.validated === ov.rules.total}>
              Regras fiscais validadas pelo contador: {ov.rules.validated} de {ov.rules.total}
            </Check>
            <Check ok={ov.productsPendingValidation === 0}>
              {ov.productsPendingValidation === 0 ? 'Todos os produtos ativos com cadastro fiscal validado' : `${ov.productsPendingValidation} produto(s) ativo(s) sem cadastro fiscal validado`}
              {ov.productsPendingValidation > 0 && (
                <Link href="/painel/produtos" className="ml-1 text-act-dark underline">
                  ver produtos
                </Link>
              )}
            </Check>
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-sm">
            <span className="font-medium">{ov.awaitingInvoice}</span> pedido(s) pago(s) aguardando nota ·{' '}
            {Object.entries(ov.documents as Record<string, number>).map(([k, n]) => `${n} ${DOC_STATUS[k]?.label.toLowerCase() ?? k}`).join(' · ') || 'nenhuma nota emitida'}
          </p>
        </Panel>

        <Panel title="Homologação e produção" description="Notas de homologação não têm valor fiscal. Produção só depois da validação do contador.">
          <ul className="space-y-2">
            <Check ok={c.accredited}>Credenciamento na SEF-SC concluído</Check>
            <Check ok={c.homologationAuthorized}>Ao menos uma nota autorizada em homologação</Check>
            <Check ok={c.productionCredential}>Credencial de produção do provedor no servidor</Check>
            <Check ok={c.released}>
              Produção liberada{s.production_released_at ? ` em ${when(s.production_released_at)} · validada por ${s.production_validator_name}` : ''}
            </Check>
          </ul>
          {!c.released && can('fiscal.validate') && (
            <form onSubmit={release} className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <Field label="Contador que validou a homologação" className="min-w-56 flex-1">
                {(id) => <Input id={id} required minLength={2} maxLength={120} value={validator} onChange={(e) => setValidator(e.target.value)} />}
              </Field>
              <Button type="submit" variant="primary" busy={busy === 'release'} disabled={!c.accredited || !c.homologationAuthorized || !c.productionCredential}>
                Liberar produção
              </Button>
            </form>
          )}
          {c.released && editable && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <span className="text-sm">Ambiente atual:</span>
              <Badge tone={s.environment === 'producao' ? 'good' : 'warn'}>{s.environment === 'producao' ? 'Produção' : 'Homologação'}</Badge>
              <Button
                busy={busy === 'env'}
                onClick={() => patch({ environment: s.environment === 'producao' ? 'homologacao' : 'producao' }, s.environment === 'producao' ? 'Voltou para homologação.' : 'Emissão em produção ativada.')}
              >
                {s.environment === 'producao' ? 'Voltar para homologação' : 'Emitir em produção'}
              </Button>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Configuração" description="Credenciamento e momento da emissão. Defina com o contador.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patch({ accreditationStatus: acc, accreditationNotes: notes || null, emissionPolicy: policy }, 'Configuração fiscal gravada.');
          }}
        >
          <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-3">
            <Field label="Credenciamento na SEF-SC">
              {(id) => (
                <Select id={id} value={acc} onChange={(e) => setAcc(e.target.value)}>
                  {Object.entries(ACCREDITATION).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Quando emitir" hint="Automática: a rotina emite assim que o pagamento é confirmado e a conferência passa.">
              {(id) => (
                <Select id={id} value={policy} onChange={(e) => setPolicy(e.target.value)}>
                  <option value="manual">Manual, pelo botão no pedido</option>
                  <option value="on_paid">Automática ao confirmar o pagamento</option>
                </Select>
              )}
            </Field>
            <Field label="Anotações do credenciamento">{(id) => <Input id={id} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
            {editable && (
              <div className="sm:col-span-3">
                <Button type="submit" busy={busy === 'Configuração fiscal gravada.'}>
                  Gravar
                </Button>
              </div>
            )}
          </fieldset>
          {!editable && can('fiscal.manage') && <p className="mt-3 text-[13px] text-ink-faint">Ative a verificação em duas etapas na sua conta para alterar.</p>}
        </form>
      </Panel>
    </div>
  );
}

// ---------------- notas ----------------

function Documents() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page) });
    if (status) p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    api(`/admin/fiscal/documents?${p}`).then(setData, (e) => setError(e.message));
  }, [status, q, page]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Panel>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          load();
        }}
      >
        <Input aria-label="Buscar" placeholder="Número da nota, do pedido, chave ou cliente" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <select aria-label="Situação" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} className="h-9 rounded-[var(--radius-ctl)] border border-line-strong bg-card px-2 text-sm">
          <option value="">Todas as situações</option>
          {Object.entries(DOC_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <Button type="submit">Buscar</Button>
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {data && data.documents.length === 0 && <Empty title="Nenhuma nota">As notas aparecem aqui quando forem emitidas a partir dos pedidos.</Empty>}
      {data && data.documents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-soft">
              <tr>
                <th className="pb-2 font-medium">Nota</th>
                <th className="pb-2 pl-3 font-medium">Pedido</th>
                <th className="pb-2 pl-3 font-medium">Cliente</th>
                <th className="pb-2 pl-3 text-right font-medium">Valor</th>
                <th className="pb-2 pl-3 font-medium">Situação</th>
                <th className="pb-2 pl-3 font-medium">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.documents.map((d: any) => (
                <tr key={d.id}>
                  <td className="py-2">
                    <Link href={`/painel/fiscal/notas/${d.id}`} className="font-medium text-act-dark underline">
                      {d.number ? `nº ${d.number}` : d.ref}
                    </Link>
                    {d.environment === 'homologacao' && <span className="ml-1.5 text-xs text-ink-faint">homologação</span>}
                  </td>
                  <td className="py-2 pl-3">
                    <Link href={`/painel/pedidos/${d.order_id}`} className="underline">
                      {d.order_number}
                    </Link>
                  </td>
                  <td className="max-w-48 truncate py-2 pl-3">{d.buyer_name}</td>
                  <td className="num py-2 pl-3 text-right">{money(d.total_cents)}</td>
                  <td className="py-2 pl-3">
                    <Badge tone={DOC_STATUS[d.status]!.tone}>{DOC_STATUS[d.status]!.label}</Badge>
                  </td>
                  <td className="num py-2 pl-3 whitespace-nowrap text-ink-soft">{when(d.authorized_at ?? d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.pageSize && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
                Anterior
              </Button>
              <span>
                Página {page} de {Math.ceil(data.total / data.pageSize)}
              </span>
              <Button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
                Próxima
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------- regras ----------------

const emptyRule = {
  name: '',
  destination: 'internal',
  buyerKind: 'pf',
  naturezaOperacao: '',
  cfop: '',
  icmsSituacaoTributaria: '',
  pisSituacaoTributaria: '',
  cofinsSituacaoTributaria: '',
  consumidorFinal: true,
  presencaComprador: 2,
  extraFields: '{}',
  itemExtraFields: '{}',
  notes: '',
};
type RuleForm = typeof emptyRule;

const toForm = (r: any): RuleForm => ({
  name: r.name,
  destination: r.destination,
  buyerKind: r.buyer_kind,
  naturezaOperacao: r.natureza_operacao,
  cfop: r.cfop,
  icmsSituacaoTributaria: r.icms_situacao_tributaria,
  pisSituacaoTributaria: r.pis_situacao_tributaria,
  cofinsSituacaoTributaria: r.cofins_situacao_tributaria,
  consumidorFinal: r.consumidor_final,
  presencaComprador: r.presenca_comprador,
  extraFields: JSON.stringify(r.extra_fields, null, 1),
  itemExtraFields: JSON.stringify(r.item_extra_fields, null, 1),
  notes: r.notes ?? '',
});

function RuleEditor({ initial, id, onDone }: { initial: RuleForm; id: string | null; onDone: (msg: string) => void }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof RuleForm) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    let extra: unknown, itemExtra: unknown;
    try {
      extra = JSON.parse(f.extraFields || '{}');
      itemExtra = JSON.parse(f.itemExtraFields || '{}');
    } catch {
      setError('Campos adicionais: use o formato JSON, por exemplo {"campo": "valor"}.');
      return;
    }
    setBusy(true);
    try {
      await api(id ? `/admin/fiscal/rules/${id}` : '/admin/fiscal/rules', {
        method: id ? 'PUT' : 'POST',
        body: { ...f, presencaComprador: Number(f.presencaComprador), extraFields: extra, itemExtraFields: itemExtra, notes: f.notes || null },
      });
      onDone(id ? 'Regra alterada. Ela precisa ser validada de novo pelo contador.' : 'Regra criada. Falta a validação do contador.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-md border border-line bg-sunken/40 p-3 sm:grid-cols-4">
      <Field label="Nome da regra" required className="sm:col-span-2">
        {(i) => <Input id={i} required minLength={2} maxLength={80} {...set('name')} />}
      </Field>
      <Field label="Destino">
        {(i) => (
          <Select id={i} {...set('destination')}>
            {Object.entries(DESTINATION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Comprador">
        {(i) => (
          <Select id={i} {...set('buyerKind')}>
            {Object.entries(BUYER_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Natureza da operação" required className="sm:col-span-2">
        {(i) => <Input id={i} required maxLength={60} {...set('naturezaOperacao')} />}
      </Field>
      <Field label="CFOP" required hint="Saída: 5xxx, 6xxx ou 7xxx.">
        {(i) => <Input id={i} required inputMode="numeric" pattern="[5-7][0-9]{3}" {...set('cfop')} />}
      </Field>
      <Field label="ICMS: CST ou CSOSN" required>
        {(i) => <Input id={i} required inputMode="numeric" pattern="[0-9]{2,3}" {...set('icmsSituacaoTributaria')} />}
      </Field>
      <Field label="PIS: CST" required>
        {(i) => <Input id={i} required inputMode="numeric" pattern="[0-9]{2}" {...set('pisSituacaoTributaria')} />}
      </Field>
      <Field label="COFINS: CST" required>
        {(i) => <Input id={i} required inputMode="numeric" pattern="[0-9]{2}" {...set('cofinsSituacaoTributaria')} />}
      </Field>
      <Field label="Consumidor final">
        {(i) => (
          <Select id={i} value={f.consumidorFinal ? '1' : '0'} onChange={(e) => setF({ ...f, consumidorFinal: e.target.value === '1' })}>
            <option value="1">Sim</option>
            <option value="0">Não</option>
          </Select>
        )}
      </Field>
      <Field label="Presença do comprador">
        {(i) => (
          <Select id={i} {...set('presencaComprador')}>
            {Object.entries(PRESENCE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Campos adicionais da nota (JSON)" hint="Nomes de campo da API do provedor, como os de IBS/CBS. Definidos com o contador." className="sm:col-span-2">
        {(i) => <Textarea id={i} className="min-h-20 font-mono text-xs" {...set('extraFields')} />}
      </Field>
      <Field label="Campos adicionais de cada item (JSON)" className="sm:col-span-2">
        {(i) => <Textarea id={i} className="min-h-20 font-mono text-xs" {...set('itemExtraFields')} />}
      </Field>
      <Field label="Observações" className="sm:col-span-4">
        {(i) => <Input id={i} maxLength={2000} {...set('notes')} />}
      </Field>
      {error && (
        <div className="sm:col-span-4">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      <div className="flex gap-2 sm:col-span-4">
        <Button type="submit" variant="primary" busy={busy}>
          {id ? 'Gravar alteração' : 'Criar regra'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone('')}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function Rules() {
  const { can, me } = useMe();
  const [rules, setRules] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [validator, setValidator] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const manage = can('fiscal.manage') && me.user.mfaEnabled;
  const validate = can('fiscal.validate') && me.user.mfaEnabled;
  const load = useCallback(() => api('/admin/fiscal/rules').then((r) => setRules(r.rules), (e) => setMsg({ tone: 'bad', text: e.message })), []);
  useEffect(() => {
    load();
  }, [load]);
  const done = (text: string) => {
    setEditing(null);
    if (text) setMsg({ tone: 'good', text });
    load();
  };
  const post = async (path: string, body: object, ok: string) => {
    setMsg(null);
    try {
      await api(path, { method: 'POST', body });
      done(ok);
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  return (
    <Panel
      title="Regras por operação"
      description="CFOP, CST/CSOSN e natureza da operação para cada tipo de venda. Os códigos vêm do contador; o sistema só confere o formato."
      actions={
        manage && editing !== 'new' ? (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Nova regra
          </Button>
        ) : null
      }
    >
      {msg && (
        <div className="mb-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
      {editing === 'new' && (
        <div className="mb-4">
          <RuleEditor initial={emptyRule} id={null} onDone={done} />
        </div>
      )}
      {rules && rules.length === 0 && editing !== 'new' && <Empty title="Nenhuma regra">Sem regra validada, nenhuma nota é emitida.</Empty>}
      <ul className="space-y-3">
        {rules?.map((r) => (
          <li key={r.id} className={`rounded-md border border-line p-3 ${r.active ? '' : 'opacity-60'}`}>
            {editing === r.id ? (
              <RuleEditor initial={toForm(r)} id={r.id} onDone={done} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {!r.active ? <Badge>Desativada</Badge> : r.status === 'validated' ? <Badge tone="good">Validada por {r.validator_name}</Badge> : <Badge tone="warn">Aguardando validação</Badge>}
                </div>
                <p className="mt-1 text-sm text-ink-soft">
                  {DESTINATION[r.destination]} · {BUYER_KIND[r.buyer_kind]} · {r.natureza_operacao}
                </p>
                <p className="num mt-1 text-sm">
                  CFOP {r.cfop} · ICMS {r.icms_situacao_tributaria} · PIS {r.pis_situacao_tributaria} · COFINS {r.cofins_situacao_tributaria} · consumidor final {r.consumidor_final ? 'sim' : 'não'} · presença {r.presenca_comprador}
                  {Object.keys(r.extra_fields).length + Object.keys(r.item_extra_fields).length > 0 && ` · ${Object.keys(r.extra_fields).length + Object.keys(r.item_extra_fields).length} campo(s) adicional(is)`}
                </p>
                {r.active && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {manage && (
                      <Button variant="ghost" onClick={() => setEditing(r.id)}>
                        Editar
                      </Button>
                    )}
                    {validate && r.status !== 'validated' && (
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          post(`/admin/fiscal/rules/${r.id}/validate`, { validatorName: validator }, 'Regra validada.');
                        }}
                      >
                        <Input aria-label="Nome de quem valida" placeholder="Nome do contador" required minLength={2} value={validator} onChange={(e) => setValidator(e.target.value)} className="w-48" />
                        <Button type="submit">Validar</Button>
                      </form>
                    )}
                    {manage && (
                      <Button variant="ghost" onClick={() => post(`/admin/fiscal/rules/${r.id}/deactivate`, {}, 'Regra desativada.')}>
                        Desativar
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------- certificado e numeracao ----------------

function Numbering({ ov, reload }: { ov: any; reload: () => void }) {
  const { can, me } = useMe();
  const manage = can('fiscal.manage') && me.user.mfaEnabled;
  const [cert, setCert] = useState({ holderName: '', cnpj: '', validFrom: '', validUntil: '', fingerprint: '', notes: '' });
  const [inut, setInut] = useState({ series: '1', start: '', end: '', justification: '' });
  const [list, setList] = useState<any[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const loadInut = useCallback(() => api('/admin/fiscal/inutilizations').then((r) => setList(r.inutilizations), () => null), []);
  useEffect(() => {
    loadInut();
  }, [loadInut]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
      reload();
      loadInut();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };
  const c = ov.certificate;

  return (
    <div className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Panel title="Certificado digital A1" description="O arquivo do certificado é enviado direto ao provedor fiscal, que assina as notas. A loja não guarda a chave: registre aqui só a validade, para os avisos de 30, 15 e 7 dias.">
        {c ? (
          <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{c.holder_name}</span>
            <span className="text-ink-soft">CNPJ {formatCnpj(c.cnpj)}</span>
            <span className="text-ink-soft">
              válido até {new Date(c.valid_until).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
            </span>
            <Badge tone={CERT_ALERT[c.alert.level]!.tone}>{CERT_ALERT[c.alert.level]!.label(c.alert.days)}</Badge>
          </p>
        ) : (
          <p className="mb-4 text-sm text-ink-soft">Nenhum certificado registrado.</p>
        )}
        {manage && (
          <form
            className="grid gap-3 sm:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api('/admin/fiscal/certificates', { method: 'POST', body: { ...cert, fingerprint: cert.fingerprint || null, notes: cert.notes || null } }), 'Certificado registrado.');
            }}
          >
            <Field label="Titular" required className="sm:col-span-2">
              {(i) => <Input id={i} required value={cert.holderName} onChange={(e) => setCert({ ...cert, holderName: e.target.value })} />}
            </Field>
            <Field label="CNPJ" required className="sm:col-span-2">
              {(i) => <Input id={i} required value={cert.cnpj} onChange={(e) => setCert({ ...cert, cnpj: e.target.value })} />}
            </Field>
            <Field label="Válido desde" required>
              {(i) => <Input id={i} type="date" required value={cert.validFrom} onChange={(e) => setCert({ ...cert, validFrom: e.target.value })} />}
            </Field>
            <Field label="Válido até" required>
              {(i) => <Input id={i} type="date" required value={cert.validUntil} onChange={(e) => setCert({ ...cert, validUntil: e.target.value })} />}
            </Field>
            <Field label="Impressão digital (opcional)" className="sm:col-span-2">
              {(i) => <Input id={i} value={cert.fingerprint} onChange={(e) => setCert({ ...cert, fingerprint: e.target.value })} />}
            </Field>
            <div className="sm:col-span-4">
              <Button type="submit">Registrar certificado</Button>
            </div>
          </form>
        )}
      </Panel>

      <Panel title="Numeração" description="Série e número são controlados pelo provedor fiscal (configure no painel dele). Use a inutilização só para salto de numeração, com orientação do contador.">
        {manage && (
          <form
            className="mb-4 grid gap-3 sm:grid-cols-6"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => api('/admin/fiscal/inutilizations', { method: 'POST', body: { series: inut.series, start: Number(inut.start), end: Number(inut.end || inut.start), justification: inut.justification } }),
                'Inutilização registrada na SEFAZ.',
              );
            }}
          >
            <Field label="Série">{(i) => <Input id={i} required inputMode="numeric" value={inut.series} onChange={(e) => setInut({ ...inut, series: e.target.value })} />}</Field>
            <Field label="De nº">{(i) => <Input id={i} required inputMode="numeric" value={inut.start} onChange={(e) => setInut({ ...inut, start: e.target.value.replace(/\D/g, '') })} />}</Field>
            <Field label="Até nº">{(i) => <Input id={i} inputMode="numeric" value={inut.end} onChange={(e) => setInut({ ...inut, end: e.target.value.replace(/\D/g, '') })} />}</Field>
            <Field label="Justificativa" hint="Ao menos 15 caracteres." className="sm:col-span-3">
              {(i) => <Input id={i} required minLength={15} maxLength={255} value={inut.justification} onChange={(e) => setInut({ ...inut, justification: e.target.value })} />}
            </Field>
            <div className="sm:col-span-6">
              <Button type="submit" variant="danger">
                Inutilizar faixa
              </Button>
            </div>
          </form>
        )}
        {list.length === 0 ? (
          <p className="text-sm text-ink-soft">Nenhuma inutilização.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {list.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                <Badge tone={i.status === 'authorized' ? 'good' : 'bad'}>{i.status === 'authorized' ? 'Homologada' : 'Recusada'}</Badge>
                <span className="num">
                  Série {i.series}, {i.number_start}
                  {i.number_end !== i.number_start ? ` a ${i.number_end}` : ''}
                </span>
                <span className="text-ink-soft">{i.justification}</span>
                <span className="text-xs text-ink-faint">
                  {when(i.created_at)} · {i.created_by_name}
                  {i.environment === 'homologacao' ? ' · homologação' : ''}
                </span>
                {i.file_id && (
                  <a className="text-act-dark underline" href={`/api/v1/admin/fiscal/files/${i.file_id}`}>
                    XML
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function FiscalPage() {
  const [tab, setTab] = useState<Tab>('geral');
  const [ov, setOv] = useState<any>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api('/admin/fiscal/overview').then(setOv, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = new URLSearchParams(window.location.search).get('aba');
    if (TABS.some(([k]) => k === t)) setTab(t as Tab);
  }, [load]);

  return (
    <>
      <PageHeader
        title="Nota fiscal"
        description={
          ov && (
            <span className="flex flex-wrap items-center gap-1.5">
              NF-e modelo 55
              <Badge tone={ov.settings.environment === 'producao' ? 'good' : 'warn'}>{ov.settings.environment === 'producao' ? 'Produção' : 'Homologação: sem valor fiscal'}</Badge>
            </span>
          )
        }
      />
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${tab === k ? 'border-act text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {!ov && !error && <p className="text-sm text-ink-soft">Carregando…</p>}
      {ov && tab === 'geral' && <Overview key={ov.settings.updated_at} ov={ov} reload={load} />}
      {tab === 'notas' && <Documents />}
      {tab === 'regras' && <Rules />}
      {ov && tab === 'numeracao' && <Numbering ov={ov} reload={load} />}
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="fiscal.view">
      <FiscalPage />
    </Guard>
  );
}

