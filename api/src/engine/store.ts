// #41 O que o motor lê e grava: a configuração por nível (engine_settings) e as decisões (engine_decisions).
import {
  DEFAULT_ANALYST_SETTINGS,
  type EngineDecision,
  type EngineMode,
  type EngineSettings,
  type StoredDecision,
} from './decision.js';

/** #41 O que já foi avaliado num modo: as notas com a decisão da cascata e as que já têm a versão atual do Clef. */
export type Evaluated = {
  /** #41 Notas que já têm a decisão efetiva da cascata (`role = cascade`), em qualquer versão. */
  readonly cascade: ReadonlySet<string>;
  /** #41 Notas que já têm uma linha da versão atual do Clef, da cascata ou da medição. */
  readonly clef: ReadonlySet<string>;
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
}

/** #41 Loja em memória: a dos testes. */
export class MemoryEngineStore implements EngineStore {
  readonly decisions: StoredDecision[] = [];
  private readonly levels = new Map<string, EngineSettings>();

  constructor(
    settings: readonly EngineSettings[] = [DEFAULT_ANALYST_SETTINGS],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const s of settings) this.levels.set(s.level, s);
  }

  async settings(level: string): Promise<EngineSettings> {
    return this.levels.get(level) ?? { ...DEFAULT_ANALYST_SETTINGS, level };
  }

  async evaluated(mode: EngineMode, clefVersion: string): Promise<Evaluated> {
    const inMode = this.decisions.filter((d) => d.mode === mode);
    return {
      cascade: new Set(inMode.filter((d) => d.role === 'cascade').map((d) => d.invoiceAccessKey)),
      clef: new Set(inMode.filter((d) => d.modelVersion === clefVersion).map((d) => d.invoiceAccessKey)),
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
}
