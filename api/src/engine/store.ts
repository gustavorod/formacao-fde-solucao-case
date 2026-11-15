// #41 O que o motor lê e grava: a configuração por nível (engine_settings) e as decisões (engine_decisions).
import type { ProposalState } from '../domain/proposal.js';
import {
  DEFAULT_ANALYST_SETTINGS,
  type EngineDecision,
  type EngineMode,
  type EngineRole,
  type EngineSettings,
  type StoredDecision,
} from './decision.js';

/**
 * #41 O que já foi avaliado num modo: as notas com a decisão da cascata, as que já têm a versão atual do Clef e
 * as em que a versão atual do Clef falhou e ainda pode ser tentada de novo.
 */
export type Evaluated = {
  /** #41 Notas que já têm a decisão efetiva da cascata (`role = cascade`), em qualquer versão. */
  readonly cascade: ReadonlySet<string>;
  /** #41 Notas com uma resposta da versão atual do Clef, da cascata ou da medição; a falha não conta. */
  readonly clef: ReadonlySet<string>;
  /** #41 Notas cuja linha da versão atual do Clef é `clef_failed`, com o papel dessa linha. */
  readonly failed: ReadonlyMap<string, EngineRole>;
};

/** #41 A linha que só registra a falha do Clef: a única que uma nova tentativa pode substituir. */
export const isClefFailure = (d: Pick<EngineDecision, 'pendingReason'>): boolean => d.pendingReason === 'clef_failed';

/** #41 A proposta como o relatório a lê: a classificação e o estado (a decisão da pessoa). */
export type ProposalOutcomeRow = {
  readonly invoiceAccessKey: string;
  readonly classification: string;
  readonly state: ProposalState;
};

export interface EngineStore {
  /** #41 A configuração do nível; sem linha, os padrões da migração. */
  settings(level: string): Promise<EngineSettings>;
  /** #41 O que já foi avaliado neste modo, para a rodada não reavaliar (idempotência). */
  evaluated(mode: EngineMode, clefVersion: string): Promise<Evaluated>;
  /**
   * #41 Grava as decisões e devolve quantas entraram. Idempotente: a decisão que já existe para a mesma
   * proposta, versão e modo é ignorada (a unicidade de engine_decisions).
   */
  record(decisions: readonly EngineDecision[]): Promise<number>;
  /**
   * #41 Grava a nova tentativa do Clef por cima da linha `clef_failed` da mesma proposta, versão, modo e papel, e
   * devolve quantas trocou. Só a linha de falha é trocada: a resposta que já deu certo nunca é sobrescrita.
   */
  replaceFailed(decisions: readonly EngineDecision[]): Promise<number>;
}

/** #41 AC-4 e AC-5 O que a API lê do motor: as decisões de uma nota e as de um período, e as propostas. */
export interface EngineReader {
  settings(level: string): Promise<EngineSettings>;
  /** #41 AC-4 Todas as linhas do motor da nota neste modo (cascata e medição). */
  forProposal(invoiceAccessKey: string, mode: EngineMode): Promise<StoredDecision[]>;
  /** #41 AC-5 As linhas do modo gravadas de `fromIso` (incluído) até `toIso` (excluído), cascata e medição. */
  between(mode: EngineMode, fromIso: string, toIso: string): Promise<StoredDecision[]>;
  /** #41 AC-5 A classificação e o estado das propostas destas notas. */
  proposals(invoiceAccessKeys: readonly string[]): Promise<ProposalOutcomeRow[]>;
}

/** #41 Loja em memória: a dos testes. */
export class MemoryEngineStore implements EngineStore, EngineReader {
  readonly decisions: StoredDecision[] = [];
  private readonly levels = new Map<string, EngineSettings>();
  private readonly proposalRows = new Map<string, ProposalOutcomeRow>();

  constructor(
    settings: readonly EngineSettings[] = [DEFAULT_ANALYST_SETTINGS],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const s of settings) this.levels.set(s.level, s);
  }

  /** #41 Para os testes do relatório: a classificação e o estado de uma proposta. */
  setProposal(row: ProposalOutcomeRow): void {
    this.proposalRows.set(row.invoiceAccessKey, row);
  }

  async settings(level: string): Promise<EngineSettings> {
    return this.levels.get(level) ?? { ...DEFAULT_ANALYST_SETTINGS, level };
  }

  async evaluated(mode: EngineMode, clefVersion: string): Promise<Evaluated> {
    const inMode = this.decisions.filter((d) => d.mode === mode);
    const current = inMode.filter((d) => d.modelVersion === clefVersion);
    return {
      cascade: new Set(inMode.filter((d) => d.role === 'cascade').map((d) => d.invoiceAccessKey)),
      clef: new Set(current.filter((d) => !isClefFailure(d)).map((d) => d.invoiceAccessKey)),
      failed: new Map(current.filter(isClefFailure).map((d) => [d.invoiceAccessKey, d.role])),
    };
  }

  /** #41 As duas unicidades do banco: (proposta, versão, modo) e uma cascata por proposta e modo. */
  async record(decisions: readonly EngineDecision[]): Promise<number> {
    let inserted = 0;
    for (const d of decisions) {
      const exists = this.decisions.some(
        (x) =>
          x.invoiceAccessKey === d.invoiceAccessKey &&
          x.mode === d.mode &&
          (x.modelVersion === d.modelVersion || (x.role === 'cascade' && d.role === 'cascade')),
      );
      if (exists) continue;
      this.decisions.push({ ...d, decidedAt: this.now().toISOString() });
      inserted += 1;
    }
    return inserted;
  }

  async replaceFailed(decisions: readonly EngineDecision[]): Promise<number> {
    let replaced = 0;
    for (const d of decisions) {
      const i = this.decisions.findIndex(
        (x) =>
          x.invoiceAccessKey === d.invoiceAccessKey &&
          x.mode === d.mode &&
          x.modelVersion === d.modelVersion &&
          x.role === d.role &&
          isClefFailure(x),
      );
      if (i < 0) continue;
      this.decisions[i] = { ...d, decidedAt: this.now().toISOString() };
      replaced += 1;
    }
    return replaced;
  }

  async forProposal(invoiceAccessKey: string, mode: EngineMode): Promise<StoredDecision[]> {
    return this.decisions.filter((d) => d.invoiceAccessKey === invoiceAccessKey && d.mode === mode);
  }

  async between(mode: EngineMode, fromIso: string, toIso: string): Promise<StoredDecision[]> {
    const [from, to] = [Date.parse(fromIso), Date.parse(toIso)];
    return this.decisions.filter((d) => d.mode === mode && Date.parse(d.decidedAt) >= from && Date.parse(d.decidedAt) < to);
  }

  async proposals(invoiceAccessKeys: readonly string[]): Promise<ProposalOutcomeRow[]> {
    return invoiceAccessKeys.flatMap((k) => {
      const row = this.proposalRows.get(k);
      return row ? [row] : [];
    });
  }
}
