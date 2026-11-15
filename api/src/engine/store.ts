// #41 O que o motor lê e grava: a configuração por nível (engine_settings) e as decisões (engine_decisions).
import { DEFAULT_ANALYST_SETTINGS, type EngineDecision, type EngineMode, type EngineSettings } from './decision.js';

export interface EngineStore {
  /** #41 A configuração do nível; sem linha, os padrões da migração. */
  settings(level: string): Promise<EngineSettings>;
  /** #41 As chaves das notas que já têm decisão neste modo, com alguma destas versões. */
  decidedKeys(mode: EngineMode, modelVersions: readonly string[]): Promise<Set<string>>;
  /**
   * #41 Grava as decisões e devolve quantas entraram. Idempotente: a decisão que já existe para a mesma
   * proposta, versão e modo é ignorada (a unicidade de engine_decisions).
   */
  record(decisions: readonly EngineDecision[]): Promise<number>;
}

/** #41 Loja em memória: a dos testes. */
export class MemoryEngineStore implements EngineStore {
  readonly decisions: EngineDecision[] = [];
  private readonly levels = new Map<string, EngineSettings>();

  constructor(settings: readonly EngineSettings[] = [DEFAULT_ANALYST_SETTINGS]) {
    for (const s of settings) this.levels.set(s.level, s);
  }

  async settings(level: string): Promise<EngineSettings> {
    return this.levels.get(level) ?? { ...DEFAULT_ANALYST_SETTINGS, level };
  }

  async decidedKeys(mode: EngineMode, modelVersions: readonly string[]): Promise<Set<string>> {
    return new Set(
      this.decisions
        .filter((d) => d.mode === mode && modelVersions.includes(d.modelVersion))
        .map((d) => d.invoiceAccessKey),
    );
  }

  async record(decisions: readonly EngineDecision[]): Promise<number> {
    let inserted = 0;
    for (const d of decisions) {
      const exists = this.decisions.some(
        (x) => x.invoiceAccessKey === d.invoiceAccessKey && x.modelVersion === d.modelVersion && x.mode === d.mode,
      );
      if (exists) continue;
      this.decisions.push(d);
      inserted += 1;
    }
    return inserted;
  }
}
