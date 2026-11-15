-- #42 Motor de decisão em modo delegado (épico #149): com `engine_settings.delegation_enabled` ligado para o
-- #42 analista, o motor aprova sozinho a unidade de medida (E4) até R$ 20 mil. A aprovação fica na mesma tabela
-- #42 das aprovações de pessoa e de regra, com o motor como aprovador, a confiança (nula quando quem decidiu
-- #42 dentro da cascata foi a regra) e a versão do modelo (a do Clef, ou `regra-e4-v1`), e o título segue para a
-- #42 lista do dia como numa aprovação de pessoa. Diretoria e bloqueio nunca são aprovados pelo motor.
-- #42 RLS continua ligado e sem política: só a chave secreta (o Worker) lê e grava.

-- #42 O vínculo com a decisão do motor que gerou a aprovação, e a confiança e a versão dela.
alter table public.approvals
  add column engine_decision_id bigint,
  add column engine_confidence numeric,
  add column engine_model_version text;

-- #42 Quem aprovou, de forma explícita: 'rule' (o nível regra, ADR-002), 'engine' (o motor, modo delegado) ou
-- #42 'person'. Gerada a partir das colunas, nunca diverge delas, vale para as linhas que já existem e não
-- #42 muda o que o Worker grava hoje para a regra e para a pessoa.
alter table public.approvals
  add column approved_by text not null generated always as (
    case
      when engine_decision_id is not null then 'engine'
      when approver_level = 'regra' then 'rule'
      else 'person'
    end
  ) stored;

alter table public.approvals
  add constraint approvals_engine_decision_fkey
    foreign key (engine_decision_id) references public.engine_decisions (id),
  -- #42 Uma decisão do motor gera no máximo uma aprovação.
  add constraint approvals_engine_decision_key unique (engine_decision_id),
  -- #42 Confiança e versão do modelo só existem na aprovação do motor; a versão é obrigatória nela.
  add constraint approvals_engine_fields_check check (
    (engine_decision_id is null and engine_confidence is null and engine_model_version is null)
    or (engine_decision_id is not null and engine_model_version is not null)
  ),
  add constraint approvals_engine_model_version_check check (
    engine_model_version is null or length(btrim(engine_model_version)) > 0
  ),
  add constraint approvals_engine_confidence_range_check check (
    engine_confidence is null or (engine_confidence >= 0 and engine_confidence <= 1)
  ),
  -- #42 O aprovador do motor é sempre 'motor', e só o motor usa esse nome.
  add constraint approvals_engine_approver_check check ((engine_decision_id is not null) = (approver = 'motor')),
  -- #42 Nesta história o motor só aprova no nível analista (E4 até R$ 20 mil); nunca regra, coordenação,
  -- #42 diretoria ou bloqueio. Ampliar o nível pede uma migração nova.
  add constraint approvals_engine_level_check check (engine_decision_id is null or approver_level = 'analista');

-- #42 A aprovação do motor precisa bater com a decisão que a gerou: a mesma proposta, a decisão efetiva da
-- #42 cascata (`cascade`) no modo delegado com o resultado `approve`, e a mesma confiança e versão do modelo.
-- #42 Uma restrição de linha não enxerga a outra tabela; o gatilho confere antes de gravar.
create function public.approvals_check_engine_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  d public.engine_decisions%rowtype;
begin
  if new.engine_decision_id is null then
    return new;
  end if;
  select * into d from public.engine_decisions where id = new.engine_decision_id;
  if not found then
    raise exception 'engine_decision % não existe', new.engine_decision_id using errcode = '23503';
  end if;
  if d.proposal_id <> new.proposal_id
    or d.mode <> 'delegated'
    or d.role <> 'cascade'
    or d.outcome <> 'approve'
    or d.model_version <> new.engine_model_version
    or d.confidence is distinct from new.engine_confidence then
    raise exception 'aprovação do motor não bate com a engine_decision %', new.engine_decision_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger approvals_check_engine_decision
  before insert or update of proposal_id, engine_decision_id, engine_confidence, engine_model_version
  on public.approvals
  for each row execute function public.approvals_check_engine_decision();

-- #42 A função é do gatilho; ninguém de fora a chama.
revoke execute on function public.approvals_check_engine_decision() from public, anon, authenticated;

-- #42 O relatório separa as aprovações por quem aprovou.
create index approvals_approved_by_idx on public.approvals (approved_by, approved_at);

alter table public.approvals enable row level security;

-- #42 A rodada do Cron conta quantas propostas o motor aprovou.
alter table public.automation_runs
  add column engine_approved integer not null default 0,
  add constraint automation_runs_engine_approved_check check (engine_approved >= 0);
