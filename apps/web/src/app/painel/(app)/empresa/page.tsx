'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Guard, useMe } from '@/components/shell';
import { Badge, Button, Field, Input, Notice, PageHeader, Panel, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCnpj, TAX_REGIMES, when } from '@/lib/format';

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

// Campo da tela → coluna do banco.
const FIELDS = {
  legalName: 'legal_name', tradeName: 'trade_name', cnpj: 'cnpj', stateRegistration: 'state_registration', municipalRegistration: 'municipal_registration',
  street: 'street', number: 'number', complement: 'complement', district: 'district', city: 'city', cityIbge: 'city_ibge', uf: 'uf', cep: 'cep',
  phone: 'phone', email: 'email', cnaeMain: 'cnae_main', taxRegime: 'tax_regime',
  accountantName: 'accountant_name', accountantCrc: 'accountant_crc', accountantFirm: 'accountant_firm', accountantEmail: 'accountant_email', accountantPhone: 'accountant_phone',
} as const;
type Key = keyof typeof FIELDS;
type Form = Record<Key, string> & { cnaesSecondary: string; changeNote: string };

const fromRow = (row: any): Form => {
  const f = Object.fromEntries(Object.entries(FIELDS).map(([k, col]) => [k, row?.[col] ?? ''])) as Form;
  f.cnpj = formatCnpj(row?.cnpj ?? null);
  f.cnaesSecondary = (row?.cnaes_secondary ?? []).join(', ');
  f.changeNote = '';
  return f;
};

function CompanyForm() {
  const { can, me } = useMe();
  const [form, setForm] = useState<Form>(fromRow(null));
  const [versions, setVersions] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = can('company.manage') && me.user.mfaEnabled;

  const load = useCallback(async () => {
    const r = await api('/admin/company');
    setForm(fromRow(r.company));
    setVersions(r.versions);
  }, []);
  useEffect(() => void load().catch((e) => setMsg({ tone: 'bad', text: e.message })), [load]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { ...form, cnaesSecondary: form.cnaesSecondary.split(/[,;\s]+/).map((c) => c.replace(/\D/g, '')).filter(Boolean) };
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      await api('/admin/company', { method: 'PUT', body });
      setMsg({ tone: 'good', text: 'Dados gravados como nova versão. As versões anteriores foram preservadas.' });
      await load();
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    } finally {
      setBusy(false);
    }
  };

  const text = (k: Key, label: string, opts: { required?: boolean; hint?: string; className?: string; inputMode?: 'numeric' | 'email' | 'tel' } = {}) => (
    <Field label={label} required={opts.required} hint={opts.hint} className={opts.className}>
      {(id) => <Input id={id} value={form[k]} onChange={set(k)} inputMode={opts.inputMode} />}
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!editable && <Notice>{can('company.manage') ? 'Ative a verificação em duas etapas para alterar os dados da empresa.' : 'Somente consulta.'}</Notice>}
      <fieldset disabled={!editable} className="space-y-4">
        <Panel title="Emitente (CNPJ da sede)" description="Informe exatamente como consta no cartão CNPJ e no cadastro da SEF-SC. Campos com * são exigidos na NF-e.">
          <div className="grid gap-4 sm:grid-cols-6">
            {text('legalName', 'Razão social', { required: true, className: 'sm:col-span-4' })}
            {text('cnpj', 'CNPJ', { required: true, className: 'sm:col-span-2', hint: 'Numérico ou alfanumérico.' })}
            {text('tradeName', 'Nome fantasia', { className: 'sm:col-span-2' })}
            {text('stateRegistration', 'Inscrição Estadual', { required: true, className: 'sm:col-span-2', inputMode: 'numeric' })}
            {text('municipalRegistration', 'Inscrição Municipal', { className: 'sm:col-span-2', hint: 'Quando houver.' })}
            <Field label="Regime tributário" required className="sm:col-span-3" hint="Confirme com o contador.">
              {(id) => (
                <Select id={id} value={form.taxRegime} onChange={set('taxRegime')}>
                  <option value="">Não informado</option>
                  {Object.entries(TAX_REGIMES).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              )}
            </Field>
            {text('cnaeMain', 'CNAE principal', { className: 'sm:col-span-3', inputMode: 'numeric', hint: '7 dígitos.' })}
            <Field label="CNAEs secundários" className="sm:col-span-6" hint="Separe por vírgula.">{(id) => <Input id={id} value={form.cnaesSecondary} onChange={set('cnaesSecondary')} />}</Field>
          </div>
        </Panel>
        <Panel title="Endereço da sede">
          <div className="grid gap-4 sm:grid-cols-6">
            {text('cep', 'CEP', { required: true, className: 'sm:col-span-2', inputMode: 'numeric' })}
            {text('street', 'Logradouro', { required: true, className: 'sm:col-span-4' })}
            {text('number', 'Número', { required: true, className: 'sm:col-span-1' })}
            {text('complement', 'Complemento', { className: 'sm:col-span-2' })}
            {text('district', 'Bairro', { required: true, className: 'sm:col-span-3' })}
            {text('city', 'Município', { required: true, className: 'sm:col-span-3' })}
            <Field label="UF" required className="sm:col-span-1">
              {(id) => (
                <Select id={id} value={form.uf} onChange={set('uf')}>
                  <option value="" />
                  {UFS.map((u) => <option key={u}>{u}</option>)}
                </Select>
              )}
            </Field>
            {text('cityIbge', 'Código IBGE', { required: true, className: 'sm:col-span-2', inputMode: 'numeric', hint: '7 dígitos, da tabela do IBGE.' })}
            {text('phone', 'Telefone', { className: 'sm:col-span-3', inputMode: 'tel' })}
            {text('email', 'E-mail', { className: 'sm:col-span-3', inputMode: 'email' })}
          </div>
        </Panel>
        <Panel title="Contador ou responsável fiscal" description="Quem valida a classificação fiscal dos produtos e as regras de tributação.">
          <div className="grid gap-4 sm:grid-cols-6">
            {text('accountantName', 'Nome', { required: true, className: 'sm:col-span-3' })}
            {text('accountantCrc', 'CRC', { required: true, className: 'sm:col-span-3' })}
            {text('accountantFirm', 'Escritório', { className: 'sm:col-span-6' })}
            {text('accountantEmail', 'E-mail', { className: 'sm:col-span-3', inputMode: 'email' })}
            {text('accountantPhone', 'Telefone', { className: 'sm:col-span-3', inputMode: 'tel' })}
          </div>
        </Panel>
        {editable && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Motivo da alteração" className="min-w-64 flex-1" hint="Fica no histórico desta versão.">{(id) => <Input id={id} maxLength={300} value={form.changeNote} onChange={set('changeNote')} />}</Field>
            <Button type="submit" variant="primary" busy={busy}>Gravar nova versão</Button>
          </div>
        )}
      </fieldset>
      <Panel title="Versões" description="Cada gravação cria uma versão. As notas emitidas guardam a versão vigente no momento da emissão.">
        {versions.length === 0 ? (
          <p className="text-sm text-ink-soft">Nenhuma versão gravada.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap gap-x-4 py-1.5">
                <span className="num w-12 font-medium">v{v.version}</span>
                <span className="num text-ink-soft">{when(v.created_at)}</span>
                <span className="text-ink-soft">{v.created_by}</span>
                <span>{v.change_note}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </form>
  );
}

