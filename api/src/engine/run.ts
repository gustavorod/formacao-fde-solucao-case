// #41 A rodada do motor em modo sombra: avalia as propostas de E4 ainda sem decisão e grava o que faria.
import type { ApprovalStore, CaseFile } from '../approval/store.js';
import { askClef, clefEligible, isCandidate, screen } from './cascade.js';
import type { Clef } from './clef.js';
import type { EngineDecision, EngineRole, EngineSettings } from './decision.js';
import type { EngineStore } from './store.js';

/**
 * #41 Chamadas ao Clef por rodada, da cascata e da medição juntas. O Cron tem um teto de subrequests por
 * invocação e o motor é periférico: o que passar do teto fica para a próxima rodada, sem linha gravada.
 */
export const CLEF_ROUND_LIMIT = 5;

export type ShadowRound = {
  /** #41 Decisões novas da cascata gravadas nesta rodada; é o `engine_evaluated` de automation_runs. */
  readonly evaluated: number;
  /** #41 Medições novas do Clef (`benchmark`) gravadas nesta rodada. */
  readonly measured: number;
  readonly clefCalls: number;
  readonly clefFailed: number;
  /** #41 Chamadas ao Clef (da cascata ou da medição) que ficaram para a próxima rodada, pelo teto. */
  readonly deferred: number;
};

export type ShadowDeps = {
  /** #41 Só a leitura: no modo sombra o motor não aprova nem muda a proposta. */
  readonly approvals: Pick<ApprovalStore, 'listAwaiting'>;
  readonly store: EngineStore;
  readonly clef: Clef;
  readonly clefLimit?: number;
  readonly now?: () => number;
};

type ClefTask = { readonly file: CaseFile; readonly role: EngineRole };

/**
 * #41 AC-1, AC-2 e AC-3, com a decisão do dono (regra e Clef lado a lado). Para cada candidata:
 * - sem decisão da cascata: exclusões e regra primeiro; o Clef decide só o que a regra não decide;
 * - elegível (sem exclusão) e ainda sem a versão atual do Clef: o Clef também é avaliado, só para medir
 *   (`benchmark`), quando a regra decidiu ou quando a cascata é de uma versão anterior.
 * As chamadas da cascata vêm antes das de medição, até o teto. Grava com `mode = shadow`; não escreve em
 * approvals nem em proposals.
 */
export async function runShadowRound(deps: ShadowDeps): Promise<ShadowRound> {
  const mode = 'shadow';
  const limit = deps.clefLimit ?? CLEF_ROUND_LIMIT;
  const awaiting = (await deps.approvals.listAwaiting()).filter(isCandidate);
  if (awaiting.length === 0) return { evaluated: 0, measured: 0, clefCalls: 0, clefFailed: 0, deferred: 0 };
  const seen = await deps.store.evaluated(mode, deps.clef.modelVersion);

  const cascade: EngineDecision[] = [];
  const cascadeTasks: ClefTask[] = [];
  const benchmarkTasks: ClefTask[] = [];
  for (const file of awaiting) {
    const key = file.invoice.accessKey;
    const measuredNow = seen.clef.has(key);
    if (!seen.cascade.has(key)) {
      const screened = screen(file, mode);
      if (!screened) {
        if (!measuredNow) cascadeTasks.push({ file, role: 'cascade' });
        continue;
      }
      cascade.push(screened);
      if (screened.decidedBy === 'rule' && !measuredNow) benchmarkTasks.push({ file, role: 'benchmark' });
      continue;
    }
    // #41 AC-3 A exclusão é conferida de novo na proposta de agora: o excluído nunca vai ao Clef, nem para medir.
    if (!measuredNow && clefEligible(file)) benchmarkTasks.push({ file, role: 'benchmark' });
  }

  const benchmark: EngineDecision[] = [];
  const settingsByLevel = new Map<string, EngineSettings>();
  let clefCalls = 0;
  let clefFailed = 0;
  let deferred = 0;
  for (const task of [...cascadeTasks, ...benchmarkTasks]) {
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
    (task.role === 'cascade' ? cascade : benchmark).push(decision);
  }
  // #41 A cascata entra antes da medição: a linha de medição nunca existe sem a da cascata.
  const evaluated = await deps.store.record(cascade);
  const measured = await deps.store.record(benchmark);
  return { evaluated, measured, clefCalls, clefFailed, deferred };
}
