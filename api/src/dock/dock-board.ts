// A doca de um destino num dia: as notas e a ação de cada uma (#72, #43 AC-1 a AC-4). Função pura.
import type { DockActionMessage, Published } from '../connectors/ports.js';
import type { ApprovalLevel, DockAction, PartialLine, Unit } from '../domain/index.js';
import { isEngineApproval } from '../domain/approval.js';
import { receivingPlace, type ReceivingPlace } from './receiving-place.js';

/** #72 O que a doca precisa saber da nota. */
export type DockInvoice = {
  readonly accessKey: string;
  readonly number: string;
  readonly supplierId: string;
  readonly store: string;
  readonly issuedOn: string;
  readonly items: readonly DockInvoiceItem[];
};

/** #72 A quantidade no fio: o mesmo formato do `QuantityDto` da tela (`web/src/api/contract.ts`). */
export type DockQuantity = { readonly amount: number; readonly unit: Unit };

export type DockInvoiceItem = {
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: DockQuantity;
};

/** #72 Uma linha do receber parcial no fio: o formato do `PartialLineDto` da tela. */
export type DockLine = {
  readonly sku: string;
  readonly quantity: DockQuantity;
  readonly disposition: PartialLine['disposition'];
};

/** #72 A ação no fio: o formato do `DockActionDto` da tela. */
export type DockActionView =
  | { readonly kind: 'receber' }
  | { readonly kind: 'receber_parcial'; readonly lines: readonly DockLine[] }
  | { readonly kind: 'recusar' };

/** #43 AC-3: o que a doca lê numa nota sem decisão. */
export const AWAITING_INSTRUCTION = 'Aguardando aprovação, não descarregue';

export type DockStatus =
  | { readonly kind: 'acao'; readonly action: DockActionView; readonly publishedAt: string }
  | { readonly kind: 'aguardando_aprovacao'; readonly instrucao: typeof AWAITING_INSTRUCTION };

/**
 * #211 Quem decidiu a nota, no vocabulário do `timeline[]`: a régua, a pessoa (pelo e-mail) ou, #42, o motor de
 * decisão no modo delegado (`Motor`).
 */
export type DockDecidedBy = { readonly actor: 'rule' | 'engine' | 'person'; readonly actor_name: string };

/** #211 A decisão registrada da nota: quem aprovou e em que nível (`regra` é a régua). */
export type DockDecision = { readonly approver: string; readonly approverLevel: ApprovalLevel };

export type DockRow = {
  readonly invoiceAccessKey: string;
  readonly number: string;
  readonly supplierId: string;
  readonly items: readonly DockInvoiceItem[];
  readonly status: DockStatus;
  /** #211 Quem decidiu a nota; nulo enquanto não há aprovação. */
  readonly decidedBy: DockDecidedBy | null;
};

export type DockBoard = {
  readonly destination: string | null;
  readonly date: string;
  readonly destinations: readonly string[];
  readonly awaiting: number;
  readonly rows: readonly DockRow[];
};

export type DockBoardInput = {
  readonly invoices: readonly DockInvoice[];
  readonly published: readonly Published<DockActionMessage>[];
  /** #135 A doca do CD ou o app da loja: só os destinos deste lugar entram. Padrão: a doca do CD. */
  readonly place?: ReceivingPlace;
  /** Nulo: o primeiro destino do dia (#72). */
  readonly destination: string | null;
  readonly date: string;
  /** #211 A decisão de cada nota, pela chave de acesso. Sem ela, `decidedBy` vai nulo. */
  readonly decisions?: ReadonlyMap<string, DockDecision>;
};

function decidedByOf(decision: DockDecision | undefined): DockDecidedBy | null {
  if (!decision) return null;
  if (decision.approverLevel === 'regra') return { actor: 'rule', actor_name: 'Regra' };
  // #42 O nome `motor` é reservado à aprovação do motor (restrição approvals_engine_approver_check).
  if (isEngineApproval(decision)) return { actor: 'engine', actor_name: 'Motor' };
  return { actor: 'person', actor_name: decision.approver };
}

function view(action: DockAction): DockActionView {
  if (action.kind !== 'receber_parcial') return { kind: action.kind };
  return {
    kind: action.kind,
    lines: action.lines.map((l) => ({
      sku: l.sku,
      quantity: { amount: l.quantity.amount, unit: l.quantity.unit },
      disposition: l.disposition,
    })),
  };
}

/**
 * #72 Se mais de uma proposta da nota foi publicada, vale a de maior id. Publicar de novo uma ação
 * idêntica não grava linha nova: a caixa de saída deduplica pela nota e pelo payload.
 */
function latestByInvoice(published: readonly Published<DockActionMessage>[]): Map<string, Published<DockActionMessage>> {
  const latest = new Map<string, Published<DockActionMessage>>();
  for (const p of published) {
    const current = latest.get(p.invoiceAccessKey);
    if (!current || p.id > current.id) latest.set(p.invoiceAccessKey, p);
  }
  return latest;
}

/** #43 AC-3: sem publicação na caixa de saída, a nota aguarda; nunca aparece como receber. */
function statusOf(published: Published<DockActionMessage> | undefined): DockStatus {
  if (!published) return { kind: 'aguardando_aprovacao', instrucao: AWAITING_INSTRUCTION };
  return { kind: 'acao', action: view(published.action), publishedAt: published.publishedAt };
}

const byNumber = (a: DockInvoice, b: DockInvoice) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true });

/** #43 AC-4: as notas do dia do destino (ou do primeiro destino do dia), ordenadas pelo número, com a ação de cada uma. */
export function dockBoard({ invoices, published, destination: requested, date, place = 'doca_cd', decisions }: DockBoardInput): DockBoard {
  const ofDay = invoices.filter((i) => i.issuedOn === date && receivingPlace(i.store) === place);
  const destinations = [...new Set(ofDay.map((i) => i.store))].sort();
  const destination = requested ?? destinations[0] ?? null;
  const latest = latestByInvoice(published);
  const rows: DockRow[] = ofDay
    .filter((i) => i.store === destination)
    .sort(byNumber)
    .map((i) => ({
      invoiceAccessKey: i.accessKey,
      number: i.number,
      supplierId: i.supplierId,
      items: i.items.map((item) => ({
        sku: item.sku,
        description: item.description,
        quantity: { amount: item.quantity.amount, unit: item.quantity.unit },
      })),
      status: statusOf(latest.get(i.accessKey)),
      decidedBy: decidedByOf(decisions?.get(i.accessKey)),
    }));
  const awaiting = rows.filter((r) => r.status.kind === 'aguardando_aprovacao').length;
  return { destination, date, destinations, awaiting, rows };
}