const ACCREDITATION = { not_started: 'Não iniciado', in_progress: 'Em andamento', accredited: 'Credenciado' };

function FiscalSettings() {
  const { can, me } = useMe();
  const [s, setS] = useState<any>(null);
  const [series, setSeries] = useState('');
  const [next, setNext] = useState('');
  const [acc, setAcc] = useState('not_started');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const editable = can('fiscal.manage') && me.user.mfaEnabled;
  const apply = (x: any) => {
    setS(x);
    setSeries(x.nfe_series ?? '');
    setNext(x.nfe_next_number ?? '');
    setAcc(x.accreditation_status);
    setNotes(x.accreditation_notes ?? '');
  };
  useEffect(() => {
    if (can('fiscal.view')) api('/admin/fiscal/settings').then((r) => apply(r.settings), (e) => setMsg({ tone: 'bad', text: e.message }));
  }, [can]);
  if (!can('fiscal.view') || !s) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/admin/fiscal/settings', { method: 'PATCH', body: { nfeSeries: series === '' ? null : Number(series), nfeNextNumber: next === '' ? null : Number(next), accreditationStatus: acc, accreditationNotes: notes || null } });
      apply(r.settings);
      setMsg({ tone: 'good', text: 'Configuração fiscal gravada.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Falha.' });
    }
  };

  return (
    <div id="fiscal">
      <Panel
        title="Emissão de NF-e (modelo 55)"
        description="A emissão real só é liberada depois da homologação com o provedor fiscal e da validação do contador."
        actions={<Badge tone={s.environment === 'producao' ? 'good' : 'warn'}>{s.environment === 'producao' ? 'Produção' : 'Homologação'}</Badge>}
      >
        {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
        <form onSubmit={save}>
          <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-4">
            <Field label="Credenciamento na SEF-SC">
              {(id) => (
                <Select id={id} value={acc} onChange={(e) => setAcc(e.target.value)}>
                  {Object.entries(ACCREDITATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Série" hint="0 a 999.">{(id) => <Input id={id} type="number" min={0} max={999} value={series} onChange={(e) => setSeries(e.target.value)} />}</Field>
            <Field label="Próximo número" hint="Se já emitiu em outro sistema, o seguinte ao último usado.">{(id) => <Input id={id} type="number" min={1} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
            <Field label="Provedor fiscal" hint="Escolhido na Fase 5.">{(id) => <Input id={id} value={s.provider ?? 'Não definido'} disabled />}</Field>
            <Field label="Anotações do credenciamento" className="sm:col-span-4">{(id) => <Input id={id} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
            {editable && <div className="sm:col-span-4"><Button type="submit">Gravar</Button></div>}
          </fieldset>
        </form>
        <p className="mt-4 text-[13px] text-ink-faint">Certificado digital A1: o envio protegido (arquivo cifrado e alerta de vencimento) entra na Fase 5, junto com o provedor fiscal.</p>
      </Panel>
    </div>
  );
}

export default function Page() {
  return (
    <Guard perm="company.view">
      <PageHeader title="Empresa e fiscal" description="Dados cadastrais do estabelecimento emissor. Nada é preenchido automaticamente: informe os dados reais ou deixe em branco até tê-los." />
      <div className="space-y-4">
        <CompanyForm />
        <FiscalSettings />
      </div>
    </Guard>
  );
}
