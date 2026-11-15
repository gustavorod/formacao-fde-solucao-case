// #41 AC-4 e AC-5 O motor ao lado da pessoa: o par motor × pessoa por proposta e o relatório de acerto por semana.
// Tudo calculado na leitura, das linhas de engine_decisions e do estado da proposta; nada novo é gravado.
import type { ProposalState } from '../domain/proposal.js';
import type { DecidedBy, EngineMode, EngineOutcome, PendingReason, StoredDecision } from './decision.js';
import type { ProposalOutcomeRow } from './store.js';

/**
 * #41 A decisão da pessoa, na mesma língua do motor. Aprovar e alterar gravam uma linha em `approvals`; o que
 * as separa é o estado da proposta: `aprovada` é a pessoa aprovando a ação proposta (`approve`), `alterada` é a
 * pessoa pedindo outra ação na doca, que é não aprovar a proposta como veio (`refuse`). Ainda aguardando: nulo.
 */
export type PersonOutcome = 'approve' | 'refuse';

export function personOutcome(state: ProposalState): PersonOutcome | null {
  if (state === 'aprovada') return 'approve';
  if (state === 'alterada') return 'refuse';
  return null;
}

/**
 * #41 O par motor × pessoa: concorda quando o motor decidiu o mesmo que a pessoa. Nulo quando a pessoa ainda
 * não decidiu ou quando o motor deixou com a pessoa (`pending`): aí não há o que comparar.
 */
export function agrees(engine: EngineOutcome, person: PersonOutcome | null): boolean | null {
  if (person === null || engine === 'pending') return null;
  return engine === person;
}

/** #41 A medição do Clef de uma proposta: a linha mais recente em que o Clef decidiu (cascata ou medição). */
export function clefMeasure(rows: readonly StoredDecision[]): StoredDecision | null {
  let latest: StoredDecision | null = null;
  for (const r of rows) {
    if (r.decidedBy !== 'clef') continue;
    if (latest === null || Date.parse(r.decidedAt) >= Date.parse(latest.decidedAt)) latest = r;
  }
  return latest;
}

/** #41 AC-4 O campo `engine` da proposta, no contrato do épico #149 (snake_case, como engine_decisions). */
export type EngineView = {
  readonly mode: EngineMode;
  readonly outcome: EngineOutcome;
  readonly decided_by: DecidedBy;
  readonly confidence: number | null;
  readonly model_version: string;
  readonly reason: string;
  readonly pending_reason: PendingReason | null;
  readonly decided_at: string;
  /** #41 A medição do Clef, quando houver: a que o MCP App mostra como "Motor: aprovaria (0,97)". */
  readonly clef: {
    readonly outcome: EngineOutcome;
    readonly confidence: number | null;
    readonly model_version: string;
    readonly reason: string;
    readonly decided_at: string;
    readonly agreement: boolean | null;
  } | null;
  /** #41 A decisão da pessoa, quando já decidiu. */
  readonly person_outcome: PersonOutcome | null;
  /** #41 A decisão efetiva da cascata contra a da pessoa; nulo se a pessoa não decidiu ou o motor deixou com ela. */
  readonly agreement: boolean | null;
};

/** #41 AC-4 Monta o `engine` das linhas da proposta num modo. Sem a decisão da cascata, nulo. */
export function engineView(rows: readonly StoredDecision[], state: ProposalState): EngineView | null {
  const cascade = rows.find((r) => r.role === 'cascade');
  if (!cascade) return null;
  const person = personOutcome(state);
  const clef = clefMeasure(rows);
  return {
    mode: cascade.mode,
    outcome: cascade.outcome,
    decided_by: cascade.decidedBy,
    confidence: cascade.confidence,
    model_version: cascade.modelVersion,
    reason: cascade.reason,
    pending_reason: cascade.pendingReason,
    decided_at: cascade.decidedAt,
    clef:
      clef === null
        ? null
        : {
            outcome: clef.outcome,
            confidence: clef.confidence,
            model_version: clef.modelVersion,
            reason: clef.reason,
            decided_at: clef.decidedAt,
            agreement: agrees(clef.outcome, person),
          },
    person_outcome: person,
    agreement: agrees(cascade.outcome, person),
  };
}

/** #41 AC-5 Uma linha do relatório de acerto, com os campos da #41. */
export type AgreementRow = {
  readonly week: string;
  readonly classification: string;
  readonly evaluated: number;
  /** #41 As exclusões (AC-3) da semana: gravadas pela cascata, fora das contas de acerto. */
  readonly excluded: number;
  readonly decided_by_person: number;
  readonly agreement: number;
  readonly agreement_rate: number | null;
  readonly at_or_above_threshold: number;
  readonly agreement_rate_at_threshold: number | null;
};

/** #41 As classificações do relatório nesta história: só a E4 (E1 e E3 entram com a #46). */
export const REPORT_CLASSIFICATIONS = ['E4'] as const;

const BRASILIA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });

/** #41 O dia (AAAA-MM-DD) de um instante no fuso de Brasília. */
export function brasiliaDay(iso: string): string {
  return BRASILIA.format(new Date(iso));
}

