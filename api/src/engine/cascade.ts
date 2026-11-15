// #41 A cascata do motor (épico #149): as exclusões e a regra primeiro; o Clef só no que a regra não decide.
import type { CaseFile } from '../approval/store.js';
import { REGUA } from '../domain/approval-policy.js';
import type { Divergence } from '../domain/divergence.js';
import { parseClefAnswer, ClefTimeoutError, type Clef, type ClefInput } from './clef.js';
import { RULE_VERSION, type EngineDecision, type EngineMode, type EngineSettings, type PendingReason } from './decision.js';

/**
 * #41 Entra no motor a proposta que aguarda uma pessoa e tem uma divergência E4, em qualquer valor, nível ou
 * classificação final: as exclusões (E6 junto, fornecedor bloqueado, acima de R$ 100 mil, pedido de alterar)
 * também ficam gravadas, para o relatório mostrar o que nunca chegou ao Clef. A nota sem E4 (E1 e E3 sozinhas
 * ficam com a #46) não entra: gravá-la agora com a mesma versão impediria a avaliação dela quando a regra da
 * contagem entrar.
 */
export function isCandidate(file: CaseFile): boolean {
  return (
    file.proposal.state === 'aguardando_aprovacao' &&
    file.approval === null &&
    file.invoice.divergences.some((d) => d.classification === 'E4')
  );
}

type Pending = { readonly pendingReason: PendingReason; readonly reason: string };

const hasDivergence = (file: CaseFile, code: string): boolean =>
  file.invoice.divergences.some((d) => d.classification === code);

/**
 * #41 AC-3 e AC-3 do #149: o que nunca chega ao Clef nem é aprovado pela regra. Vale a primeira que se aplica.
 * Duplicidade, fornecedor bloqueado, nota acima de R$ 100 mil e pedido de alterar ficam fora dos critérios;
 * diretoria e bloqueio, sem uma dessas, não são delegáveis; o resto fora da linha 5 da régua (E4 sozinha, até
 * R$ 20 mil, analista) fica fora dos critérios desta história.
 */
export function exclusionOf(file: CaseFile): Pending | null {
  const { invoice, proposal, route } = file;
  if (hasDivergence(file, 'E6')) {
    return { pendingReason: 'outside_criteria', reason: 'Duplicidade (E6): ninguém paga até a coordenação resolver' };
  }
  if (file.supplierBlocked) {
    return { pendingReason: 'outside_criteria', reason: 'Fornecedor com pagamento bloqueado: decide a diretoria' };
  }
  if (invoice.total.compare(REGUA.coordinationCeiling) > 0) {
    return {
      pendingReason: 'outside_criteria',
      reason: `Nota de ${invoice.total.toString()}, acima de R$ 100 mil: decide a diretoria`,
    };
  }
  // #41 Pedido de alterar: a proposta já pede outra ação que não receber (segurar, devolver, recusar); mudar o
  // que a doca faz é uma decisão da pessoa, nunca do motor.
  if (proposal.dockAction.kind !== 'receber') {
    return {
      pendingReason: 'outside_criteria',
      reason: `Pedido de alterar: a proposta pede ${proposal.dockAction.kind} na doca, e quem decide é a pessoa`,
    };
  }
  if (proposal.level === 'diretoria' || proposal.level === 'bloqueio' || route.level === 'diretoria' || route.level === 'bloqueio') {
    return { pendingReason: 'level_not_delegable', reason: `Nível ${proposal.level}: o motor nunca aprova diretoria nem bloqueio` };
  }
  const others = invoice.divergences.filter((d) => d.classification !== 'E4').map((d) => d.classification);
  if (others.length > 0) {
    return {
      pendingReason: 'outside_criteria',
      reason: `A nota tem também ${[...new Set(others)].join(', ')}: fora da E4 sozinha que o motor avalia`,
    };
  }
  if (invoice.total.compare(REGUA.analystCeiling) > 0 || proposal.level !== 'analista') {
    return {
      pendingReason: 'outside_criteria',
      reason: `Nota de ${invoice.total.toString()} no nível ${proposal.level}: fora da E4 até R$ 20 mil do analista`,
    };
  }
  return null;
}

/** #67 O texto da evidência do cadastro na E4: `Produto SKU: fator de caixa N; nota X UN, ordem Y UN`. */
const CONVERSION = /^Produto (.+): fator de caixa (\d+(?:\.\d+)?); nota (\d+(?:\.\d+)?) UN, ordem (\d+(?:\.\d+)?) UN$/;

type Conversion = { readonly sku: string; readonly factor: number; readonly invoiced: number; readonly ordered: number };

