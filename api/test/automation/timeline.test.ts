// #211 AC-4 A linha do tempo da nota, montada do que o banco guarda.
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/automation/timeline.js';

const base = { capturedAt: '2026-11-16T13:00:00Z', checkedAt: '2026-11-16T13:00:05Z', proposedAt: '2026-11-16T13:00:06Z' };
const file = (over: Record<string, unknown>) => ({
  classification: 'E4', level: 'analista', line: 5, dockAction: { kind: 'receber' }, state: 'aprovada', approval: null, ...over,
}) as never;

describe('#211 buildTimeline', () => {
  it('uma nota que andou até a doca: ordem, hora e quem fez', () => {
    const t = buildTimeline(
      file({ approval: { approver: 'ana@jachegou.com.br', approverLevel: 'analista', dockAction: { kind: 'receber' } } }),
      { ...base, dossierAt: '2026-11-16T13:01:00Z', decidedAt: '2026-11-16T13:12:00Z', publishedAt: '2026-11-16T13:15:00Z', publishedTo: 'doca' },
    );
    expect(t.map((e) => [e.kind, e.actor, e.actor_name])).toEqual([
      ['captura', 'system', 'Automático'],
      ['conferencia', 'rule', 'Regra'],
      ['proposta', 'rule', 'Regra'],
      ['dossie', 'claude', 'Claude'],
      ['decisao', 'person', 'ana@jachegou.com.br'],
      ['publicacao', 'system', 'Automático'],
    ]);
    expect(t.map((e) => e.step)).toEqual([
      'Capturada na SEFAZ',
      'Conferida: E4',
      'Encaminhada à analista (linha 5)',
      'Dossiê escrito',
      'Aprovada: receber',
      'Ação publicada na doca',
    ]);
    expect(t.every((e, i) => i === 0 || e.at >= (t[i - 1] as { at: string }).at)).toBe(true);
  });
  it('#42 aprovada pelo motor (modo delegado): o ator da decisão é o motor', () => {
    const t = buildTimeline(
      file({ approval: { approver: 'motor', approverLevel: 'analista', dockAction: { kind: 'receber' } } }),
      { ...base, decidedAt: '2026-11-16T13:05:00Z' },
    );
    expect(t.at(-1)).toMatchObject({ kind: 'decisao', actor: 'engine', actor_name: 'Motor', step: 'Aprovada pelo motor: receber' });
  });
  it('aprovada pela regra: o ator da decisão é a regra', () => {
    const t = buildTimeline(
      file({ classification: 'MATCH', level: 'regra', line: 6, approval: { approver: 'regra', approverLevel: 'regra', dockAction: { kind: 'receber' } } }),
      { ...base, decidedAt: '2026-11-16T13:00:06Z' },
    );
    const last = t[t.length - 1];
    expect(last).toMatchObject({ kind: 'decisao', actor: 'rule', actor_name: 'Regra', step: 'Aprovada pela regra: receber' });
    expect(t[1]?.step).toBe('Conferida: sem divergência');
  });
  it('alterada pela pessoa e publicada na loja', () => {
    const t = buildTimeline(
      file({ state: 'alterada', approval: { approver: 'bia@jachegou.com.br', approverLevel: 'coordenacao', dockAction: { kind: 'recusar' } } }),
      { ...base, decidedAt: '2026-11-16T13:20:00Z', publishedAt: '2026-11-16T13:30:00Z', publishedTo: 'loja' },
    );
    expect(t.map((e) => e.step).slice(-2)).toEqual(['Alterada: recusar', 'Ação publicada no app da loja']);
  });
  it('sem linha da régua, sem o sufixo "(linha N)"', () => {
    const t = buildTimeline(file({ line: null }), base);
    expect(t[2]?.step).toBe('Encaminhada à analista');
  });
  it('sem horário, sem evento', () => {
    expect(buildTimeline(file({}), { capturedAt: base.capturedAt })).toHaveLength(1);
  });
});
