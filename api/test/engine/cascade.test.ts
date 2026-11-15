// #41 A cascata do motor em modo sombra: exclusões e regra antes do Clef, e o Clef que falha vai para a pessoa.
import { describe, expect, it } from 'vitest';
import { DockAction, Quantity } from '../../src/domain/index.js';
import { askClef, isCandidate, screen } from '../../src/engine/cascade.js';
import { parseClefAnswer, ClefInvalidResponseError, CLEF_MODEL_VERSION } from '../../src/engine/clef.js';
import { DEFAULT_ANALYST_SETTINGS, RULE_VERSION, type EngineSettings } from '../../src/engine/decision.js';
import { MemoryEngineStore } from '../../src/engine/store.js';
import { runShadowRound } from '../../src/engine/run.js';
import { caseFile, FakeClef } from './support.js';

const SETTINGS: EngineSettings = DEFAULT_ANALYST_SETTINGS;

/**
 * #41 Roda a rodada sobre um processo só e devolve a decisão da cascata, a medição do Clef (quando houver) e o
 * Clef falso.
 */
async function evaluateOne(file: ReturnType<typeof caseFile>, clef = new FakeClef()) {
  const store = new MemoryEngineStore();
  await runShadowRound({ approvals: { listAwaiting: async () => [file] }, store, clef });
  const decision = store.decisions.find((d) => d.role === 'cascade');
  const benchmark = store.decisions.find((d) => d.role === 'benchmark');
  return { decision, benchmark, clef, store };
}

