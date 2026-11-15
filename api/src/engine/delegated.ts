// #42 O motor de decisão em modo delegado (épico #149): com a delegação do analista ligada, aprova sozinho a E4 de
// #42 até R$ 20 mil quando a regra fecha a conta ou o Clef tem a confiança do limite, pelo mesmo caminho da
// #42 aprovação da pessoa. Desligada, a rodada é a do modo sombra (#41), sem mudança nenhuma.
import { AlreadyDecidedError, EngineApprovalRefusedError, type ApprovalStore, type CaseFile } from '../approval/store.js';
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import { approveByEngine } from '../domain/approval.js';
import { DomainError } from '../domain/errors.js';
import { askClef, exclusionOf, isCandidate, screen } from './cascade.js';
import type { EngineDecision, EngineSettings } from './decision.js';
import { CLEF_ROUND_LIMIT, runShadowRound, type ShadowDeps, type ShadowRound } from './run.js';

/** #42 O nível em que o motor aprova nesta história (linha 5 da régua). */
export const DELEGATED_LEVEL = 'analista';

/**
 * #42 Propostas decididas por rodada no modo delegado. Cada uma grava a decisão e, quando aprova, relê a proposta
 * e grava a aprovação pelo caminho da pessoa (perto de uma dezena de subrequests). O Cron tem um teto de
 * subrequests por invocação e o motor é periférico: o que passar do teto fica para a próxima rodada, sem linha.
 */
export const DELEGATED_ROUND_LIMIT = 10;

export type DelegatedRound = {
  /** #42 Decisões da cascata gravadas nesta rodada com `mode = delegated`. */
  readonly evaluated: number;
  /** #42 Propostas que o motor aprovou: a aprovação gravada em approvals. É o `engine_approved` da rodada. */
  readonly approved: number;
  /**
   * #42 Decisões `approve` gravadas que não viraram aprovação porque a pessoa decidiu antes, outra rodada aprovou,
   * a proposta mudou ou a delegação foi desligada no meio: a proposta fica com a pessoa.
   */
  readonly keptWithPerson: number;
  /** #42 AC-2 Pendências por confiança abaixo do limite, com a recomendação do motor. */
  readonly belowConfidence: number;
  readonly clefCalls: number;
  readonly clefFailed: number;
  /** #42 Propostas que ficaram para a próxima rodada, pelo teto de decisões ou de chamadas ao Clef. */
  readonly deferred: number;
  /**
   * #42 Aprovações recusadas por erro de programação (a aprovação não bate com a decisão) ou que falharam ao
   * gravar; e decisões que não foram gravadas. A rodada registra e segue com as outras propostas.
   */
  readonly errors: number;
  /** #42 A classe do primeiro desses erros, para o log; nulo quando não houve. */
  readonly firstError: string | null;
};

export type DelegatedDeps = Omit<ShadowDeps, 'approvals'> & {
  /** #42 A leitura da fila, a releitura da proposta na hora de aprovar e a gravação da aprovação. */
  readonly approvals: Pick<ApprovalStore, 'listAwaiting' | 'find' | 'saveDecision'>;
  /** #42 O dia (AAAA-MM-DD, Brasília) da aprovação, o mesmo `decided_on` da aprovação da pessoa. */
  readonly today: () => string;
  /** #42 Teto de propostas decididas na rodada delegada; padrão `DELEGATED_ROUND_LIMIT`. */
  readonly decisionLimit?: number;
};

/** #42 A rodada do Cron: a sombra com a delegação desligada, a delegada com ela ligada. */
export type EngineRound = ({ readonly mode: 'shadow' } & ShadowRound) | ({ readonly mode: 'delegated' } & DelegatedRound);

const errorName = (error: unknown): string => {
  if (error instanceof SupabaseRestError) return `${error.name} HTTP ${error.status}`;
  return error instanceof Error ? error.name : 'Error';
};

