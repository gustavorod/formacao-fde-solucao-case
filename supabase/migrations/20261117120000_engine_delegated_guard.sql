-- #42 Motor de decisão em modo delegado (épico #149): o que o banco garante além da migração 20261117100000.
-- #42 1. Abaixo do limite de confiança, a decisão fica pendente (`below_confidence`) com a recomendação do motor
-- #42    numa coluna própria, e não só no texto do porquê.
-- #42 2. A aprovação pelo motor só entra numa proposta do nível analista e com a delegação do analista ligada.
-- #42 3. A decisão do motor que gerou uma aprovação não muda depois.
-- #42 RLS continua ligado e sem política: só a chave secreta (o Worker) lê e grava.

-- #42 AC-2: o que o motor recomendaria ('approve' ou 'refuse') quando a confiança ficou abaixo do limite.
alter table public.engine_decisions
  add column recommendation text;

alter table public.engine_decisions
  add constraint engine_decisions_recommendation_check check (recommendation in ('approve', 'refuse')),
  -- #42 A recomendação existe só na pendência por confiança baixa, e essa pendência sempre a tem. A confiança
  -- #42 baixa é do Clef: a regra não tem confiança.
  add constraint engine_decisions_below_confidence_check check (
    (pending_reason is not distinct from 'below_confidence') = (recommendation is not null)
    and (pending_reason is distinct from 'below_confidence' or decided_by = 'clef')
  );

-- #42 O gatilho da aprovação pelo motor passa a conferir também a proposta e a configuração, no momento de gravar:
-- #42 - a proposta é do nível analista (AC-3: diretoria e bloqueio nunca, nem coordenação nesta história);
-- #42 - a delegação do analista está ligada (AC-5: desligada, o motor só registra).
-- #42 A decisão é lida com `for share`: ela não muda até a aprovação ser gravada.
create or replace function public.approvals_check_engine_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  d public.engine_decisions%rowtype;
  proposal_level text;
  delegation boolean;
begin
  if new.engine_decision_id is null then
    return new;
  end if;
  select * into d from public.engine_decisions where id = new.engine_decision_id for share;
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
  select p.approval_level into proposal_level from public.proposals p where p.id = new.proposal_id;
  if proposal_level is distinct from 'analista' then
    raise exception 'o motor não aprova proposta do nível %', coalesce(proposal_level, 'desconhecido')
      using errcode = '23514';
  end if;
  select s.delegation_enabled into delegation from public.engine_settings s where s.level = 'analista';
  if delegation is not true then
    raise exception 'delegação do nível analista desligada: o motor não aprova'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.approvals_check_engine_decision() from public, anon, authenticated;

-- #42 A decisão que gerou uma aprovação fica como estava: o que a aprovação copia dela (a proposta, o modo, o papel,
-- #42 o resultado, quem decidiu, a confiança, a versão e a recomendação) não muda depois.
create function public.engine_decisions_keep_approved()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.approvals a where a.engine_decision_id = old.id)
    and (new.proposal_id, new.mode, new.role, new.outcome, new.decided_by, new.confidence, new.model_version,
         new.recommendation)
      is distinct from
        (old.proposal_id, old.mode, old.role, old.outcome, old.decided_by, old.confidence, old.model_version,
         old.recommendation) then
    raise exception 'engine_decision % já gerou uma aprovação e não muda', old.id using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger engine_decisions_keep_approved
  before update of proposal_id, mode, role, outcome, decided_by, confidence, model_version, recommendation
  on public.engine_decisions
  for each row execute function public.engine_decisions_keep_approved();

revoke execute on function public.engine_decisions_keep_approved() from public, anon, authenticated;

alter table public.engine_decisions enable row level security;
alter table public.approvals enable row level security;
