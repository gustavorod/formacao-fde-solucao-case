import { describe, expect, it } from 'vitest';
import type { DockActionMessage, Published } from '../../src/connectors/ports.js';
import { AWAITING_INSTRUCTION, dockBoard, type DockDecision, type DockInvoice } from '../../src/dock/dock-board.js';
import { DockAction, Quantity } from '../../src/domain/index.js';
import { kitNotes, kitNotesOf } from './kit-invoices.js';

const DATE = '2026-11-11';

// #72 As notas do kit no formato que a fonte da doca entrega.
const invoices: DockInvoice[] = kitNotes().map((n) => ({
  accessKey: n.chave,
  number: String(n.numero),
  supplierId: n.fornecedor_id,
  store: n.destino,
  issuedOn: n.data_emissao,
  items: n.itens.map((i) => ({ sku: i.sku, description: i.descricao, quantity: { amount: i.quantidade, unit: i.unidade } })),
}));

const cd03 = kitNotesOf('CD-03', DATE);
const [first, second, third] = cd03.map((n) => n.chave) as [string, string, string];

let nextId = 1;
const publish = (invoiceAccessKey: string, action: DockAction): Published<DockActionMessage> => ({
  invoiceAccessKey,
  action,
  id: nextId++,
  publishedAt: '2026-11-11T09:00:00.000Z',
});

describe('dockBoard: a doca de um destino num dia (#72)', () => {
  it('#43/AC-4 lista só as notas do dia do destino, ordenadas pelo número, e os destinos do dia', () => {
    const board = dockBoard({ invoices, published: [], destination: 'CD-03', date: DATE });

    expect(board.destination).toBe('CD-03');
    expect(board.date).toBe(DATE);
    expect(board.rows.map((r) => r.invoiceAccessKey)).toEqual([first, second, third]);
    expect(board.rows.map((r) => r.number)).toEqual(cd03.map((n) => String(n.numero)));
    expect(board.destinations).toEqual(
      [...new Set(kitNotes().filter((n) => n.data_emissao === DATE && n.destino.startsWith('CD-')).map((n) => n.destino))].sort(),
    );
  });

  it('#43/AC-1 nota com ação publicada mostra a ação para o Recebimento', () => {
    const board = dockBoard({ invoices, published: [publish(first, DockAction.receive())], destination: 'CD-03', date: DATE });

    expect(board.rows[0]?.status).toEqual({ kind: 'acao', action: { kind: 'receber' }, publishedAt: '2026-11-11T09:00:00.000Z' });
  });

  it('#43/AC-1 com mais de uma proposta publicada para a nota, vale a de maior id', () => {
    const published = [publish(first, DockAction.refuse()), publish(first, DockAction.receive())].reverse();
    const board = dockBoard({ invoices, published, destination: 'CD-03', date: DATE });

    expect(board.rows[0]?.status).toMatchObject({ kind: 'acao', action: { kind: 'receber' } });
  });

  it('#43/AC-2 receber parcial leva os itens a segurar e a devolver, com quantidade e unidade', () => {
    const action = DockAction.partial([
      { sku: 'SKU-1025', quantity: Quantity.of(32, 'CX'), disposition: 'segurar' },
      { sku: 'SKU-1026', quantity: Quantity.of(64, 'UN'), disposition: 'devolver' },
    ]);
    const board = dockBoard({ invoices, published: [publish(first, action)], destination: 'CD-03', date: DATE });

    expect(board.rows[0]?.status).toMatchObject({
      kind: 'acao',
      action: {
        kind: 'receber_parcial',
        lines: [
          { sku: 'SKU-1025', quantity: { amount: 32, unit: 'CX' }, disposition: 'segurar' },
          { sku: 'SKU-1026', quantity: { amount: 64, unit: 'UN' }, disposition: 'devolver' },
        ],
      },
    });
  });

  it('#43/AC-3 nota do kit sem publicação aparece como aguardando aprovação, nunca como receber', () => {
    const board = dockBoard({ invoices, published: [publish(first, DockAction.receive())], destination: 'CD-03', date: DATE });

    const waiting = board.rows.filter((r) => r.invoiceAccessKey !== first);
    expect(waiting).toHaveLength(2);
    for (const row of waiting) {
      expect(row.status).toEqual({ kind: 'aguardando_aprovacao', instrucao: AWAITING_INSTRUCTION });
    }
    expect(AWAITING_INSTRUCTION).toBe('Aguardando aprovação, não descarregue');
    expect(board.awaiting).toBe(2);
  });

  it('#43/AC-3 sem nenhuma publicação, nenhuma linha do dia diz receber', () => {
    for (const destination of dockBoard({ invoices, published: [], destination: 'CD-03', date: DATE }).destinations) {
      const board = dockBoard({ invoices, published: [], destination, date: DATE });
      expect(board.awaiting).toBe(board.rows.length);
      expect(board.rows.every((r) => r.status.kind === 'aguardando_aprovacao')).toBe(true);
    }
  });

  it('publicação de nota de outro dia ou destino não aparece', () => {
    const other = kitNotes().find((n) => n.data_emissao !== DATE);
    const board = dockBoard({
      invoices,
      published: other ? [publish(other.chave, DockAction.receive())] : [],
      destination: 'CD-03',
      date: DATE,
    });
    expect(board.awaiting).toBe(3);
  });

  it('#43/AC-4 sem destino, abre no primeiro destino do dia', () => {
    const board = dockBoard({ invoices, published: [], destination: null, date: DATE });
    expect(board.destination).toBe(board.destinations[0]);
    expect(board.rows.length).toBeGreaterThan(0);
  });

  it('dia sem notas devolve doca vazia', () => {
    const board = dockBoard({ invoices, published: [], destination: 'CD-03', date: '2026-12-25' });
    expect(board).toEqual({ destination: 'CD-03', date: '2026-12-25', destinations: [], awaiting: 0, rows: [] });
  });

  it('a linha leva fornecedor e itens da nota', () => {
    const board = dockBoard({ invoices, published: [], destination: 'CD-03', date: DATE });
    const note = cd03[0];
    expect(board.rows[0]?.supplierId).toBe(note?.fornecedor_id);
    expect(board.rows[0]?.items).toEqual(
      note?.itens.map((i) => ({ sku: i.sku, description: i.descricao, quantity: { amount: i.quantidade, unit: i.unidade } })),
    );
  });
});