/** #41 A segunda-feira (AAAA-MM-DD) da semana de um dia: as semanas vão de segunda a domingo. */
export function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  return addDays(day, -back);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** #41 As segundas-feiras de `from` até `to`, as duas já segundas. */
export function weeksBetween(from: string, to: string): string[] {
  const weeks: string[] = [];
  for (let w = from; w <= to; w = addDays(w, 7)) weeks.push(w);
  return weeks;
}

/**
 * #41 Os motivos da exclusão (AC-3): a proposta fora da E4 até R$ 20 mil do analista. A cascata grava a linha,
 * mas ela não entra nas contas de acerto, que são só das propostas que o motor avaliou de fato.
 */
const EXCLUSIONS: ReadonlySet<PendingReason> = new Set<PendingReason>(['outside_criteria', 'level_not_delegable']);

/** #41 A proposta que caiu numa exclusão da cascata. */
export function isExcluded(cascade: StoredDecision): boolean {
  return cascade.pendingReason !== null && EXCLUSIONS.has(cascade.pendingReason);
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/**
 * #41 AC-5 O relatório de acerto: uma linha por semana pedida e por classificação (só a E4), mesmo vazia.
 *
 * Sobre quais linhas cada número é calculado:
 * - A proposta entra na semana (de segunda a domingo, no fuso de Brasília) em que o motor gravou a decisão da
 *   cascata (`role = cascade`, `decided_at`), com a classificação da proposta.
 * - `excluded`: as propostas da semana que caíram numa exclusão da cascata (`outside_criteria` ou
 *   `level_not_delegable`). Elas ficam só nesse campo: nenhum dos números abaixo as conta.
 * - `evaluated`: as propostas elegíveis (a E4 até R$ 20 mil do analista, sem exclusão) com a decisão da cascata na
 *   semana, inclusive as que ficaram com a pessoa porque o Clef falhou.
 * - `decided_by_person`: delas, as que a pessoa já decidiu (proposta `aprovada` ou `alterada`).
 * - `agreement`: delas, as em que a decisão efetiva da cascata é a mesma da pessoa; `pending` nunca conta como
 *   acerto, porque o motor não disse o que faria. `agreement_rate = agreement / decided_by_person`.
 * - `at_or_above_threshold`: das avaliadas, as que têm a medição do Clef (a linha mais recente com
 *   `decided_by = clef`, da cascata ou da medição) com confiança igual ou acima de `threshold`, o
 *   `engine_settings.confidence_threshold` do analista.
 * - `agreement_rate_at_threshold`: só nessas e já decididas pela pessoa, a parte em que o Clef decidiu o mesmo
 *   que a pessoa. É o número que decide ligar a delegação, que é do Clef.
 * Divisão por zero dá nulo.
 */
export function agreementReport(input: {
  readonly weeks: readonly string[];
  readonly threshold: number;
  readonly decisions: readonly StoredDecision[];
  readonly proposals: readonly ProposalOutcomeRow[];
}): AgreementRow[] {
  const proposals = new Map(input.proposals.map((p) => [p.invoiceAccessKey, p]));
  const rowsByKey = new Map<string, StoredDecision[]>();
  for (const d of input.decisions) {
    const rows = rowsByKey.get(d.invoiceAccessKey);
    if (rows) rows.push(d);
    else rowsByKey.set(d.invoiceAccessKey, [d]);
  }

  type Tally = { evaluated: number; excluded: number; decided: number; agreement: number; atThreshold: number; decidedAt: number; agreementAt: number };
  const empty = (): Tally => ({ evaluated: 0, excluded: 0, decided: 0, agreement: 0, atThreshold: 0, decidedAt: 0, agreementAt: 0 });
  const tallies = new Map<string, Tally>();
  const keyOf = (week: string, classification: string) => `${week}|${classification}`;
  for (const week of input.weeks) for (const c of REPORT_CLASSIFICATIONS) tallies.set(keyOf(week, c), empty());

  for (const [key, rows] of rowsByKey) {
    const cascade = rows.find((r) => r.role === 'cascade');
    const proposal = proposals.get(key);
    if (!cascade || !proposal) continue;
    const tally = tallies.get(keyOf(mondayOf(brasiliaDay(cascade.decidedAt)), proposal.classification));
    if (!tally) continue;
    if (isExcluded(cascade)) {
      tally.excluded += 1;
      continue;
    }
    const person = personOutcome(proposal.state);
    const clef = clefMeasure(rows);
    const atThreshold = clef !== null && clef.confidence !== null && clef.confidence >= input.threshold;
    tally.evaluated += 1;
    if (atThreshold) tally.atThreshold += 1;
    if (person === null) continue;
    tally.decided += 1;
    if (agrees(cascade.outcome, person) === true) tally.agreement += 1;
    if (atThreshold && clef) {
      tally.decidedAt += 1;
      if (agrees(clef.outcome, person) === true) tally.agreementAt += 1;
    }
  }

  return input.weeks.flatMap((week) =>
    REPORT_CLASSIFICATIONS.map((classification) => {
      const t = tallies.get(keyOf(week, classification)) ?? empty();
      return {
        week,
        classification,
        evaluated: t.evaluated,
        excluded: t.excluded,
        decided_by_person: t.decided,
        agreement: t.agreement,
        agreement_rate: ratio(t.agreement, t.decided),
        at_or_above_threshold: t.atThreshold,
        agreement_rate_at_threshold: ratio(t.agreementAt, t.decidedAt),
      };
    }),
  );
}
