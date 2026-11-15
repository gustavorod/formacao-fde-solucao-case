// #41 Processos de aprovação montados à mão para o motor, e um Clef falso, sem rede.
import type { CaseFile } from '../../src/approval/store.js';
import { routeDivergences } from '../../src/domain/approval-policy.js';
import {
  AmountAtRisk,
  Divergence,
  DockAction,
  Invoice,
  Money,
  Proposal,
  Quantity,
  Title,
  type ApprovalLevel,
  type Classification,
  type Evidence,
} from '../../src/domain/index.js';
import type { Clef, ClefInput } from '../../src/engine/clef.js';

let seq = 0;

/** #41 Uma chave de acesso de 44 dígitos, diferente a cada chamada. */
export function accessKey(): string {
  seq += 1;
  return String(seq).padStart(44, '3');
}

/** #67 A evidência que a verificação da E4 grava: nota, ordem e o fator do cadastro. */
export function e4Evidence(key: string, sku: string, invoicedUnits: number, orderedUnits: number, factor = 4): Evidence[] {
  return [
    { source: 'sefaz', reference: key, description: `Item ${sku} na nota: ${invoicedUnits / factor} CX a R$ 40,00` },
    { source: 'erp_compras', reference: 'OC-1', description: `Item ${sku} na ordem: ${orderedUnits} UN a R$ 10,00` },
    {
      source: 'erp_cadastro',
      reference: sku,
      description: `Produto ${sku}: fator de caixa ${factor}; nota ${invoicedUnits} UN, ordem ${orderedUnits} UN`,
    },
  ];
}

export type FileOptions = {
  readonly key?: string;
  /** Valor da nota, em centavos. Padrão: R$ 1.000,00. */
  readonly totalCents?: number;
  /** Valor em risco, em centavos. Padrão: zero. */
  readonly riskCents?: number;
  readonly invoicedUnits?: number;
  readonly orderedUnits?: number;
  /** Divergências a mais, além da E4. */
  readonly extra?: readonly Exclude<Classification, 'MATCH'>[];
  /** Sem a E4 (para a nota que não é candidata). */
  readonly withoutE4?: boolean;
  readonly supplierBlocked?: boolean;
  readonly dockAction?: DockAction;
  readonly level?: ApprovalLevel;
  readonly classification?: Classification;
  /** Evidência do cadastro trocada por um texto que a regra não lê. */
  readonly unreadableEvidence?: boolean;
};

/** #41 Um processo que aguarda a pessoa, com a E4 e o que as opções pedirem. */
export function caseFile(options: FileOptions = {}): CaseFile {
  const key = options.key ?? accessKey();
  const total = Money.ofCents(options.totalCents ?? 100_000);
  const evidence = options.unreadableEvidence
    ? [{ source: 'erp_cadastro' as const, reference: 'SKU-1', description: 'Produto SKU-1 sem fator' }]
    : e4Evidence(key, 'SKU-1', options.invoicedUnits ?? 40, options.orderedUnits ?? 40);
  const divergences: Divergence[] = [];
  if (!options.withoutE4) divergences.push(Divergence.of({ classification: 'E4', skus: ['SKU-1'], evidence }));
  for (const c of options.extra ?? []) {
    divergences.push(
      Divergence.of({ classification: c, skus: ['SKU-2'], evidence: [{ source: 'sefaz', reference: key, description: c }] }),
    );
  }
  const invoice = Invoice.receive({
    accessKey: key,
    number: '1',
    series: '1',
    supplierId: 'F01',
    store: 'L01',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-1',
    entryChannel: 'sefaz',
    items: [
      {
        supplierCode: 'F01-1',
        sku: 'SKU-1',
        description: 'Item',
        quantity: Quantity.of(10, 'CX'),
        unitPrice: Money.ofCents(Math.round(total.cents / 10)),
        total,
      },
    ],
    total,
  });
  invoice.check(
    { purchaseOrders: [], suppliers: [], products: [], postedInvoices: [], payments: [], receipts: [], capturedInvoices: [] },
    [{ id: 'NAO_CATALOGADA', run: () => divergences }],
  );
  invoice.markProposed();
  const route = routeDivergences(divergences, total, { paymentBlocked: options.supplierBlocked ?? false });
  const level = options.level ?? route.level;
  const proposal = Proposal.register({
    classification: options.classification ?? invoice.classification,
    dockAction: options.dockAction ?? DockAction.receive(),
    level,
    amountAtRisk: AmountAtRisk.of(Money.ofCents(options.riskCents ?? 0), total),
    justification: 'E4: caixa cobrada como unidade; recebe',
  });
  proposal.awaitApproval();
  return {
    invoice,
    proposal,
    title: Title.post({ invoiceAccessKey: key, amount: total, dueOn: '2026-12-10' }),
    route: { ...route, level },
    approval: null,
    supplierBlocked: options.supplierBlocked ?? false,
  };
}

/** #41 O Clef falso: conta as chamadas e responde o que o teste mandar. */
export class FakeClef implements Clef {
  readonly modelVersion: string;
  readonly calls: ClefInput[] = [];

  constructor(
    private readonly answer: (input: ClefInput, signal: AbortSignal) => Promise<unknown> = async () => ({
      response: { outcome: 'approve', confidence: 0.97, reason: 'A conversão pelo fator 4 fecha com a ordem' },
    }),
    modelVersion = 'clef-teste-v1',
  ) {
    this.modelVersion = modelVersion;
  }

  ask(input: ClefInput, signal: AbortSignal): Promise<unknown> {
    this.calls.push(input);
    return this.answer(input, signal);
  }
}
