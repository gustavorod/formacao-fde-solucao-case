// #41 A rodada do motor em modo sombra: avalia as propostas de E4 ainda sem decisão e grava o que faria.
import type { ApprovalStore, CaseFile } from '../approval/store.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { askClef, clefEligible, isCandidate, screen } from './cascade.js';
import type { Clef } from './clef.js';
import type { EngineDecision, EngineRole, EngineSettings } from './decision.js';
import { CLEF_MAX_ATTEMPTS, type EngineStore, type FailedAttempt, type Retry } from './store.js';

/**
 * #41 Chamadas ao Clef por rodada, da cascata e da medição juntas. O Cron tem um teto de subrequests por
 * invocação e o motor é periférico: o que passar do teto fica para a próxima rodada, sem linha gravada. As
 * novas tentativas do que falhou entram no mesmo teto, depois do que nunca foi avaliado, a falha mais antiga
 * primeiro, e cada linha tem no máximo `CLEF_MAX_ATTEMPTS` tentativas.
 */
export const CLEF_ROUND_LIMIT = 5;

export type ShadowRound = {
  /**
   * #41 Decisões da cascata gravadas nesta rodada, as novas e as que o Clef respondeu numa nova tentativa; é o
   * `engine_evaluated` de automation_runs. A nova tentativa que falhou de novo não é decisão nova e não conta.
   */
  readonly evaluated: number;
  /** #41 Medições do Clef (`benchmark`) gravadas nesta rodada, as novas e as respondidas numa nova tentativa. */
  readonly measured: number;
  /** #41 Linhas `clef_failed` trocadas pela resposta da nova tentativa (da cascata ou da medição), já contadas acima. */
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

/** #41 Uma chamada ao Clef: `previous` é a linha `clef_failed` da mesma versão que ela tenta de novo. */
type ClefTask = { readonly file: CaseFile; readonly role: EngineRole; readonly previous?: FailedAttempt };

/** #41 A falha que ainda pode voltar ao Clef: abaixo do teto de tentativas. */
const retryable = (failed: FailedAttempt | undefined): failed is FailedAttempt =>
  failed !== undefined && failed.attempts < CLEF_MAX_ATTEMPTS;

const errorName = (error: unknown): string => {
  if (error instanceof SupabaseRestError) return `${error.name} HTTP ${error.status}`;
  return error instanceof Error ? error.name : 'Error';
};

/**
 * #41 AC-1, AC-2 e AC-3, com a decisão do dono (regra e Clef lado a lado). Para cada candidata:
 * - sem decisão da cascata: exclusões e regra primeiro; o Clef decide só o que a regra não decide;
 * - elegível (sem exclusão) e ainda sem a versão atual do Clef: o Clef também é avaliado, só para medir
 *   (`benchmark`), quando a regra decidiu ou quando a cascata é de uma versão anterior;
 * - a versão atual do Clef falhou (`clef_failed`, na cascata ou na medição): ele é tentado de novo, até
 *   `CLEF_MAX_ATTEMPTS` tentativas na linha. A resposta substitui a linha da falha; a nova falha só soma a
 *   tentativa (com o erro e a latência), sem mover `decided_at` nem contar como avaliada. Sem isso a falha (o tempo
 *   esgotado é comum) tiraria a proposta da amostra; com o teto, o Clef fora do ar não é chamado sem fim.
 * - a cascata que falhou e cuja proposta de agora cai numa exclusão ou na regra não volta ao Clef: segue
 *   `clef_failed` (a cascata gravada é uma por proposta e modo, e a resposta trocaria quem decide).
 * Até o teto por rodada, nesta ordem: o que nunca foi avaliado (a cascata antes da medição) e, depois, as novas
 * tentativas, a da última tentativa mais antiga primeiro: assim uma falha que persiste não toma o lugar das
 * outras. Grava com `mode = shadow`; não escreve em approvals nem em proposals.
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
  const retries: ClefTask[] = [];
  for (const file of awaiting) {
    const key = file.invoice.accessKey;
    const measuredNow = seen.clef.has(key);
    const failed = seen.failed.get(key);
    if (!seen.cascade.has(key)) {
      const screened = screen(file, mode);
      if (!screened) {
        if (!measuredNow && failed === undefined) fresh.cascade.push({ file, role: 'cascade' });
        continue;
      }
      cascade.push(screened);
      if (screened.decidedBy === 'rule' && !measuredNow && failed === undefined) {
        fresh.benchmark.push({ file, role: 'benchmark' });
      }
      continue;
    }
    // #41 A cascata em que o Clef falhou volta ao Clef se a proposta de agora ainda é dele (sem exclusão e sem a
    // regra decidir); a resposta substitui a falha na mesma linha da cascata.
    if (failed?.role === 'cascade') {
      if (retryable(failed) && screen(file, mode) === null) retries.push({ file, role: 'cascade', previous: failed });
      continue;
    }
    // #41 AC-3 A exclusão é conferida de novo na proposta de agora: o excluído nunca vai ao Clef, nem para medir.
    if (measuredNow || !clefEligible(file)) continue;
    if (failed === undefined) fresh.benchmark.push({ file, role: 'benchmark' });
    else if (retryable(failed)) retries.push({ file, role: 'benchmark', previous: failed });
  }
  // #41 A falha tentada há mais tempo primeiro (no empate, a cascata): a 6ª falha não espera as 5 primeiras saírem.
  const lastAttempt = (t: ClefTask) => Date.parse(t.previous?.lastAttemptAt ?? '');
  retries.sort((a, b) => lastAttempt(a) - lastAttempt(b) || (a.role === b.role ? 0 : a.role === 'cascade' ? -1 : 1));

  const benchmark: EngineDecision[] = [];
  const answered = { cascade: [] as Retry[], benchmark: [] as Retry[] };
  const failedAgain: Retry[] = [];
  const settingsByLevel = new Map<string, EngineSettings>();
  let clefCalls = 0;
  let clefFailed = 0;
  let deferred = 0;
  for (const task of [...fresh.cascade, ...fresh.benchmark, ...retries]) {
    if (clefCalls >= limit) {
      deferred += 1;
      continue;
    }
    const level = task.file.proposal.level;
    const settings = settingsByLevel.get(level) ?? (await deps.store.settings(level));
    settingsByLevel.set(level, settings);
    clefCalls += 1;
    const decision = await askClef(task.file, { clef: deps.clef, settings, mode, role: task.role, now: deps.now });
    const failedNow = decision.pendingReason === 'clef_failed';
    if (failedNow) clefFailed += 1;
    if (task.previous) {
      const retry = { decision, attempts: task.previous.attempts };
      if (failedNow) failedAgain.push(retry);
      else answered[task.role].push(retry);
    } else (task.role === 'cascade' ? cascade : benchmark).push(decision);
  }
  // #41 A cascata entra antes da medição: a linha de medição nunca existe sem a da cascata.
  let evaluated = await deps.store.record(cascade);
  let measured = 0;
  let retried = 0;
  let writeError: string | null = null;
  // #41 O que vem depois da cascata nova falha sozinho: a cascata já gravada segue contada na rodada.
  try {
    const cascadeRetried = await deps.store.replaceFailed(answered.cascade);
    evaluated += cascadeRetried;
    retried += cascadeRetried;
    measured += await deps.store.record(benchmark);
    const benchmarkRetried = await deps.store.replaceFailed(answered.benchmark);
    measured += benchmarkRetried;
    retried += benchmarkRetried;
    // #41 A falha repetida só soma a tentativa: não é decisão nova, não entra em evaluated nem em measured.
    await deps.store.noteFailedAttempt(failedAgain);
  } catch (error) {
    writeError = errorName(error);
  }
  return { evaluated, measured, retried, clefCalls, clefFailed, deferred, writeError };
}
