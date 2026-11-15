// #41 A loja do motor no Supabase: engine_settings e engine_decisions (migração 20261116110000).
import { isBoolean, isInteger, isNumber, isString, parseRows, shaped, type Guard, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { DEFAULT_ANALYST_SETTINGS, type EngineDecision, type EngineMode, type EngineSettings } from './decision.js';
import type { EngineStore } from './store.js';

type SettingsRow = {
  level: string;
  delegation_enabled: boolean;
  confidence_threshold: number | string;
  clef_timeout_ms: number;
};

/** #41 O PostgREST devolve `numeric` como número; aceita também o texto, por garantia. */
const isNumeric: Guard<number | string> = (v): v is number | string =>
  isNumber(v) || (isString(v) && v.trim() !== '' && Number.isFinite(Number(v)));

const isSettingsRow = shaped<SettingsRow>({
  level: isString,
  delegation_enabled: isBoolean,
  confidence_threshold: isNumeric,
  clef_timeout_ms: isInteger,
} satisfies Shape<SettingsRow>);

/** #63 A chave de acesso tem 44 dígitos; validar aqui protege os filtros `in.(...)` montados com ela. */
const isAccessKey = (v: string): boolean => /^\d{44}$/.test(v);

/** #41 A versão vai entre aspas no filtro `in.(...)`; aspas, vírgula e parênteses não entram. */
const isSafeVersion = (v: string): boolean => /^[^",()]+$/.test(v);

export class SupabaseEngineStore implements EngineStore {
  constructor(private readonly rest: SupabaseRest) {}

  async settings(level: string): Promise<EngineSettings> {
    const rows = parseRows(
      await this.rest.select('engine_settings', { filters: { level: `eq.${level}` } }),
      isSettingsRow,
      'engine_settings',
    );
    const [row] = rows;
    if (!row) return { ...DEFAULT_ANALYST_SETTINGS, level };
    return {
      level: row.level,
      delegationEnabled: row.delegation_enabled,
      confidenceThreshold: Number(row.confidence_threshold),
      clefTimeoutMs: row.clef_timeout_ms,
    };
  }

  async decidedKeys(mode: EngineMode, modelVersions: readonly string[]): Promise<Set<string>> {
    if (modelVersions.length === 0) return new Set();
    if (!modelVersions.every(isSafeVersion)) {
      throw new SupabaseRestError('select', 'engine_decisions', 0, 'versão do modelo fora do formato');
    }
    const rows = parseRows(
      await this.rest.select('engine_decisions', {
        select: 'invoice_access_key',
        filters: { mode: `eq.${mode}`, model_version: `in.(${modelVersions.map((v) => `"${v}"`).join(',')})` },
      }),
      shaped<{ invoice_access_key: string }>({ invoice_access_key: isString }),
      'engine_decisions',
    );
    return new Set(rows.map((r) => r.invoice_access_key));
  }

  /** #41 Liga cada decisão à proposta da nota (uma por nota) e grava, ignorando a que já existe. */
  async record(decisions: readonly EngineDecision[]): Promise<number> {
    if (decisions.length === 0) return 0;
    const keys = [...new Set(decisions.map((d) => d.invoiceAccessKey))];
    if (!keys.every(isAccessKey)) {
      throw new SupabaseRestError('insert', 'engine_decisions', 0, 'chave de acesso fora do formato');
    }
    const proposals = parseRows(
      await this.rest.select('proposals', {
        select: 'id,invoice_access_key',
        filters: { invoice_access_key: `in.(${keys.map((k) => `"${k}"`).join(',')})` },
      }),
      shaped<{ id: number; invoice_access_key: string }>({ id: isInteger, invoice_access_key: isString }),
      'proposals',
    );
    const idByKey = new Map(proposals.map((p) => [p.invoice_access_key, p.id]));
    const rows = decisions.flatMap((d) => {
      const proposalId = idByKey.get(d.invoiceAccessKey);
      if (proposalId === undefined) return [];
      return [
        {
          proposal_id: proposalId,
          invoice_access_key: d.invoiceAccessKey,
          outcome: d.outcome,
          decided_by: d.decidedBy,
          confidence: d.confidence,
          model_version: d.modelVersion,
          mode: d.mode,
          reason: d.reason,
          pending_reason: d.pendingReason,
          error: d.error,
          latency_ms: d.latencyMs,
        },
      ];
    });
    const inserted = await this.rest.insert('engine_decisions', rows, {
      onConflict: 'proposal_id,model_version,mode',
      ignoreDuplicates: true,
    });
    return inserted.length;
  }
}