/**
 * #42 AC-5 A delegação liga e desliga por nível no banco (engine_settings), sem deploy, e vale na rodada seguinte.
 * Desligada, roda o modo sombra da #41 exatamente como era: nada em approvals. Ligada, roda o modo delegado.
 *
 * Decisão sobre a medição com a delegação ligada: a rodada delegada não grava medição (`benchmark`) nem a sombra.
 * - A sombra existe para medir o motor antes de ele aprovar (AC-6). Ligada a delegação, a proposta que o motor
 *   aprova não passa mais pela pessoa: não há decisão da pessoa contra a qual medir, e manter a sombra só gastaria
 *   uma segunda chamada ao Clef por proposta no mesmo teto de chamadas (e de subrequests) da rodada.
 * - A medição ao lado da regra (`benchmark`) também fica de fora: com a regra aprovando, o Clef não muda o que
 *   acontece, e a chamada tomaria o lugar de uma proposta que só o Clef decide.
 * O relatório de acerto continua sobre `mode = shadow` (ver `agreementReport`); para medir de novo, desliga-se a
 * delegação e a sombra volta a gravar.
 */
export async function runEngineRound(deps: DelegatedDeps): Promise<EngineRound> {
  const settings = await deps.store.settings(DELEGATED_LEVEL);
  if (!settings.delegationEnabled) return { mode: 'shadow', ...(await runShadowRound(deps)) };
  return { mode: 'delegated', ...(await runDelegatedRound(deps, settings)) };
}

/**
 * #42 AC-2 Aplica o limite à resposta do Clef: abaixo dele a proposta fica com a pessoa (`below_confidence`), com
 * a recomendação do Clef e o porquê. No limite ou acima, a resposta vale como veio: `approve` vira aprovação;
 * `refuse` fica gravado e a proposta segue com a pessoa (o motor nunca recusa sozinho). A regra e a falha do
 * Clef não têm confiança e passam sem mudança.
 */
export function applyThreshold(decision: EngineDecision, threshold: number): EngineDecision {
  if (decision.decidedBy !== 'clef' || decision.confidence === null || decision.outcome === 'pending') return decision;
  if (decision.confidence >= threshold) return decision;
  const recommendation = decision.outcome;
  const verb = recommendation === 'approve' ? 'aprovar' : 'recusar';
  return {
    ...decision,
    outcome: 'pending',
    pendingReason: 'below_confidence',
    recommendation,
    reason: `Confiança ${decision.confidence} abaixo do limite ${threshold}: o motor recomenda ${verb} e deixa com a pessoa. ${decision.reason}`,
  };
}

type Approval = 'approved' | 'person' | { readonly error: string };

/**
 * #42 AC-1 e AC-4 A aprovação do motor, pelo mesmo caminho da pessoa (`approve()` e `saveDecision`): a proposta
 * é relida agora, e só é aprovada se ainda aguarda, sem aprovação gravada e sem cair numa exclusão. A pessoa que
 * decidiu antes (ou a outra rodada) ganha: o motor não decide. A delegação desligada no meio também deixa com a
 * pessoa. O erro de programação (a aprovação não bate com a decisão) é devolvido para a rodada registrar.
 */
async function approveAsEngine(
  deps: DelegatedDeps,
  key: string,
  decision: EngineDecision,
  decisionId: number,
): Promise<Approval> {
  try {
    const current = await deps.approvals.find(key);
    if (!current || !stillAwaiting(current)) return 'person';
    const approval = approveByEngine(
      current.invoice,
      current.proposal,
      current.title,
      deps.today(),
      { decisionId, confidence: decision.confidence, modelVersion: decision.modelVersion },
      { paymentBlocked: current.supplierBlocked },
    );
    await deps.approvals.saveDecision({ ...current, approval });
    return 'approved';
  } catch (error) {
    if (error instanceof AlreadyDecidedError) return 'person';
    if (error instanceof EngineApprovalRefusedError && error.reason === 'delegation_off') return 'person';
    if (error instanceof EngineApprovalRefusedError || !(error instanceof DomainError)) return { error: errorName(error) };
    // #42 A transição que não vale mais (a proposta mudou entre a leitura e a aprovação) fica com a pessoa.
    return 'person';
  }
}

