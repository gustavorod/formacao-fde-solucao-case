import { AmountAtRisk } from './amount-at-risk.js';
import { ApprovalPolicy, type ApprovalRoute, type PersonLevel } from './approval-policy.js';
import { maxLevel, type ApprovalLevel } from './approval-level.js';
import { DockAction } from './dock-action.js';
import { DomainError, InvalidTransitionError } from './errors.js';
import type { Supplier } from './context.js';
import type { Invoice } from './invoice.js';
import { Money } from './money.js';
import { Proposal } from './proposal.js';
import type { Title } from './title.js';

/**
 * Os comandos `propose()` e `approve()` da Conferência (#63, história #32), sobre o contrato do #59.
 * Ficam fora de `Invoice` para não mudar o contrato: cada um conduz a nota, a proposta e o título
 * pelas transições que o contrato já tem.
 */

/** Quem aprova: a pessoa que passou pelo Access e o nível dela na régua. */
export type Approver = {
  readonly email: string;
  readonly level: PersonLevel;
};

/** Regra 8: a pessoa aprova a ação proposta, ou a altera com justificativa. */
export type Decision =
  | { readonly kind: 'aprovar' } // ADR-002
  | { readonly kind: 'alterar'; readonly dockAction: DockAction; readonly justification: string }; // ADR-002

/**
 * #42 A decisão do motor que gerou a aprovação (modo delegado): o id em engine_decisions, a confiança (nula quando
 * quem decidiu na cascata foi a regra) e a versão do modelo. O banco confere que batem com a decisão gravada.
 */
export type EngineApprovalLink = {
  readonly decisionId: number;
  readonly confidence: number | null;
  readonly modelVersion: string;
};

/** A aprovação: registrada uma vez por proposta (regra 8). Na regra, o aprovador é a régua; no motor, `motor`. */
export type Approval = {
  readonly approver: string;
  readonly approverLevel: ApprovalLevel;
  readonly dockAction: DockAction;
  readonly justification: string;
  readonly decidedOn: string;
  /** #42 Só na aprovação do motor: a decisão que a gerou. */
  readonly engine?: EngineApprovalLink;
};

/** Regra 8: a pessoa está abaixo do nível do encaminhamento. */
export class NotAllowedToApproveError extends DomainError {
  constructor(level: ApprovalLevel, required: ApprovalLevel) {
    super(`Aprovação: nível ${level} não aprova proposta que exige ${required} ou acima`);
    this.name = 'NotAllowedToApproveError';
  }
}

export const RULE_APPROVER = 'regra'; // ADR-002

/**
 * #42 O aprovador da aprovação do motor de decisão (modo delegado). O banco reserva o nome: só a aprovação com a
 * decisão do motor usa `motor` (restrição approvals_engine_approver_check).
 */
export const ENGINE_APPROVER = 'motor';

/** #42 O motor aprovou esta aprovação: o nome é reservado a ele. */
export function isEngineApproval(approval: Pick<Approval, 'approver'>): boolean {
  return approval.approver === ENGINE_APPROVER;
}

export type ProposeInput = {
  readonly route: ApprovalRoute;
  readonly dockAction: DockAction;
  readonly amountAtRisk: Money;
  readonly justification: string;
  readonly today: string;
};

export type Proposed = {
  readonly proposal: Proposal;
  /** Só no nível regra: a régua aprova sem pessoa e o título já vai para a lista do dia. */
  readonly approval: Approval | null;
};

/**
 * `propose()`: registra a proposta da nota conferida. No nível regra, a régua aprova sem pessoa e o
 * título vai para a lista do dia (AC-1); acima, a proposta aguarda quem pode aprovar (AC-6).
 * O valor em risco fica entre zero e o valor da nota (regra 6, AC-12): fora disso, lança.
 */
export function propose(invoice: Invoice, title: Title, input: ProposeInput): Proposed {
  const proposal = Proposal.register({
    classification: invoice.classification,
    dockAction: input.dockAction,
    level: input.route.level,
    amountAtRisk: AmountAtRisk.of(input.amountAtRisk, invoice.total),
    justification: input.justification,
  });
  invoice.markProposed();
  if (proposal.level !== 'regra') {
    proposal.awaitApproval();
    return { proposal, approval: null };
  }
  proposal.approveByRule();
  invoice.markDecided();
  settlementOf(invoice, title, proposal.dockAction)();
  const approval: Approval = Object.freeze({
    approver: RULE_APPROVER,
    approverLevel: 'regra',
    dockAction: proposal.dockAction,
    justification: proposal.justification,
    decidedOn: input.today,
  });
  return { proposal, approval };
}