describe('dockBoard: quem decidiu cada nota (#211)', () => {
  it('traz decidedBy no vocabulário do timeline: a regra, a pessoa pelo e-mail e nulo sem decisão', () => {
    const decisions = new Map<string, DockDecision>([
      [first, { approver: 'regra', approverLevel: 'regra' }],
      [second, { approver: 'ana@jachegou.test', approverLevel: 'analista' }],
    ]);
    const published = [publish(first, DockAction.receive()), publish(second, DockAction.refuse())];
    const board = dockBoard({ invoices, published, decisions, destination: 'CD-03', date: DATE });
    const by = (key: string) => board.rows.find((r) => r.invoiceAccessKey === key)?.decidedBy;
    expect(by(first)).toEqual({ actor: 'rule', actor_name: 'Regra' });
    expect(by(second)).toEqual({ actor: 'person', actor_name: 'ana@jachegou.test' });
    expect(by(third)).toBeNull();
  });

  it('#42 a aprovação do motor (modo delegado) aparece como o motor: actor engine, nome Motor', () => {
    const decisions = new Map<string, DockDecision>([[first, { approver: 'motor', approverLevel: 'analista' }]]);
    const board = dockBoard({ invoices, published: [publish(first, DockAction.receive())], decisions, destination: 'CD-03', date: DATE });
    expect(board.rows.find((r) => r.invoiceAccessKey === first)?.decidedBy).toEqual({ actor: 'engine', actor_name: 'Motor' });
  });

  it('sem o mapa de decisões, toda linha leva decidedBy nulo', () => {
    const board = dockBoard({ invoices, published: [], destination: 'CD-03', date: DATE });
    expect(board.rows.every((r) => r.decidedBy === null)).toBe(true);
  });
});