/** #41 As conversões que a verificação da E4 gravou na evidência do cadastro; nulo se alguma não se lê. */
export function conversionsOf(divergence: Divergence): Conversion[] | null {
  const lines = divergence.evidence.filter((e) => e.source === 'erp_cadastro');
  if (lines.length === 0) return null;
  const parsed: Conversion[] = [];
  for (const line of lines) {
    const m = CONVERSION.exec(line.description);
    if (!m) return null;
    parsed.push({ sku: m[1] ?? '', factor: Number(m[2]), invoiced: Number(m[3]), ordered: Number(m[4]) });
  }
  return parsed;
}

/**
 * #41 AC-2 A regra da E4: a conta fecha quando, em UN pelo fator do cadastro, cada item da nota bate com a
 * ordem e o valor em risco é zero. Aí a regra aprova; em qualquer outro caso, a regra não decide.
 */
export function ruleDecides(file: CaseFile): { readonly reason: string } | null {
  if (!file.proposal.amountAtRisk.amount.isZero()) return null;
  const e4 = file.invoice.divergences.filter((d) => d.classification === 'E4');
  if (e4.length === 0) return null;
  const conversions = e4.map(conversionsOf);
  if (conversions.some((c) => c === null)) return null;
  const all = conversions.flatMap((c) => c ?? []);
  if (!all.every((c) => c.invoiced === c.ordered)) return null;
  const detail = all.map((c) => `${c.sku} ${c.invoiced} UN pelo fator ${c.factor}`).join('; ');
  return { reason: `A conversão fecha e o valor em risco é zero: ${detail}, igual à ordem` };
}

/**
 * #41 Exclusões e regra, sem chamar o Clef. Devolve a decisão, ou nulo quando só o Clef pode decidir.
 */
export function screen(file: CaseFile, mode: EngineMode): EngineDecision | null {
  const base = { invoiceAccessKey: file.invoice.accessKey, mode, error: null, latencyMs: null, modelVersion: RULE_VERSION };
  const excluded = exclusionOf(file);
  if (excluded) {
    return { ...base, outcome: 'pending', decidedBy: 'person', confidence: null, ...excluded };
  }
  const rule = ruleDecides(file);
  if (rule) {
    return { ...base, outcome: 'approve', decidedBy: 'rule', confidence: null, pendingReason: null, reason: rule.reason };
  }
  return null;
}

/** #41 O que o Clef recebe da proposta: a régua, os valores e a evidência da conversão de unidade. */
export function clefInputOf(file: CaseFile): ClefInput {
  const { invoice, proposal, route } = file;
  return {
    invoiceAccessKey: invoice.accessKey,
    classification: proposal.classification,
    level: proposal.level,
    reguaLine: route.line,
    reguaReason: route.reason,
    invoiceTotal: invoice.total.toString(),
    amountAtRisk: proposal.amountAtRisk.amount.toString(),
    proposedDockAction: proposal.dockAction.kind,
    justification: proposal.justification,
    evidence: invoice.divergences.filter((d) => d.classification === 'E4').flatMap((d) => d.evidence),
  };
}

const errorClass = (error: unknown): string => (error instanceof Error ? error.name : 'Error');

/** #41 Chama o Clef com o limite de tempo; o tempo esgotado aborta o pedido e vira `ClefTimeoutError`. */
async function askWithTimeout(clef: Clef, input: ClefInput, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // #41 Rejeita antes de abortar: o pedido abortado também rejeita, e o motivo gravado é o tempo esgotado.
      reject(new ClefTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([clef.ask(input, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * #41 O Clef decide o que a regra não decidiu. No modo sombra grava o que ele faria, com a confiança, sem
 * aplicar o limite: o relatório compara a confiança com o limite (`at_or_above_threshold`), e quem aplica o
 * limite para aprovar é o modo delegado (#42). AC-6: falha, tempo esgotado ou resposta inválida deixam a
 * proposta com a pessoa, como hoje, com a classe do erro e a latência gravadas; nada lança daqui.
 */
export async function askClef(
  file: CaseFile,
  deps: { readonly clef: Clef; readonly settings: EngineSettings; readonly mode: EngineMode; readonly now?: () => number },
): Promise<EngineDecision> {
  const now = deps.now ?? (() => Date.now());
  const base = { invoiceAccessKey: file.invoice.accessKey, mode: deps.mode, modelVersion: deps.clef.modelVersion };
  const started = now();
  try {
    const answer = parseClefAnswer(await askWithTimeout(deps.clef, clefInputOf(file), deps.settings.clefTimeoutMs));
    return {
      ...base,
      outcome: answer.outcome,
      decidedBy: 'clef',
      confidence: answer.confidence,
      reason: answer.reason,
      pendingReason: null,
      error: null,
      latencyMs: Math.max(0, Math.round(now() - started)),
    };
  } catch (error) {
    return {
      ...base,
      outcome: 'pending',
      decidedBy: 'person',
      confidence: null,
      reason: 'O Clef não respondeu a tempo ou respondeu fora do formato: a proposta segue para a pessoa',
      pendingReason: 'clef_failed',
      error: errorClass(error),
      latencyMs: Math.max(0, Math.round(now() - started)),
    };
  }
}
