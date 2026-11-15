import { listDescriptionSuggestions, storedDescriptionSuggester } from "../connectors/claude-suggestions";
import { blockDuplicateTitles } from "../connectors/duplicate-settler";
import { runClaudeRound } from "../claude/cron";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import type { RegistryCorrectionOutbox } from "../connectors/ports";
import type { DescriptionSuggester } from "../domain/description-match";
import type { Env } from "../env";
import { captureInvoices } from "./capture";
import { findUnreconciledReceipts } from "./unreconciled-receipts";
import { proposeChecked } from "../approval/propose-checked";
import { SupabaseApprovalStore } from "../approval/supabase-store";
import { publishDecidedDockActions, publishDecidedStoreActions } from "../dock/publish-decided";
import { NO_FIGURES, recordRun, type RunFigures } from "../automation/runs";
import { lastDaysUtc, publishApprovedUnregistered } from "./publish-approved-e8";
import { WorkersAiClef } from "../engine/clef";
import { runEngineRound } from "../engine/delegated";
import { todayInBrasilia } from "../http/approval";
import { SupabaseEngineStore } from "../engine/supabase-store";

/** #66 A janela, em dias, das decisões que o Cron manda ao Cadastro; ver `lastDaysUtc`. */
const PUBLISH_WINDOW_DAYS = 7;

/** #174 O que uma rodada fez, para a reconferência devolver. Nulo quando a rodada foi pulada. */
export interface TickSummary {
  seen: number;
  inserted: number;
  checked: number;
  failed: number;
  proposed: number;
}

/** Execução agendada: captura e confere as notas (#59). Registra uma linha, sem dado sensível. */
export async function tick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<TickSummary | null> {
  const startedAt = new Date();
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${controller.cron}); sem credenciais do Supabase, captura pulada`);
    return null;
  }
  const rest = new SupabaseRest({ url, secretKey });
  try {
    const { summary, figures } = await runRound(controller, env, rest);
    await recordRunSafely(rest, { startedAt, status: "ok", figures });
    return summary;
  } catch (error) {
    // #211 AC-1 A rodada que falha também fica gravada, só com a classe do erro.
    await recordRunSafely(rest, { startedAt, status: "failed", figures: NO_FIGURES, error: errorClass(error) });
    throw error;
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** #211 O registro da rodada é observação: se falha, uma linha no log e o Cron segue. */
async function recordRunSafely(
  rest: SupabaseRest,
  run: { startedAt: Date; status: "ok" | "failed"; figures: RunFigures; error?: string },
): Promise<void> {
  try {
    await recordRun(rest, { ...run, finishedAt: new Date() });
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na gravação";
    console.log(`cron: rodada não registrada (${status})`);
  }
}

async function runRound(
  controller: Pick<ScheduledController, "cron">,
  env: Env,
  rest: SupabaseRest,
): Promise<{ summary: TickSummary; figures: RunFigures }> {
  const { captureDeps, registryCorrections } = supabaseConnectors(rest);
  const descriptions = await storedSuggestions(rest);
  const result = await captureInvoices(descriptions ? { ...captureDeps, descriptions } : captureDeps);
  const unreconciled = await findUnreconciledReceipts(captureDeps);
  // #63 Depois de conferir, propõe e encaminha pela régua; o match vai sozinho para a lista do dia.
  const proposals = await proposeChecked({
    rest,
    purchasing: captureDeps.purchasing,
    registry: captureDeps.registry,
    wms: captureDeps.wms,
  });
  const cadastroE8 = await publishApproved(rest, registryCorrections);
  // #43 AC-1 O que a regra aprovou agora (e o que falhou na hora da aprovação) vai para a doca.
  const dock = await publishDock(rest);
  const storeActions = await publishStoreActions(rest);
  const duplicates = await blockDuplicateTitles(rest); // #31/AC-5: o título da E6 fica bloqueado já na detecção.
  // #171 O Claude vai por último: é periférico, e a captura (o caminho crítico) fica com os subrequests da
  // invocação. As sugestões que ele grava aqui a próxima rodada lê. Falha fechada: a regra decide sozinha.
  await runClaudeRound(rest, env);
  // #41 O motor de decisão também é periférico e falha sozinho. #42 Com a delegação do analista ligada, aprova; a
  // ação aprovada pelo motor chega à doca na varredura da próxima rodada (`publishDock`), como a que falhou agora.
  const engine = await runEngine(rest, env);
  const engineEvaluated = engine.evaluated;
  console.log(
    `cron: execução agendada (${controller.cron}); notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}, com erro ${result.failed}, propostas ${proposals.proposed}, aprovadas pela regra ${proposals.approvedByRule}, cadastro E8 ${cadastroE8}, ações publicadas na doca ${dock}, ações publicadas no app da loja ${storeActions}, títulos duplicados bloqueados ${duplicates.blocked}, com falha ${duplicates.failed}, avaliadas pelo motor ${engineEvaluated}, aprovadas pelo motor ${engine.approved}; recebimentos sem nota [${unreconciled.noKey.join(", ")}], com chave sem nota [${unreconciled.keyWithoutInvoice.join(", ")}]`,
  );
  const summary = {
    seen: result.seen,
    inserted: result.inserted,
    checked: result.checked,
    failed: result.failed,
    proposed: proposals.proposed,
  };
  const figures: RunFigures = {
    ...summary,
    approvedByRule: proposals.approvedByRule,
    cadastroE8,
    dockPublished: dock,
    storePublished: storeActions,
    duplicatesBlocked: duplicates.blocked,
    engineEvaluated,
    engineApproved: engine.approved,
  };
  return { summary, figures };
}

/**
 * #66 As sugestões de casamento por descrição que a rodada do Claude (api/src/claude) gravou. Se a leitura falha,
 * registra uma linha (só o status, sem dado sensível) e a regra decide sozinha.
 */
async function storedSuggestions(rest: SupabaseRest): Promise<DescriptionSuggester | undefined> {
  try {
    return storedDescriptionSuggester(await listDescriptionSuggestions(rest));
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na leitura";
    console.log(`cron: sugestões do Claude indisponíveis (${status}); a regra decide sozinha`);
    return undefined;
  }
}

/**
 * #35 (plano #66, AC-5) Manda ao Cadastro o E8 das propostas decididas os últimos 7 dias (UTC). Se falha, registra
 * uma linha sem dado sensível e a rodada segue: a caixa de saída é idempotente e a próxima rodada repete.
 */
async function publishApproved(
  rest: SupabaseRest,
  outbox: RegistryCorrectionOutbox,
): Promise<number> {
  try {
    const days = lastDaysUtc(new Date(), PUBLISH_WINDOW_DAYS);
    const { published } = await publishApprovedUnregistered({ store: new SupabaseApprovalStore(rest), outbox, days });
    return published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    console.log(`cron: cadastro E8 indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/**
 * #43 AC-1 Publica na caixa de saída do WMS a ação das propostas decididas que ainda não chegou à doca.
 * Se falha, registra uma linha sem dado sensível e a rodada segue: a varredura é idempotente e a
 * próxima rodada repete.
 */
