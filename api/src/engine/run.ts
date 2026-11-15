// #41 A rodada do motor em modo sombra: avalia as propostas de E4 ainda sem decisão e grava o que faria.
import type { ApprovalStore } from '../approval/store.js';
import { askClef, isCandidate, screen } from './cascade.js';
import type { Clef } from './clef.js';
import { RULE_VERSION, type EngineDecision, type EngineSettings } from './decision.js';
import type { EngineStore } from './store.js';

/**
 * #41 Chamadas ao Clef por rodada. O Cron tem um teto de subrequests por invocação e o motor é periférico:
 * o que passar do teto fica para a próxima rodada, sem decisão gravada.
 */
export const CLEF_ROUND_LIMIT = 5;

export type ShadowRound = {
  /** #41 Decisões novas gravadas nesta rodada; é o `engine_evaluated` de automation_runs. */
  readonly evaluated: number;
  readonly clefCalls: number;
  readonly clefFailed: number;
  /** #41 Candidatas que pediam o Clef e ficaram para a próxima rodada, pelo teto. */
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

/**
 * #41 AC-1, AC-2 e AC-3 Para cada candidata ainda sem decisão nesta versão: exclusões e regra primeiro; o Clef
 * só no resto, até o teto. Grava tudo de uma vez com `mode = shadow`. Não escreve em approvals nem em proposals.
 */
export async function runShadowRound(deps: ShadowDeps): Promise<ShadowRound> {
  const mode = 'shadow';
  const limit = deps.clefLimit ?? CLEF_ROUND_LIMIT;
  const awaiting = (await deps.approvals.listAwaiting()).filter(isCandidate);
  if (awaiting.length === 0) return { evaluated: 0, clefCalls: 0, clefFailed: 0, deferred: 0 };
  const decided = await deps.store.decidedKeys(mode, [RULE_VERSION, deps.clef.modelVersion]);
  const pending = awaiting.filter((f) => !decided.has(f.invoice.accessKey));

  const decisions: EngineDecision[] = [];
  const settingsByLevel = new Map<string, EngineSettings>();
  let clefCalls = 0;
  let clefFailed = 0;
  let deferred = 0;
  for (const file of pending) {
    const screened = screen(file, mode);
    if (screened) {
      decisions.push(screened);
      continue;
    }
    if (clefCalls >= limit) {
      deferred += 1;
      continue;
    }
    const level = file.proposal.level;
    const settings = settingsByLevel.get(level) ?? (await deps.store.settings(level));
    settingsByLevel.set(level, settings);
    clefCalls += 1;
    const decision = await askClef(file, { clef: deps.clef, settings, mode, now: deps.now });
    if (decision.pendingReason === 'clef_failed') clefFailed += 1;
    decisions.push(decision);
  }
  const evaluated = await deps.store.record(decisions);
  return { evaluated, clefCalls, clefFailed, deferred };
}
