// #211 AC-1 Cada rodada do Cron fica em automation_runs: só números e a classe do erro, nada sensível.
import { isInteger, isString, nullable, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';

const TABLE = 'automation_runs';

/** #211 O que a rodada fez. Os nomes seguem o log do `tick`. */
export type RunFigures = {
  seen: number;
  inserted: number;
  checked: number;
  failed: number;
  proposed: number;
  approvedByRule: number;
  cadastroE8: number;
  dockPublished: number;
  storePublished: number;
  duplicatesBlocked: number;
  /** #41 Propostas que o motor de decisão avaliou na rodada (modo sombra). */
  engineEvaluated: number;
};

export const NO_FIGURES: RunFigures = {
  seen: 0, inserted: 0, checked: 0, failed: 0, proposed: 0, approvedByRule: 0,
  cadastroE8: 0, dockPublished: 0, storePublished: 0, duplicatesBlocked: 0, engineEvaluated: 0,
};

export type RunStatus = 'ok' | 'failed';

export type AutomationRun = {
  id: number;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  figures: RunFigures;
  /** #211 A classe do erro (ex.: `SupabaseRestError`), nunca a mensagem. */
  error: string | null;
};

type Row = {
  id: number; started_at: string; finished_at: string; status: RunStatus;
  seen: number; inserted: number; checked: number; failed: number; proposed: number;
  approved_by_rule: number; cadastro_e8: number; dock_published: number; store_published: number;
  duplicates_blocked: number; engine_evaluated: number; error: string | null;
};

const isRow = shaped<Row>({
  id: isInteger, started_at: isString, finished_at: isString, status: oneOf('ok', 'failed'),
  seen: isInteger, inserted: isInteger, checked: isInteger, failed: isInteger, proposed: isInteger,
  approved_by_rule: isInteger, cadastro_e8: isInteger, dock_published: isInteger, store_published: isInteger,
  duplicates_blocked: isInteger, engine_evaluated: isInteger, error: nullable(isString),
} satisfies Shape<Row>);

/** #211 Grava a rodada. Quem chama não deixa a falha daqui derrubar o Cron. */
export async function recordRun(
  rest: SupabaseRest,
  run: { startedAt: Date; finishedAt: Date; status: RunStatus; figures: RunFigures; error?: string | null },
): Promise<void> {
  const f = run.figures;
  await rest.insert(TABLE, [
    {
      started_at: run.startedAt.toISOString(),
      finished_at: run.finishedAt.toISOString(),
      status: run.status,
      seen: f.seen, inserted: f.inserted, checked: f.checked, failed: f.failed, proposed: f.proposed,
      approved_by_rule: f.approvedByRule, cadastro_e8: f.cadastroE8, dock_published: f.dockPublished,
      store_published: f.storePublished, duplicates_blocked: f.duplicatesBlocked,
      engine_evaluated: f.engineEvaluated,
      error: run.error ?? null,
    },
  ]);
}

/** #211 As últimas rodadas, da mais nova para a mais velha. */
export async function listRuns(rest: SupabaseRest, limit: number): Promise<AutomationRun[]> {
  const rows = parseRows(await rest.select(TABLE, { order: 'started_at.desc', limit }), isRow, TABLE);
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    error: r.error,
    figures: {
      seen: r.seen, inserted: r.inserted, checked: r.checked, failed: r.failed, proposed: r.proposed,
      approvedByRule: r.approved_by_rule, cadastroE8: r.cadastro_e8, dockPublished: r.dock_published,
      storePublished: r.store_published, duplicatesBlocked: r.duplicates_blocked,
      engineEvaluated: r.engine_evaluated,
    },
  }));
}
