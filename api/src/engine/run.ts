// #41 A rodada do motor em modo sombra: avalia as propostas de E4 ainda sem decisão e grava o que faria.
import type { ApprovalStore, CaseFile } from '../approval/store.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { askClef, clefEligible, isCandidate, screen } from './cascade.js';
import type { Clef } from './clef.js';
import type { EngineDecision, EngineRole, EngineSettings } from './decision.js';
import type { EngineStore } from './store.js';

/**
 * #41 Chamadas ao Clef por rodada, da cascata e da medição juntas. O Cron tem um teto de subrequests por
 * invocação e o motor é periférico: o que passar do teto fica para a próxima rodada, sem linha gravada. As
 * novas tentativas do que falhou entram no mesmo teto, depois do que nunca foi avaliado.
 */
export const CLEF_ROUND_LIMIT = 5;

export type ShadowRound = {
  /**
   * #41 Decisões da cascata gravadas nesta rodada, as novas e as refeitas depois de uma falha do Clef; é o
   * `engine_evaluated` de automation_runs.
   */
  readonly evaluated: number;
  /** #41 Medições do Clef (`benchmark`) gravadas nesta rodada, as novas e as refeitas. */
  readonly measured: number;
  /** #41 Linhas `clef_failed` trocadas pela nova tentativa (da cascata ou da medição), já contadas acima. */
  readonly retried: number;
  readonly clefCalls: number;
  readonly clefFailed: number;
  /** #41 Chamadas ao Clef (da cascata ou da medição) que ficaram para a próxima rodada, pelo teto. */
  readonly deferred: number;
  /**
   * #41 A classe do erro ao gravar as novas tentativas ou a medição, depois de a cascata nova já estar gravada;
   * nulo quando tudo foi gravado. A cascata nova segue contada em `evaluated`.
   */
  readonly writeError: string | null;
};

export type ShadowDeps = {
  /** #41 Só a leitura: no modo sombra o motor não aprova nem muda a proposta. */
  readonly approvals: Pick<ApprovalStore, 'listAwaiting'>;
  readonly store: EngineStore;
  readonly clef: Clef;
  readonly clefLimit?: number;
  readonly now?: () => number;
};

/** #41 Uma chamada ao Clef: `retry` quando ela substitui uma linha `clef_failed` da mesma versão. */
type ClefTask = { readonly file: CaseFile; readonly role: EngineRole; readonly retry: boolean };

const errorName = (error: unknown): string => {
  if (error instanceof SupabaseRestError) return `${error.name} HTTP ${error.status}`;
  return error instanceof Error ? error.name : 'Error';
};

/**
 * #41 AC-1, AC-2 e AC-3, com a decisão do dono (regra e Clef lado a lado). Para cada candidata:
 * - sem decisão da cascata: exclusões e regra primeiro; o Clef decide só o que a regra não decide;
 * - elegível (sem exclusão) e ainda sem a versão atual do Clef: o Clef também é avaliado, só para medir
 *   (`benchmark`), quando a regra decidiu ou quando a cascata é de uma versão anterior;
 * - a versão atual do Clef falhou (`clef_failed`, na cascata ou na medição): ele é tentado de novo, e a resposta
 *   substitui a linha da falha. Sem isso a falha (o tempo esgotado é comum) tiraria a proposta da amostra.
 * Até o teto por rodada, nesta ordem: o que nunca foi avaliado (a cascata antes da medição) e, depois, as novas
 * tentativas (também a cascata antes). Grava com `mode = shadow`; não escreve em approvals nem em proposals.
 */
export async function runShadowRound(deps: ShadowDeps): Promise<ShadowRound> {
  const mode = 'shadow';
  const limit = deps.clefLimit ?? CLEF_ROUND_LIMIT;
  const awaiting = (await deps.approvals.listAwaiting()).filter(isCandidate);
  if (awaiting.length === 0) {
    return { evaluated: 0, measured: 0, retried: 0, clefCalls: 0, clefFailed: 0, deferred: 0, writeError: null };
  }
  const seen = await deps.store.evaluated(mode, deps.clef.modelVersion);

  const cascade: EngineDecision[] = [];
  const fresh = { cascade: [] as ClefTask[], benchmark: [] as ClefTask[] };
  const retries = { cascade: [] as ClefTask[], benchmark: [] as ClefTask[] };
  for (const file of awaiting) {
    const key = file.invoice.accessKey;
    const measuredNow = seen.clef.has(key);
    const failedRole = seen.failed.get(key);
    if (!seen.cascade.has(key)) {
      const screened = screen(file, mode);
      if (!screened) {
        if (!measuredNow && failedRole === undefined) fresh.cascade.push({ file, role: 'cascade', retry: false });
        continue;
      }
      cascade.push(screened);
      if (screened.decidedBy === 'rule' && !measuredNow && failedRole === undefined) {
        fresh.benchmark.push({ file, role: 'benchmark', retry: false });
      }
      continue;
    }
    // #41 A cascata em que o Clef falhou volta ao Clef se a proposta de agora ainda é dele (sem exclusão e sem a
    // regra decidir); a resposta substitui a falha na mesma linha da cascata.
    if (failedRole === 'cascade') {
      if (screen(file, mode) === null) retries.cascade.push({ file, role: 'cascade', retry: true });
      continue;
    }
    // #41 AC-3 A exclusão é conferida de novo na proposta de agora: o excluído nunca vai ao Clef, nem para medir.
    if (measuredNow || !clefEligible(file)) continue;
    const task = { file, role: 'benchmark' as const, retry: failedRole === 'benchmark' };
    (task.retry ? retries.benchmark : fresh.benchmark).push(task);
  }

  const answered = { benchmark: [] as EngineDecision[], retryCascade: [] as EngineDecision[], retryBenchmark: [] as EngineDecision[] };
  const settingsByLevel = new Map<string, EngineSettings>();
  let clefCalls = 0;
  let clefFailed = 0;
  let deferred = 0;
  for (const task of [...fresh.cascade, ...fresh.benchmark, ...retries.cascade, ...retries.benchmark]) {
    if (clefCalls >= limit) {
      deferred += 1;
      continue;
    }
    const level = task.file.proposal.level;
    const settings = settingsByLevel.get(level) ?? (await deps.store.settings(level));
    settingsByLevel.set(level, settings);
    clefCalls += 1;
    const decision = await askClef(task.file, { clef: deps.clef, settings, mode, role: task.role, now: deps.now });
    if (decision.pendingReason === 'clef_failed') clefFailed += 1;
    if (task.retry) (task.role === 'cascade' ? answered.retryCascade : answered.retryBenchmark).push(decision);
    else (task.role === 'cascade' ? cascade : answered.benchmark).push(decision);
  }
  // #41 A cascata entra antes da medição: a linha de medição nunca existe sem a da cascata.
  let evaluated = await deps.store.record(cascade);
  let measured = 0;
  let retried = 0;
  let writeError: string | null = null;
  // #41 O que vem depois da cascata nova falha sozinho: a cascata já gravada segue contada na rodada.
  try {
    const cascadeRetried = await deps.store.replaceFailed(answered.retryCascade);
    evaluated += cascadeRetried;
    retried += cascadeRetried;
    measured += await deps.store.record(answered.benchmark);
    const benchmarkRetried = await deps.store.replaceFailed(answered.retryBenchmark);
    measured += benchmarkRetried;
    retried += benchmarkRetried;
  } catch (error) {
    writeError = errorName(error);
  }
  return { evaluated, measured, retried, clefCalls, clefFailed, deferred, writeError };
}
