-- #41 Motor de decisão em modo sombra (épico #149): o que o motor faria com cada proposta, e com
-- #41 que limite, por nível. Nesta história o motor não aprova nada; só grava a decisão.
-- #41 RLS ligado e nenhuma política: só a chave secreta (o Worker) lê e grava.

-- #41 Uma decisão do motor por proposta, por versão do modelo e por modo, com o contrato do #149.
-- #41 A unicidade (proposal_id, model_version, mode) deixa o Cron repetir a rodada sem duplicar.
create table public.engine_decisions (
  id bigint generated always as identity,
  proposal_id bigint not null,
  invoice_access_key text not null,
  outcome text not null,
  decided_by text not null,
  -- #41 Confiança do Clef, de 0 a 1; só existe quando foi o Clef quem decidiu.
  confidence numeric,
  -- #41 A versão do Clef, ou a da regra quando a regra decide; entra na unicidade.
  model_version text not null,
  mode text not null,
  -- #41 O porquê, em uma frase, citando a evidência.
  reason text not null,
  pending_reason text,
  -- #41 As chaves dos casos parecidos da base de critérios (#139); vazio até lá.
  similar_cases text[] not null default '{}',
  -- #41 O pedido de delegação do grupo 2 (#138/#42); a chave estrangeira entra com a tabela dele.
  delegation_id bigint,
  -- #41 AC-6 A falha ou o tempo esgotado do Clef (a classe do erro, nunca dado sensível).
  error text,
  latency_ms integer,
  decided_at timestamptz not null default now(),
  constraint engine_decisions_pkey primary key (id),
  constraint engine_decisions_proposal_fkey foreign key (proposal_id) references public.proposals (id) on delete cascade,
  constraint engine_decisions_invoice_fkey foreign key (invoice_access_key) references public.invoices (access_key) on delete cascade,
  constraint engine_decisions_proposal_model_mode_key unique (proposal_id, model_version, mode),
  constraint engine_decisions_outcome_check check (outcome in ('approve', 'refuse', 'pending')),
  constraint engine_decisions_decided_by_check check (decided_by in ('rule', 'clef', 'person')),
  constraint engine_decisions_mode_check check (mode in ('shadow', 'delegated')),
  constraint engine_decisions_confidence_range_check check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint engine_decisions_confidence_clef_check check ((decided_by = 'clef') = (confidence is not null)),
  constraint engine_decisions_pending_reason_check check (
    pending_reason in ('below_confidence', 'outside_criteria', 'level_not_delegable', 'delegation_off', 'clef_failed')
  ),
  constraint engine_decisions_pending_reason_required_check check ((outcome = 'pending') = (pending_reason is not null)),
  -- #41 Quando a cascata chega à pessoa, o motor não decidiu: a decisão fica pendente.
  constraint engine_decisions_person_pending_check check (decided_by <> 'person' or outcome = 'pending'),
  constraint engine_decisions_reason_check check (length(btrim(reason)) > 0),
  constraint engine_decisions_model_version_check check (length(btrim(model_version)) > 0),
  constraint engine_decisions_latency_check check (latency_ms is null or latency_ms >= 0)
);
-- #41 O relatório de acerto filtra pelo modo e agrupa por semana (decided_at).
create index engine_decisions_mode_decided_at_idx on public.engine_decisions (mode, decided_at);
create index engine_decisions_invoice_idx on public.engine_decisions (invoice_access_key);
alter table public.engine_decisions enable row level security;

-- #41 AC-4 do #149: limite de confiança e delegação por nível, mudados no banco, sem deploy.
create table public.engine_settings (
  level text not null,
  delegation_enabled boolean not null default false,
  confidence_threshold numeric not null default 0.98,
  clef_timeout_ms integer not null default 3000,
  updated_at timestamptz not null default now(),
  constraint engine_settings_pkey primary key (level),
  constraint engine_settings_level_check check (level in ('regra', 'analista', 'coordenacao', 'diretoria', 'bloqueio')),
  constraint engine_settings_threshold_check check (confidence_threshold >= 0 and confidence_threshold <= 1),
  constraint engine_settings_timeout_check check (clef_timeout_ms > 0),
  -- #41 AC-3 do #149: diretoria e bloqueio nunca são aprovados pelo motor.
  constraint engine_settings_delegable_check check (level not in ('diretoria', 'bloqueio') or not delegation_enabled)
);
alter table public.engine_settings enable row level security;

-- #41 Nesta história só o analista (E4 até R$ 20 mil), com a delegação desligada.
insert into public.engine_settings (level, delegation_enabled, confidence_threshold, clef_timeout_ms)
values ('analista', false, 0.98, 3000)
on conflict (level) do nothing;

-- #41 A rodada do Cron conta quantas propostas o motor avaliou.
alter table public.automation_runs
  add column engine_evaluated integer not null default 0;
