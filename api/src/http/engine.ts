// #41 AC-5 GET /api/motor/acerto: o relatório de acerto do motor em modo sombra, por semana e classificação.
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import { addDays, agreementReport, mondayOf, weeksBetween } from '../engine/agreement.js';
import type { EngineMode } from '../engine/decision.js';
import { SupabaseEngineStore } from '../engine/supabase-store.js';
import type { EngineReader } from '../engine/store.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';
import { todayInBrasilia } from './approval.js';

/** #41 Sem parâmetro, as últimas 8 semanas, a atual incluída. */
export const DEFAULT_WEEKS = 8;
/** #41 Um ano de semanas no máximo por pedido. */
export const MAX_WEEKS = 53;

/** #41 O limite que o relatório usa é o do analista: nesta história o motor só avalia a E4 até R$ 20 mil. */
const REPORT_LEVEL = 'analista';
const REPORT_MODE: EngineMode = 'shadow';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string): boolean => DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * #41 As semanas pedidas, como segundas-feiras. `semana=AAAA-MM-DD` é a semana desse dia; `de` e `ate` (dias)
 * cobrem as semanas do primeiro ao último; sem nada, as últimas 8. Erro: o texto do 400.
 */
export function requestedWeeks(params: URLSearchParams, today: string): { weeks: string[] } | { error: string } {
  const week = params.get('semana');
  const from = params.get('de');
  const to = params.get('ate');
  if (week !== null) {
    if (from !== null || to !== null) return { error: 'Use semana ou de/ate, não os dois' };
    if (!isDay(week)) return { error: 'semana precisa ser um dia AAAA-MM-DD' };
    return { weeks: [mondayOf(week)] };
  }
  if (from === null && to === null) {
    const last = mondayOf(today);
    return { weeks: weeksBetween(addDays(last, -7 * (DEFAULT_WEEKS - 1)), last) };
  }
  if (from === null || to === null || !isDay(from) || !isDay(to)) return { error: 'de e ate precisam ser dias AAAA-MM-DD' };
  if (from > to) return { error: 'de precisa ser antes de ate' };
  const weeks = weeksBetween(mondayOf(from), mondayOf(to));
  if (weeks.length > MAX_WEEKS) return { error: `No máximo ${MAX_WEEKS} semanas por pedido` };
  return { weeks };
}

/**
 * #41 AC-5 Monta o relatório: as linhas do motor desde a primeira segunda (meia-noite em Brasília, UTC-3), a
 * classificação e o estado das propostas, e o limite do analista. A medição do Clef de uma proposta é sempre
 * gravada na rodada da cascata ou depois, então ler a partir do começo do período a alcança.
 */
export async function engineAgreementReport(reader: EngineReader, weeks: readonly string[]) {
  const first = weeks[0] ?? '';
  const decisions = await reader.since(REPORT_MODE, new Date(`${first}T00:00:00-03:00`).toISOString());
  const keys = [...new Set(decisions.filter((d) => d.role === 'cascade').map((d) => d.invoiceAccessKey))];
  const [proposals, settings] = await Promise.all([reader.proposals(keys), reader.settings(REPORT_LEVEL)]);
  return {
    mode: REPORT_MODE,
    level: REPORT_LEVEL,
    threshold: settings.confidenceThreshold,
    from: first,
    to: addDays(weeks.at(-1) ?? first, 6),
    items: agreementReport({ weeks, threshold: settings.confidenceThreshold, decisions, proposals }),
  };
}

export async function engineAgreement(_identity: Identity, request: Request, env: Env): Promise<Response> {
  const parsed = requestedWeeks(new URL(request.url).searchParams, todayInBrasilia());
  if ('error' in parsed) return Response.json({ error: 'periodo_invalido', message: parsed.error }, { status: 400 });
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return Response.json({ error: 'supabase_nao_configurado' }, { status: 503 });
  try {
    const reader = new SupabaseEngineStore(new SupabaseRest({ url, secretKey }));
    return Response.json(await engineAgreementReport(reader, parsed.weeks));
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    console.error(`motor/acerto: ${error.operation} em ${error.table} falhou (HTTP ${error.status})`);
    return Response.json({ error: 'supabase_indisponivel' }, { status: 502 });
  }
}