/**
 * `approve()`: a pessoa decide a proposta. Regra 8: só no nível exigido ou acima (AC-7), uma vez só
 * (AC-8), e alterar exige justificativa (AC-9). A ação final libera, reduz ou bloqueia o título (AC-11).
 * Tudo é conferido antes de mudar qualquer coisa: se uma condição falha, nota, proposta e título
 * ficam como estavam.
 */
export function approve(
  invoice: Invoice,
  proposal: Proposal,
  title: Title,
  approver: Approver,
  decision: Decision,
  today: string,
  /** Regra 7 e decisão 9: o fornecedor conta para liberar uma duplicidade (linha 2). */
  supplier?: Pick<Supplier, 'paymentBlocked'>,
): Approval {
  if (approver.email.trim() === '') {
    throw new DomainError('Aprovação: quem aprova precisa ter e-mail');
  }
  if (invoice.state !== 'com_proposta' || proposal.state !== 'aguardando_aprovacao') {
    throw new InvalidTransitionError('Proposal', proposal.state, 'aprovar');
  }
  if (title.state !== 'lancado') {
    throw new InvalidTransitionError('Title', title.state, 'decidir');
  }
  const finalAction = decision.kind === 'aprovar' ? proposal.dockAction : decision.dockAction;
  const required = requiredLevel(invoice, proposal.level, finalAction, supplier);
  if (!ApprovalPolicy.canApprove(approver.level, required)) {
    throw new NotAllowedToApproveError(approver.level, ApprovalPolicy.requiredApproverLevel(required));
  }
  if (decision.kind === 'alterar' && decision.justification.trim() === '') {
    throw new DomainError('Proposal: alterar exige justificativa');
  }
  const settlement = settlementOf(invoice, title, finalAction);

  if (decision.kind === 'aprovar') {
    proposal.approve();
  } else {
    proposal.alter(decision.dockAction, decision.justification);
  }
  invoice.markDecided();
  settlement();
  return Object.freeze({
    approver: approver.email,
    approverLevel: approver.level,
    dockAction: proposal.dockAction,
    justification: proposal.justification,
    decidedOn: today,
  });
}

/**
 * #42 Regra 8 com o motor de decisão: no modo delegado o motor aprova a proposta do nível analista, sem alterar a
 * ação, pelo mesmo caminho da aprovação da pessoa (o título vai para a lista do dia). Nunca coordenação, diretoria
 * ou bloqueio. Quem decide se o motor pode aprovar (delegação ligada, confiança no limite) é a rodada do motor; aqui
 * fica só o que vale para qualquer aprovação, mais o nível.
 */
export function approveByEngine(
  invoice: Invoice,
  proposal: Proposal,
  title: Title,
  today: string,
  engine: EngineApprovalLink,
  supplier?: Pick<Supplier, 'paymentBlocked'>,
): Approval {
  if (proposal.level !== 'analista') {
    throw new NotAllowedToApproveError('analista', proposal.level);
  }
  const approval = approve(invoice, proposal, title, { email: ENGINE_APPROVER, level: 'analista' }, { kind: 'aprovar' }, today, supplier);
  return Object.freeze({ ...approval, engine: Object.freeze({ ...engine }) });
}

/**
 * Regra 7 e decisão 4: o bloqueio é resolvido pela coordenação, mas liberar a nota (qualquer ação
 * que não seja recusar) não fica abaixo do nível das outras linhas da régua. Uma duplicidade numa
 * nota acima de R$ 100 mil só é liberada pela diretoria.
 */
function requiredLevel(
  invoice: Invoice,
  level: ApprovalLevel,
  action: DockAction,
  supplier: Pick<Supplier, 'paymentBlocked'> | undefined,
): ApprovalLevel {
  if (level !== 'bloqueio' || action.kind === 'recusar') return level;
  const others = ApprovalPolicy.routeWithout(invoice, 'E6', supplier).level;
  return maxLevel('coordenacao', others === 'bloqueio' ? 'coordenacao' : others);
}

/**
 * AC-11: receber libera o título; receber parcial o reduz pelo valor das linhas seguradas ou
 * devolvidas (quantidade × preço do item da nota de mesmo SKU); recusar o bloqueia. Liberado ou
 * reduzido, vai para a lista do dia (AC-13). Exceção, #64: o título da nota E7 fica bloqueado
 * com qualquer ação, porque a compra já foi paga fora do fluxo. Devolve a mudança a aplicar, já conferida.
 */
