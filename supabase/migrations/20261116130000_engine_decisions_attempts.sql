-- #41 As novas tentativas do Clef têm teto e ordem. `attempts` conta as vezes que a linha foi avaliada, contando a
-- #41 primeira; numa linha `clef_failed`, ao chegar ao teto da rodada (3), a falha fica definitiva e não volta ao
-- #41 Clef. `last_attempt_at` é a hora da última tentativa: a rodada tenta de novo a falha mais antiga primeiro.
-- #41 A nova tentativa que falha de novo só muda estas duas colunas, o erro e a latência: `decided_at` fica o da
-- #41 primeira falha, e a proposta não muda de semana no relatório de acerto.
-- #41 RLS continua ligado e sem política: só a chave secreta (o Worker) lê e grava.

alter table public.engine_decisions
  add column attempts integer not null default 1,
  add column last_attempt_at timestamptz;

-- #41 As linhas que já existem: uma tentativa, na hora em que foram gravadas.
update public.engine_decisions
set last_attempt_at = decided_at
where last_attempt_at is null;

alter table public.engine_decisions
  alter column last_attempt_at set default now(),
  alter column last_attempt_at set not null,
  add constraint engine_decisions_attempts_check check (attempts >= 1);