/** #42 A proposta de agora ainda é do motor: aguarda a pessoa, sem aprovação gravada e sem exclusão. */
function stillAwaiting(file: CaseFile): boolean {
  return isCandidate(file) && exclusionOf(file) === null;
}

/**
 * #42 AC-1, AC-2 e AC-3 A rodada delegada. Para cada candidata ainda sem decisão da cascata no modo delegado:
 * - exclusões primeiro (AC-3: diretoria e bloqueio são `level_not_delegable`; o resto fora da E4 até R$ 20 mil do
 *   analista, `outside_criteria`): fica com a pessoa e nunca chega ao Clef;
 * - a regra que fecha a conta aprova (`decided_by = rule`, confiança nula, versão `regra-e4-v1`);
 * - senão, o Clef decide, até o teto de chamadas por rodada: no limite ou acima com `approve`, aprova; abaixo,
 *   `below_confidence` com a recomendação; a falha do Clef fica com a pessoa (`clef_failed`, com a classe do erro
 *   e a latência, como na #41).
 * Até `DELEGATED_ROUND_LIMIT` propostas por rodada; o resto fica para a próxima. A decisão é gravada antes da
 * aprovação, que a cita (o banco confere que batem). A decisão `approve` gravada sem
 * aprovação é a que ficou com a pessoa.
 *
 * A falha do Clef no modo delegado não volta ao Clef: a cascata gravada é uma por proposta e modo, e decisão do
 * dono é que a falha deixa a proposta com a pessoa. O retorno das falhas fica com o modo sombra.
 */
export async function runDelegatedRound(deps: DelegatedDeps, settings: EngineSettings): Promise<DelegatedRound> {
  const mode = 'delegated';
  const limit = deps.clefLimit ?? CLEF_ROUND_LIMIT;
  const decisionLimit = deps.decisionLimit ?? DELEGATED_ROUND_LIMIT;
  let decided = 0;
  let evaluated = 0;
  let approved = 0;
  let keptWithPerson = 0;
  let belowConfidence = 0;
  let clefCalls = 0;
  let clefFailed = 0;
  let deferred = 0;
  let errors = 0;
  let firstError: string | null = null;
  const fail = (name: string) => {
    errors += 1;
    firstError ??= name;
  };

  const awaiting = (await deps.approvals.listAwaiting()).filter(isCandidate);
  if (awaiting.length > 0) {
    const seen = await deps.store.evaluated(mode, deps.clef.modelVersion);
    for (const file of awaiting) {
      const key = file.invoice.accessKey;
      if (seen.cascade.has(key)) continue;
      if (decided >= decisionLimit) {
        deferred += 1;
        continue;
      }
      let decision = screen(file, mode);
      if (!decision) {
        if (clefCalls >= limit) {
          deferred += 1;
          continue;
        }
        clefCalls += 1;
        const answer = await askClef(file, { clef: deps.clef, settings, mode, now: deps.now });
        if (answer.pendingReason === 'clef_failed') clefFailed += 1;
        decision = applyThreshold(answer, settings.confidenceThreshold);
      }
      decided += 1;
      // #42 Cada proposta falha sozinha: o erro ao gravar uma não derruba as outras.
      let decisionId: number | null;
      try {
        decisionId = await deps.store.recordWithId(decision);
      } catch (error) {
        fail(errorName(error));
        continue;
      }
      // #42 Outra rodada gravou a decisão antes: é ela que decide esta proposta.
      if (decisionId === null) continue;
      evaluated += 1;
      if (decision.pendingReason === 'below_confidence') belowConfidence += 1;
      if (decision.outcome !== 'approve') continue;
      const result = await approveAsEngine(deps, key, decision, decisionId);
      if (result === 'approved') approved += 1;
      else if (result === 'person') keptWithPerson += 1;
      else {
        fail(result.error);
        console.error(`#42 motor: aprovação da nota ${key} não gravada (${result.error}); fica com a pessoa`);
      }
    }
  }
  return { evaluated, approved, keptWithPerson, belowConfidence, clefCalls, clefFailed, deferred, errors, firstError };
}