describe('#41 AC-2 a regra decide primeiro', () => {
  it('a conversão que fecha com valor em risco zero é aprovada pela regra; o Clef só é medido ao lado', async () => {
    const clef = new FakeClef(async () => ({ response: { outcome: 'refuse', confidence: 0.99, reason: 'recusaria' } }));
    const { decision, benchmark } = await evaluateOne(caseFile({ invoicedUnits: 40, orderedUnits: 40 }), clef);
    // #41 AC-2 Quem decide é a regra, mesmo com o Clef discordando: a medição não muda a cascata.
    expect(decision).toMatchObject({
      outcome: 'approve',
      decidedBy: 'rule',
      confidence: null,
      modelVersion: RULE_VERSION,
      mode: 'shadow',
      role: 'cascade',
      pendingReason: null,
    });
    expect(decision?.reason).toContain('SKU-1 40 UN pelo fator 4');
    expect(clef.calls).toHaveLength(1);
    expect(benchmark).toMatchObject({
      role: 'benchmark',
      outcome: 'refuse',
      decidedBy: 'clef',
      confidence: 0.99,
      modelVersion: 'clef-teste-v1',
    });
  });

  it('a medição do Clef que falha grava clef_failed só na medição; a decisão da regra fica', async () => {
    const clef = new FakeClef(async () => {
      throw new Error('caiu');
    });
    const { decision, benchmark, store } = await evaluateOne(caseFile(), clef);
    expect(decision).toMatchObject({ role: 'cascade', outcome: 'approve', decidedBy: 'rule' });
    expect(benchmark).toMatchObject({
      role: 'benchmark',
      outcome: 'pending',
      decidedBy: 'person',
      pendingReason: 'clef_failed',
      error: 'Error',
      modelVersion: 'clef-teste-v1',
    });
    expect(benchmark?.reason).toMatch(/decisão da cascata não muda/);
    expect(store.decisions).toHaveLength(2);
  });

  it('com valor em risco, a regra não decide e o Clef é chamado com a evidência da conversão', async () => {
    const { decision, clef } = await evaluateOne(caseFile({ riskCents: 1_500 }));
    expect(clef.calls).toHaveLength(1);
    expect(clef.calls[0]?.evidence.some((e) => e.source === 'erp_cadastro' && e.description.includes('fator de caixa 4'))).toBe(true);
    expect(clef.calls[0]).toMatchObject({ classification: 'E4', level: 'analista', reguaLine: 5, amountAtRisk: 'R$ 15,00' });
    expect(decision).toMatchObject({ role: 'cascade', outcome: 'approve', decidedBy: 'clef', confidence: 0.97, modelVersion: 'clef-teste-v1' });
    expect(decision?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('com a quantidade convertida diferente da ordem, a regra não decide e o Clef é chamado', async () => {
    const { clef } = await evaluateOne(caseFile({ invoicedUnits: 48, orderedUnits: 40 }));
    expect(clef.calls).toHaveLength(1);
  });

  it('com a evidência do cadastro ilegível, a regra não decide e o Clef é chamado', async () => {
    const { clef } = await evaluateOne(caseFile({ unreadableEvidence: true }));
    expect(clef.calls).toHaveLength(1);
  });

  it('no modo sombra o Clef abaixo do limite fica gravado como ele decidiu, com a confiança', async () => {
    const clef = new FakeClef(async () => ({ response: '{"outcome":"refuse","confidence":0.6,"reason":"A ordem pede 40 UN"}' }));
    const { decision } = await evaluateOne(caseFile({ riskCents: 1_500 }), clef);
    expect(decision).toMatchObject({ outcome: 'refuse', decidedBy: 'clef', confidence: 0.6, pendingReason: null });
  });
});

describe('#41 AC-3 as exclusões nunca chegam ao Clef', () => {
  const cases = [
    ['duplicidade (E6)', caseFile({ extra: ['E6'], riskCents: 1_500 }), 'outside_criteria', /Duplicidade/],
    ['fornecedor bloqueado', caseFile({ supplierBlocked: true, riskCents: 1_500 }), 'outside_criteria', /bloqueado/],
    ['nota acima de R$ 100 mil', caseFile({ totalCents: 10_000_001, riskCents: 1_500 }), 'outside_criteria', /R\$ 100 mil/],
    [
      'pedido de alterar',
      caseFile({
        riskCents: 1_500,
        dockAction: DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(1, 'CX'), disposition: 'devolver' }]),
      }),
      'outside_criteria',
      /Pedido de alterar/,
    ],
    ['acima de R$ 20 mil', caseFile({ totalCents: 2_000_001, riskCents: 1_500 }), 'outside_criteria', /R\$ 20 mil/],
    ['E4 junto de outra exceção', caseFile({ extra: ['E1'], riskCents: 1_500 }), 'outside_criteria', /E1/],
  ] as const;

  for (const [name, file, pendingReason, reason] of cases) {
    it(`${name}: pendente com a pessoa, sem chamar o Clef, nem para medir`, async () => {
      const { decision, benchmark, clef } = await evaluateOne(file);
      expect(clef.calls).toHaveLength(0);
      expect(benchmark).toBeUndefined();
      expect(decision).toMatchObject({
        outcome: 'pending',
        decidedBy: 'person',
        confidence: null,
        pendingReason,
        modelVersion: RULE_VERSION,
      });
      expect(decision?.reason).toMatch(reason);
    });
  }

  it('a exclusão vale mesmo quando a conversão fecha: a regra não aprova a duplicidade', () => {
    expect(screen(caseFile({ extra: ['E6'] }), 'shadow')).toMatchObject({ outcome: 'pending', decidedBy: 'person' });
  });
});

describe('#149 AC-3 diretoria e bloqueio nunca são aprovados', () => {
  for (const level of ['diretoria', 'bloqueio'] as const) {
    it(`nível ${level}, com a conversão que fecha: pendente, nunca approve, sem Clef`, async () => {
      const { decision, clef } = await evaluateOne(caseFile({ level }));
      expect(clef.calls).toHaveLength(0);
      expect(decision?.outcome).toBe('pending');
      expect(decision?.pendingReason).toBe('level_not_delegable');
    });
  }

  it('o Clef que sempre aprovaria não aprova nenhuma de diretoria ou bloqueio', async () => {
    const store = new MemoryEngineStore();
    const files = [
      caseFile({ level: 'diretoria', riskCents: 1_500 }),
      caseFile({ level: 'bloqueio', riskCents: 1_500 }),
      caseFile({ supplierBlocked: true, riskCents: 1_500 }),
      caseFile({ extra: ['E6'], riskCents: 1_500 }),
    ];
    await runShadowRound({ approvals: { listAwaiting: async () => files }, store, clef: new FakeClef() });
    expect(store.decisions).toHaveLength(4);
    expect(store.decisions.every((d) => d.outcome !== 'approve')).toBe(true);
  });
});

