// #41 O contrato de saída do motor de decisão (épico #149): uma decisão por proposta, gravada em engine_decisions.

export type EngineOutcome = 'approve' | 'refuse' | 'pending';

/** #149 Quem resolveu na cascata regra → Clef → pessoa. */
export type DecidedBy = 'rule' | 'clef' | 'person';

/** #149 `shadow` só grava o que faria; `delegated` aprova (#42). */
export type EngineMode = 'shadow' | 'delegated';

/** #41 Por que a decisão ficou com a pessoa. Os valores são os da restrição de engine_decisions. */
export type PendingReason =
  | 'below_confidence'
  | 'outside_criteria'
  | 'level_not_delegable'
  | 'delegation_off'
  | 'clef_failed';

/** #41 A versão da regra do motor para a E4: entra em `model_version` quando quem decide não é o Clef. */
export const RULE_VERSION = 'regra-e4-v1';

/**
 * #41 A decisão do motor para uma proposta. As combinações seguem as restrições da migração
 * 20261116110000_engine_decisions.sql: confiança só quando o Clef decidiu; motivo de pendência só com
 * `pending`; a pessoa só com `pending`.
 */
export type EngineDecision = {
  readonly invoiceAccessKey: string;
  readonly outcome: EngineOutcome;
  readonly decidedBy: DecidedBy;
  readonly confidence: number | null;
  readonly modelVersion: string;
  readonly mode: EngineMode;
  /** #149 O porquê, em uma frase, citando a evidência. */
  readonly reason: string;
  readonly pendingReason: PendingReason | null;
  /** #41 AC-6 A classe da falha do Clef, nunca a mensagem nem dado sensível. */
  readonly error: string | null;
  readonly latencyMs: number | null;
};

/** #41 O que o motor lê de engine_settings para um nível. */
export type EngineSettings = {
  readonly level: string;
  readonly delegationEnabled: boolean;
  readonly confidenceThreshold: number;
  readonly clefTimeoutMs: number;
};

/** #41 Os valores padrão da migração, para o nível analista, quando a linha não existe. */
export const DEFAULT_ANALYST_SETTINGS: EngineSettings = Object.freeze({
  level: 'analista',
  delegationEnabled: false,
  confidenceThreshold: 0.98,
  clefTimeoutMs: 3000,
});
