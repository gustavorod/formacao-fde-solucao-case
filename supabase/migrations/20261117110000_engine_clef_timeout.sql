-- #42 Motor de decisão em modo delegado (épico #149): o Clef ganha 8 segundos para responder. Com 3 segundos, a
-- #42 resposta que chega um pouco depois vira falha (`clef_failed`) e a proposta fica com a pessoa sem precisar.
-- #42 Migração própria, separada da aprovação pelo motor (20261117100000): é ajuste de configuração, não de
-- #42 esquema, e uma migração já gravada não é reescrita.
-- #42 A delegação continua desligada por padrão; quem liga é a pessoa, no banco, nível a nível.
-- #42 RLS continua ligado e sem política: só a chave secreta (o Worker) lê e grava.

alter table public.engine_settings
  alter column clef_timeout_ms set default 8000;

-- #42 A semente do analista passa de 3000 para 8000. Só muda a linha que ainda tem o valor da semente do #41: um
-- #42 limite que alguém já mudou à mão fica como está (a configuração é do banco, sem deploy).
update public.engine_settings
set clef_timeout_ms = 8000,
    updated_at = now()
where level = 'analista'
  and clef_timeout_ms = 3000;

-- #42 Sem a linha do analista (banco novo sem a semente), ela entra já com 8000 e a delegação desligada.
insert into public.engine_settings (level, delegation_enabled, confidence_threshold, clef_timeout_ms)
values ('analista', false, 0.98, 8000)
on conflict (level) do nothing;

alter table public.engine_settings enable row level security;
