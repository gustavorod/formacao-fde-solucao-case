-- #41 Regra e Clef lado a lado no modo sombra (decisão do dono). Para toda E4 elegível (analista, até R$ 20 mil,
-- #41 sem exclusão), o Clef também é avaliado quando a regra decide, só para ser medido. A linha da decisão
-- #41 efetiva da cascata (`cascade`) fica separada da avaliação só de medição (`benchmark`); quem decide continua
-- #41 sendo a cascata (AC-2), e as exclusões nunca chegam ao Clef, nem como medição (AC-3).
-- #41 RLS continua ligado e sem política: só a chave secreta (o Worker) lê e grava.

alter table public.engine_decisions
  add column role text not null default 'cascade';

-- #41 Antes das restrições: se a camada 2 já gravou mais de uma linha por proposta e modo (uma versão nova do
-- #41 Clef), a primeira fica como a decisão da cascata e as seguintes, que são do Clef, viram medição.
update public.engine_decisions d
set role = 'benchmark'
where exists (
  select 1
  from public.engine_decisions e
  where e.proposal_id = d.proposal_id
    and e.mode = d.mode
    and e.id < d.id
);

alter table public.engine_decisions
  add constraint engine_decisions_role_check check (role in ('cascade', 'benchmark')),
  -- #41 A medição é só do Clef: ou ele decidiu (com a confiança), ou falhou (`clef_failed`).
  add constraint engine_decisions_benchmark_clef_check check (
    role = 'cascade' or decided_by = 'clef' or pending_reason = 'clef_failed'
  );

-- #41 Uma proposta tem no máximo uma decisão da cascata por modo; a unicidade (proposta, versão, modo) segue
-- #41 valendo para as duas, e deixa o Cron repetir a rodada sem duplicar.
create unique index engine_decisions_cascade_key
  on public.engine_decisions (proposal_id, mode)
  where role = 'cascade';

alter table public.engine_decisions enable row level security;
