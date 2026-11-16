'use client';

import { useEffect, useState } from 'react';
import { Guard } from '@/components/shell';
import { Button, Notice, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { when } from '@/lib/format';

const ACTIONS: Record<string, string> = {
  'auth.login': 'Entrou no painel',
  'auth.login_failed': 'Tentativa de acesso recusada',
  'auth.logout': 'Saiu do painel',
  'auth.password_changed': 'Trocou a senha',
  'auth.password_reset': 'Redefiniu a senha',
  'auth.mfa_enabled': 'Ativou a verificação em duas etapas',
  'users.created': 'Criou usuário',
  'users.updated': 'Alterou usuário',
  'users.owner_bootstrap': 'Primeiro proprietário criado',
  'categories.created': 'Criou categoria',
  'categories.updated': 'Alterou categoria',
  'categories.deleted': 'Excluiu categoria',
  'products.created': 'Cadastrou produto',
  'products.updated': 'Alterou produto',
  'products.image_added': 'Adicionou foto',
  'products.image_updated': 'Alterou foto',
  'products.image_removed': 'Removeu foto',
  'fiscal.product_informed': 'Informou dados fiscais do produto',
  'fiscal.product_validated': 'Validou classificação fiscal',
  'fiscal.settings_updated': 'Alterou a configuração fiscal',
  'company.updated': 'Alterou dados da empresa',
  'settings.store_updated': 'Alterou a marca da loja',
  'users.password_reset': 'Gerou nova senha para usuário',
  'products.image_replaced': 'Trocou o arquivo de uma foto',
  'products.images_reordered': 'Reordenou as fotos',
  'fiscal.certificate_registered': 'Cadastrou o certificado digital',
  'fiscal.production_released': 'Liberou a emissão em produção',
  'fiscal.rule_created': 'Criou regra fiscal',
  'fiscal.rule_updated': 'Alterou regra fiscal',
  'fiscal.rule_validated': 'Validou regra fiscal',
  'fiscal.rule_deactivated': 'Desativou regra fiscal',
  'fiscal.nfe_emit': 'Emitiu NF-e',
  'fiscal.nfe_cancel': 'Cancelou NF-e',
  'fiscal.nfe_correction': 'Enviou carta de correção',
  'fiscal.inutilization': 'Inutilizou numeração de NF-e',
  'order.status': 'Mudou o status do pedido',
  'order.dispatch': 'Despachou pedido',
  'order.cancel': 'Cancelou pedido',
  'stock.reserved': 'Reservou estoque',
  'stock.reservation_released': 'Liberou reserva de estoque',
  'stock.reservation_consumed': 'Baixou reserva de estoque',
  'inventory.opened': 'Abriu inventário',
  'inventory.closed': 'Fechou inventário',
  'inventory.canceled': 'Cancelou inventário',
  'suppliers.created': 'Cadastrou fornecedor',
  'suppliers.updated': 'Alterou fornecedor',
  'suppliers.offers_updated': 'Alterou a lista de custos do fornecedor',
  'suppliers.status_changed': 'Mudou a situação do fornecedor',
  'suppliers.archived': 'Arquivou fornecedor',
  'suppliers.restored': 'Restaurou fornecedor',
  'suppliers.offer_created': 'Incluiu oferta do fornecedor',
  'suppliers.offer_updated': 'Alterou oferta do fornecedor',
  'suppliers.offer_ended': 'Encerrou oferta do fornecedor',
  'suppliers.offer_reactivated': 'Reativou oferta do fornecedor',
  'suppliers.primary_changed': 'Trocou o fornecedor principal',
  'suppliers.availability_reported': 'Informou disponibilidade do fornecedor',
  'suppliers.settings_updated': 'Alterou os parâmetros de fornecedores',
  'purchases.min_exception': 'Comprou abaixo do mínimo do fornecedor',
  'purchases.created': 'Criou pedido de compra',
  'purchases.updated': 'Alterou pedido de compra',
  'purchases.sent': 'Enviou pedido de compra',
  'purchases.received': 'Recebeu mercadoria',
  'purchases.closed_short': 'Encerrou compra com falta',
  'purchases.canceled': 'Cancelou pedido de compra',
  'purchases.invoice_imported': 'Importou nota de compra',
  'purchases.invoice_linked': 'Ligou nota de compra ao pedido',
  'sales.quote_created': 'Criou orçamento',
  'sales.quote_canceled': 'Cancelou orçamento',
  'marketplace.import': 'Importou anúncios do marketplace',
  'marketplace.listing_link': 'Ligou anúncio a produto',
  'marketplace.listing_update': 'Alterou anúncio do marketplace',
  'marketplace.order_fetch': 'Buscou venda do marketplace',
  'marketplace.cancel': 'Venda cancelada no marketplace',
  'marketplace.disconnect': 'Desconectou marketplace',
  'marketplace.reauth_required': 'Marketplace pediu nova autorização',
  'marketplace.rename': 'Renomeou conta do marketplace',
  'whatsapp.template': 'Alterou modelo de mensagem do WhatsApp',
  'whatsapp.reply': 'Respondeu pelo WhatsApp',
  'whatsapp.bot_settings': 'Alterou o bot de atendimento do WhatsApp',
  'whatsapp.conversation_taken': 'Assumiu conversa do WhatsApp',
  'whatsapp.conversation_released': 'Devolveu conversa do WhatsApp ao bot',
  'email.settings_updated': 'Alterou o remetente dos e-mails',
  'email.template_updated': 'Alterou o texto de um e-mail automático',
  'email.template_restored': 'Restaurou o texto padrão de um e-mail',
  'email.connection_tested': 'Testou a conexão do e-mail',
  'email.test_sent': 'Enviou e-mail de teste',
  'email.account_created': 'Criou caixa de e-mail',
  'email.account_updated': 'Alterou o nome de uma caixa de e-mail',
  'email.account_password_changed': 'Trocou a senha de uma caixa de e-mail',
  'email.account_suspended': 'Suspendeu caixa de e-mail',
  'email.account_reactivated': 'Reativou caixa de e-mail',
  'email.account_deleted': 'Excluiu caixa de e-mail',
  'email.alias_created': 'Criou apelido de e-mail',
  'email.alias_updated': 'Alterou apelido de e-mail',
  'email.alias_deleted': 'Excluiu apelido de e-mail',
};

function Audit() {
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (entity) p.set('entity', entity);
    api(`/admin/audit?${p}`).then((r) => setEntries(r.entries), (e) => setError(e.message));
  }, [entity, page]);

  return (
    <>
      <PageHeader title="Auditoria" description="Registro permanente: ninguém, nem o proprietário, consegue alterar ou apagar." />
      <div className="mb-4">
        <Select aria-label="Filtrar" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} className="w-auto">
          <option value="">Tudo</option>
          <option value="product">Produtos</option>
          <option value="category">Categorias</option>
          <option value="company">Empresa</option>
          <option value="fiscal_settings">Configuração fiscal</option>
          <option value="user">Usuários</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="overflow-hidden rounded-lg border border-line bg-card">
        <ul className="divide-y divide-line text-sm">
          {entries.map((e) => (
            <li key={e.id} className="px-4 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="num text-ink-faint">{when(e.created_at)}</span>
                <span className="font-medium">{e.actor_name ?? 'Sistema'}</span>
                <span>{ACTIONS[e.action] ?? e.action}</span>
                {e.ip && <span className="num text-xs text-ink-faint">IP {e.ip}</span>}
                {(e.before || e.after) && (
                  <button className="text-act hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'ocultar' : 'detalhes'}</button>
                )}
              </div>
              {open === e.id && (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {(['before', 'after'] as const).map((k) =>
                    e[k] ? (
                      <div key={k}>
                        <p className="text-xs font-medium text-ink-soft">{k === 'before' ? 'Antes' : 'Depois'}</p>
                        <pre className="mt-1 max-h-72 overflow-auto rounded bg-sunken p-2 text-xs">{JSON.stringify(e[k], null, 2)}</pre>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex gap-2">
        <Button disabled={page === 1} onClick={() => setPage(page - 1)}>Anteriores</Button>
        <Button disabled={entries.length < 50} onClick={() => setPage(page + 1)}>Mais antigos</Button>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Guard perm="audit.view">
      <Audit />
    </Guard>
  );
}