describe('#41 AC-6 o Clef que falha ou demora vai para a pessoa', () => {
  it('tempo esgotado: clef_failed com a classe do erro e a latência, e o pedido é abortado', async () => {
    let aborted = false;
    const clef = new FakeClef(
      (_input, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const decision = await askClef(caseFile({ riskCents: 1_500 }), { clef, settings: { ...SETTINGS, clefTimeoutMs: 20 }, mode: 'shadow' });
    expect(decision).toMatchObject({
      outcome: 'pending',
      decidedBy: 'person',
      confidence: null,
      pendingReason: 'clef_failed',
      error: 'ClefTimeoutError',
      modelVersion: 'clef-teste-v1',
    });
    expect(decision.latencyMs).toBeGreaterThanOrEqual(15);
    expect(aborted).toBe(true);
  });

  it('falha do Workers AI: clef_failed com a classe do erro, sem a mensagem', async () => {
    class InferenceUpstreamError extends Error {
      override name = 'InferenceUpstreamError';
    }
    const clef = new FakeClef(async () => {
      throw new InferenceUpstreamError('detalhe que não pode ir para o banco');
    });
    const decision = await askClef(caseFile({ riskCents: 1_500 }), { clef, settings: SETTINGS, mode: 'shadow' });
    expect(decision).toMatchObject({ pendingReason: 'clef_failed', error: 'InferenceUpstreamError' });
    expect(JSON.stringify(decision)).not.toContain('detalhe');
  });

  it('resposta fora do formato: clef_failed com ClefInvalidResponseError', async () => {
    const clef = new FakeClef(async () => ({ response: '{"outcome":"talvez","confidence":2}' }));
    const decision = await askClef(caseFile({ riskCents: 1_500 }), { clef, settings: SETTINGS, mode: 'shadow' });
    expect(decision).toMatchObject({ pendingReason: 'clef_failed', error: 'ClefInvalidResponseError' });
  });

  it('um Clef que falha não trava a rodada: as outras propostas seguem avaliadas', async () => {
    let n = 0;
    const clef = new FakeClef(async () => {
      n += 1;
      if (n === 1) throw new Error('caiu');
      return { response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } };
    });
    const store = new MemoryEngineStore();
    const files = [caseFile({ riskCents: 1_500 }), caseFile({ riskCents: 1_500 }), caseFile()];
    const round = await runShadowRound({ approvals: { listAwaiting: async () => files }, store, clef });
    // #41 Duas chamadas da cascata e uma de medição (a da regra); a primeira falha e as outras seguem.
    expect(round).toMatchObject({ evaluated: 3, measured: 1, clefCalls: 3, clefFailed: 1 });
    const cascade = store.decisions.filter((d) => d.role === 'cascade');
    expect(cascade.map((d) => d.pendingReason ?? d.decidedBy).sort()).toEqual(['clef', 'clef_failed', 'rule']);
  });
});

describe('#41 a resposta do Clef é conferida', () => {
  it('aceita o objeto ou o texto JSON dentro de response', () => {
    expect(parseClefAnswer({ response: { outcome: 'refuse', confidence: 1, reason: ' ok ' } })).toEqual({
      outcome: 'refuse',
      confidence: 1,
      reason: 'ok',
    });
    expect(parseClefAnswer({ response: '{"outcome":"approve","confidence":0,"reason":"x"}' }).outcome).toBe('approve');
  });

  for (const bad of [
    { response: 'não é json' },
    { response: { outcome: 'pending', confidence: 0.5, reason: 'x' } },
    { response: { outcome: 'approve', confidence: -0.1, reason: 'x' } },
    { response: { outcome: 'approve', confidence: '0.9', reason: 'x' } },
    { response: { outcome: 'approve', confidence: 0.9, reason: '  ' } },
    null,
  ]) {
    it(`recusa ${JSON.stringify(bad)}`, () => {
      expect(() => parseClefAnswer(bad)).toThrow(ClefInvalidResponseError);
    });
  }

  it('a versão do Clef nomeia o modelo do Workers AI', () => {
    expect(CLEF_MODEL_VERSION).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });
});

describe('#41 quem entra no motor', () => {
  it('só a proposta que aguarda a pessoa e tem a E4', () => {
    expect(isCandidate(caseFile())).toBe(true);
    expect(isCandidate(caseFile({ withoutE4: true, extra: ['E1'] }))).toBe(false);
  });
});