async function publishDock(rest: SupabaseRest): Promise<number> {
  try {
    return (await publishDecidedDockActions(rest)).published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    console.log(`cron: doca indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/** #135 As notas de loja: a ação aprovada vai para o app da loja. Falhou, o Cron repete na próxima rodada. */
async function publishStoreActions(rest: SupabaseRest): Promise<number> {
  try {
    return (await publishDecidedStoreActions(rest)).published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    console.log(`cron: app da loja indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}

/**
 * #41 AC-1 a AC-3 e AC-6 O motor de decisão. #42 AC-5 Com a delegação do analista desligada (o padrão), o modo
 * sombra: grava o que faria em engine_decisions, sem tocar em approvals nem em proposals. Ligada, o modo delegado:
 * aprova pelo caminho da aprovação da pessoa e conta em `engine_approved`. Sem o binding do Workers AI, pula; se
 * falha, registra uma linha sem dado sensível e a rodada segue: a próxima avalia o que ficou.
 */
async function runEngine(rest: SupabaseRest, env: Env): Promise<{ evaluated: number; approved: number }> {
  const none = { evaluated: 0, approved: 0 };
  if (!env.ai) {
    console.log("cron: sem o binding do Workers AI; motor de decisão pulado");
    return none;
  }
  try {
    const round = await runEngineRound({
      approvals: new SupabaseApprovalStore(rest),
      store: new SupabaseEngineStore(rest),
      clef: new WorkersAiClef(env.ai),
      today: () => todayInBrasilia(),
    });
    if (round.mode === "delegated") {
      console.log(
        `cron: motor (delegado), avaliadas ${round.evaluated}, aprovadas ${round.approved}, com a pessoa depois de aprovar ${round.keptWithPerson}, abaixo do limite ${round.belowConfidence}, Clef ${round.clefCalls}, com falha ${round.clefFailed}, para a próxima rodada ${round.deferred}, com erro ${round.errors}`,
      );
      if (round.firstError) {
        console.log(`cron: motor (delegado), decisões ou aprovações não gravadas (${round.firstError}); ficam com a pessoa`);
      }
      return { evaluated: round.evaluated, approved: round.approved };
    }
    console.log(
      `cron: motor (sombra), avaliadas ${round.evaluated}, medidas pelo Clef ${round.measured}, refeitas depois de falha ${round.retried}, Clef ${round.clefCalls}, com falha ${round.clefFailed}, para a próxima rodada ${round.deferred}`,
    );
    if (round.writeError) {
      console.log(`cron: motor (sombra), novas tentativas ou medição não gravadas (${round.writeError}); a próxima rodada repete`);
    }
    return { evaluated: round.evaluated, approved: 0 };
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha no motor";
    console.log(`cron: motor de decisão indisponível (${status}); a próxima rodada repete`);
    return none;
  }
}