function settlementOf(invoice: Invoice, title: Title, action: DockAction): () => void {
  // #64 #33/AC-2: a nota E7 já foi paga fora do fluxo. Seja qual for a ação na doca, o título fica
  // #64 bloqueado, regularizado pelo pagamento vinculado, e nunca vai para a lista do dia.
  if (invoice.classification === 'E7') return () => title.block();
  if (action.kind === 'recusar') return () => title.block();
  if (action.kind === 'receber') {
    return () => {
      title.release();
      title.scheduleToday();
    };
  }
  let withheld = Money.zero();
  const perSku = new Map<string, number>();
  for (const line of action.lines) {
    // #56: o item sem SKU (o E8 não tem cadastro) é identificado pelo código do fornecedor.
    const item = invoice.items.find((i) => (i.sku ?? i.supplierCode) === line.sku);
    if (!item) throw new DomainError(`Receber parcial: o SKU ${line.sku} não está na nota`);
    if (item.quantity.unit !== line.quantity.unit) {
      throw new DomainError(`Receber parcial: ${line.sku} está em ${item.quantity.unit} na nota`);
    }
    // O mesmo SKU em várias linhas soma: o total retido não passa da quantidade da nota.
    const sum = (perSku.get(line.sku) ?? 0) + line.quantity.amount;
    perSku.set(line.sku, sum);
    if (line.quantity.amount <= 0 || sum > item.quantity.amount) {
      throw new DomainError(`Receber parcial: a quantidade de ${line.sku} fica entre zero e a da nota`);
    }
    withheld = withheld.add(Money.ofCents(Math.round(line.quantity.amount * item.unitPrice.cents)));
  }
  if (withheld.isZero()) {
    throw new DomainError('Receber parcial: as linhas retidas não somam valor; use receber');
  }
  const reduced = title.amount.subtract(withheld);
  if (reduced.isZero() || reduced.isNegative()) {
    throw new DomainError('Receber parcial: as linhas retidas cobrem a nota inteira; use recusar');
  }
  return () => {
    title.reduce(reduced);
    title.scheduleToday();
  };
}

/** O que se propõe para a nota, antes de ir à pessoa ou à regra. */
export type Draft = Pick<ProposeInput, 'dockAction' | 'amountAtRisk' | 'justification'>;

/**
 * #63: a proposta padrão pela classificação. Match recebe sem risco; duplicidade recusa com o valor
 * da nota em risco (regra 3); #64: o pago fora do fluxo (E7) recebe com o valor da nota em risco e cita o
 * pagamento vinculado; a não catalogada recebe com a cobrança a mais em risco. As demais
 * exceções começam em receber sem risco, até a história dona de cada uma refinar a ação e o valor;
 * quem aprova pode alterar com justificativa (regra 8).
 */
export function draftProposal(invoice: Invoice, overcharge: Money | null): Draft {
  const classification = invoice.classification;
  if (classification === 'E6') {
    return {
      dockAction: DockAction.refuse(),
      amountAtRisk: invoice.total,
      justification: 'Duplicidade: a mesma compra já foi cobrada; ninguém paga até a coordenação resolver',
    };
  }
  if (classification === 'E7') {
    // #64 #33/AC-2: a mercadoria já está na loja; o que corre risco é pagar a nota inteira de novo.
    const payment = invoice.divergences.find((d) => d.classification === 'E7')?.evidence[0]?.reference;
    return {
      dockAction: DockAction.receive(),
      amountAtRisk: invoice.total,
      justification: `Pago fora do fluxo: a loja já pagou esta compra (${payment ?? 'pagamento vinculado'}); a nota fica vinculada e não vai à lista do dia`,
    };
  }
  if (classification === 'NAO_CATALOGADA' && overcharge) {
    const risk = overcharge.compare(invoice.total) > 0 ? invoice.total : overcharge;
    return {
      dockAction: DockAction.receive(),
      amountAtRisk: risk,
      justification: `Diferença de preço fora da tolerância; a nota cobra ${risk.toString()} acima da ordem`,
    };
  }
  if (classification === 'MATCH') {
    return {
      dockAction: DockAction.receive(),
      amountAtRisk: Money.zero(),
      justification: 'Match: a nota bate com a ordem, dentro da tolerância',
    };
  }
  return {
    dockAction: DockAction.receive(),
    amountAtRisk: Money.zero(),
    justification: `Divergência ${classification}: a ação e o valor em risco ficam com quem aprova`,
  };
}
