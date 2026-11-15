// #42 O motor em modo delegado: com a delegação do analista ligada, aprova pela regra ou pelo Clef no limite, pelo
// mesmo caminho da aprovação da pessoa; abaixo do limite, na falha do Clef e na diretoria ou bloqueio, fica com a
// pessoa. Desligada, o modo sombra da #41.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AlreadyDecidedError,
  EngineApprovalRefusedError,
  MemoryApprovalStore,
  type ApprovalStore,
  type CaseFile,
} from '../../src/approval/store.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { tick } from '../../src/cron/tick.js';
import { ENGINE_APPROVER } from '../../src/domain/approval.js';
import { ClefTimeoutError } from '../../src/engine/clef.js';
import { DEFAULT_ANALYST_SETTINGS, RULE_VERSION } from '../../src/engine/decision.js';
import { applyThreshold, runDelegatedRound, runEngineRound, type DelegatedDeps } from '../../src/engine/delegated.js';
import { MemoryEngineStore } from '../../src/engine/store.js';
import { approvalRoutes } from '../../src/http/approval.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { caseFile, FakeClef } from './support.js';

const TODAY = '2026-11-17';
const ON = { ...DEFAULT_ANALYST_SETTINGS, delegationEnabled: true };

/** #42 O Clef falso com a resposta dada. */
const clefAnswering = (outcome: 'approve' | 'refuse', confidence: number) =>
  new FakeClef(async () => ({ response: { outcome, confidence, reason: 'A conversão pelo fator 4 fecha com a ordem' } }));

/** #42 A proposta que a regra não decide (há valor em risco): só o Clef decide. */
const clefCase = () => caseFile({ riskCents: 1_500 });

function deps(over: Partial<DelegatedDeps> & { approvals: DelegatedDeps['approvals'] }): DelegatedDeps {
  return { store: new MemoryEngineStore([ON]), clef: clefAnswering('approve', 0.99), today: () => TODAY, ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#42 AC-1 e AC-4 a delegação ligada aprova', () => {
  it('a regra fecha a conta: o motor aprova, com a versão da regra e sem confiança, e o título vai à lista do dia', async () => {
    const file = caseFile();
    const approvals = new MemoryApprovalStore([file]);
    const store = new MemoryEngineStore([ON]);
    const clef = clefAnswering('approve', 0.99);

    const round = await runEngineRound(deps({ approvals, store, clef }));

    expect(round).toMatchObject({ mode: 'delegated', evaluated: 1, approved: 1, keptWithPerson: 0, clefCalls: 0 });
    // #42 Com a regra decidindo, o Clef não é chamado nem para medir.
    expect(clef.calls).toHaveLength(0);
    expect(store.decisions).toEqual([
      expect.objectContaining({ mode: 'delegated', role: 'cascade', outcome: 'approve', decidedBy: 'rule', confidence: null, modelVersion: RULE_VERSION, pendingReason: null, recommendation: null }),
    ]);
    const saved = await approvals.find(file.invoice.accessKey);
    expect(saved?.approval).toMatchObject({
      approver: ENGINE_APPROVER,
      approverLevel: 'analista',
      decidedOn: TODAY,
      engine: { decisionId: store.decisions[0]?.id, confidence: null, modelVersion: RULE_VERSION },
    });
    expect(saved?.approval?.dockAction.kind).toBe('receber');
    expect(saved?.proposal.state).toBe('aprovada');
    expect(saved?.title.state).toBe('na_lista_do_dia');
    expect((await approvals.listDecidedOn(TODAY)).map((f) => f.invoice.accessKey)).toEqual([file.invoice.accessKey]);
  });

  it('o Clef com confiança de 0,98 ou mais aprova, com a confiança e a versão do Clef', async () => {
    const file = clefCase();
    const approvals = new MemoryApprovalStore([file]);
    const store = new MemoryEngineStore([ON]);

    const round = await runEngineRound(deps({ approvals, store, clef: clefAnswering('approve', 0.98) }));

    expect(round).toMatchObject({ mode: 'delegated', approved: 1, clefCalls: 1 });
    expect(store.decisions[0]).toMatchObject({ mode: 'delegated', outcome: 'approve', decidedBy: 'clef', confidence: 0.98, modelVersion: 'clef-teste-v1' });
    const saved = await approvals.find(file.invoice.accessKey);
    expect(saved?.approval?.engine).toEqual({ decisionId: store.decisions[0]?.id, confidence: 0.98, modelVersion: 'clef-teste-v1' });
    expect(saved?.title.state).toBe('na_lista_do_dia');
  });

  it('a lista do dia mostra o título aprovado pelo motor ("Aprovado pelo motor")', async () => {
    const file = caseFile();
    const approvals = new MemoryApprovalStore([file]);
    await runEngineRound(deps({ approvals }));

    const response = await approvalRoutes(
      new Request(`https://api.test/api/hoje?dia=${TODAY}`),
      { email: 'ana@jachegou.test' } as never,
      { APPROVER_LEVELS: JSON.stringify({ 'ana@jachegou.test': 'analista' }) } as never,
      { store: approvals },
    );
    const body = (await response?.json()) as { items: { invoiceAccessKey: string; approver: string; approvedBy: string }[] };
    expect(body.items).toEqual([
      expect.objectContaining({ invoiceAccessKey: file.invoice.accessKey, approver: 'motor', approvedBy: 'engine' }),
    ]);
  });
});

describe('#42 AC-2 abaixo do limite fica com a pessoa, com a recomendação', () => {
  it('Clef 0,97 que aprovaria: below_confidence, recomenda aprovar e diz o porquê; nada em approvals', async () => {
    const file = clefCase();
    const approvals = new MemoryApprovalStore([file]);
    const saveDecision = vi.spyOn(approvals, 'saveDecision');
    const store = new MemoryEngineStore([ON]);

    const round = await runEngineRound(deps({ approvals, store, clef: clefAnswering('approve', 0.97) }));

    expect(round).toMatchObject({ mode: 'delegated', evaluated: 1, approved: 0, belowConfidence: 1 });
    expect(store.decisions[0]).toMatchObject({
      outcome: 'pending',
      pendingReason: 'below_confidence',
      decidedBy: 'clef',
      confidence: 0.97,
      recommendation: 'approve',
    });
    expect(store.decisions[0]?.reason).toMatch(/abaixo do limite 0\.98: o motor recomenda aprovar.*fator 4/);
    expect(saveDecision).not.toHaveBeenCalled();
    expect((await approvals.find(file.invoice.accessKey))?.proposal.state).toBe('aguardando_aprovacao');
  });

  it('a recomendação de recusar também fica com a pessoa', () => {
    const decision = applyThreshold(
      {
        invoiceAccessKey: 'k', outcome: 'refuse', decidedBy: 'clef', confidence: 0.6, modelVersion: 'v', mode: 'delegated',
        role: 'cascade', reason: 'não fecha', pendingReason: null, error: null, latencyMs: 1,
      },
      0.98,
    );
    expect(decision).toMatchObject({ outcome: 'pending', pendingReason: 'below_confidence', recommendation: 'refuse' });
    expect(decision.reason).toMatch(/recomenda recusar/);
  });

  it('a proposta mostra a decisão delegada com a recomendação', async () => {
    const file = clefCase();
    const approvals = new MemoryApprovalStore([file]);
    const store = new MemoryEngineStore([ON]);
    await runEngineRound(deps({ approvals, store, clef: clefAnswering('approve', 0.9) }));

    const response = await approvalRoutes(
      new Request(`https://api.test/api/propostas/${file.invoice.accessKey}`),
      { email: 'ana@jachegou.test' } as never,
      { APPROVER_LEVELS: JSON.stringify({ 'ana@jachegou.test': 'analista' }) } as never,
      { store: approvals, engine: store },
    );
    const body = (await response?.json()) as { engine: Record<string, unknown> };
    expect(body.engine).toMatchObject({ mode: 'delegated', pending_reason: 'below_confidence', recommendation: 'approve', confidence: 0.9 });
  });
});

describe('#42 a falha do Clef no modo delegado', () => {
  it('fica com a pessoa e a falha é registrada (classe do erro e latência); a próxima rodada não aprova', async () => {
    const file = clefCase();
    const approvals = new MemoryApprovalStore([file]);
    const saveDecision = vi.spyOn(approvals, 'saveDecision');
    const store = new MemoryEngineStore([ON]);
    const timeout = new FakeClef(async () => {
      throw new ClefTimeoutError(8000);
    });

    const round = await runEngineRound(deps({ approvals, store, clef: timeout }));

    expect(round).toMatchObject({ mode: 'delegated', evaluated: 1, approved: 0, clefFailed: 1 });
    expect(store.decisions[0]).toMatchObject({
      mode: 'delegated', outcome: 'pending', decidedBy: 'person', pendingReason: 'clef_failed', error: 'ClefTimeoutError', confidence: null,
    });
    expect(store.decisions[0]?.latencyMs).toEqual(expect.any(Number));
    expect(saveDecision).not.toHaveBeenCalled();

    // #42 A falha deixa a proposta com a pessoa: a rodada seguinte não volta ao Clef nem aprova.
    const clef = clefAnswering('approve', 0.99);
    const next = await runEngineRound(deps({ approvals, store, clef }));
    expect(next).toMatchObject({ mode: 'delegated', evaluated: 0, approved: 0, clefCalls: 0 });
    expect(clef.calls).toHaveLength(0);
  });
});

describe('#42 AC-3 diretoria e bloqueio nunca', () => {
  it.each([
    ['diretoria', caseFile({ level: 'diretoria' }), 'level_not_delegable'],
    ['bloqueio', caseFile({ level: 'bloqueio' }), 'level_not_delegable'],
    ['fornecedor bloqueado', caseFile({ supplierBlocked: true }), 'outside_criteria'],
  ] as const)('%s: fica com a pessoa, sem Clef e sem aprovação', async (_, file, reason) => {
    const approvals = new MemoryApprovalStore([file]);
    const saveDecision = vi.spyOn(approvals, 'saveDecision');
    const store = new MemoryEngineStore([ON]);
    const clef = clefAnswering('approve', 0.99);

    const round = await runEngineRound(deps({ approvals, store, clef }));

    expect(round).toMatchObject({ mode: 'delegated', evaluated: 1, approved: 0 });
    expect(store.decisions[0]).toMatchObject({ outcome: 'pending', decidedBy: 'person', pendingReason: reason });
    expect(clef.calls).toHaveLength(0);
    expect(saveDecision).not.toHaveBeenCalled();
  });
});

describe('#42 AC-5 a delegação desligada', () => {
  it('roda o modo sombra da #41: grava o que faria e nada em approvals', async () => {
    const files = [caseFile(), clefCase()];
    const approvals = new MemoryApprovalStore(files);
    const saveDecision = vi.spyOn(approvals, 'saveDecision');
    const store = new MemoryEngineStore([DEFAULT_ANALYST_SETTINGS]);

    const round = await runEngineRound(deps({ approvals, store }));

    expect(round.mode).toBe('shadow');
    expect(round).toMatchObject({ evaluated: 2 });
    expect(store.decisions.length).toBeGreaterThan(0);
    expect(store.decisions.every((d) => d.mode === 'shadow')).toBe(true);
    expect(saveDecision).not.toHaveBeenCalled();
    expect((await approvals.listAwaiting()).map((f) => f.invoice.accessKey).sort()).toEqual(files.map((f) => f.invoice.accessKey).sort());
  });
});

describe('#42 a pessoa decide antes do motor', () => {
  /** #42 A fila foi lida com a proposta aguardando; na hora de aprovar, a pessoa já decidiu. */
  function decidedMeanwhile(file: CaseFile): Pick<ApprovalStore, 'listAwaiting' | 'find' | 'saveDecision'> {
    const decided = new MemoryApprovalStore([caseFile({ key: file.invoice.accessKey })]);
    return {
      listAwaiting: async () => [file],
      find: async (key) => {
        const current = await decided.find(key);
        if (!current) return null;
        return {
          ...current,
          approval: { approver: 'ana@jachegou.test', approverLevel: 'analista', dockAction: current.proposal.dockAction, justification: 'ok', decidedOn: TODAY },
        };
      },
      saveDecision: vi.fn(),
    };
  }

  it('a decisão do motor fica gravada, mas ele não aprova: a proposta é da pessoa', async () => {
    const file = caseFile();
    const approvals = decidedMeanwhile(file);
    const store = new MemoryEngineStore([ON]);

    const round = await runDelegatedRound(deps({ approvals, store }), ON);

    expect(round).toMatchObject({ evaluated: 1, approved: 0, keptWithPerson: 1, errors: 0 });
    expect(store.decisions[0]).toMatchObject({ outcome: 'approve', mode: 'delegated' });
    expect(approvals.saveDecision).not.toHaveBeenCalled();
  });

  it('a corrida que o banco decide (AlreadyDecidedError) não duplica nem derruba a rodada', async () => {
    const [lost, won] = [caseFile(), caseFile()];
    const memory = new MemoryApprovalStore([lost, won]);
    const saved: string[] = [];
    const approvals: DelegatedDeps['approvals'] = {
      listAwaiting: () => memory.listAwaiting(),
      find: (key) => memory.find(key),
      saveDecision: async (f) => {
        if (f.invoice.accessKey === lost.invoice.accessKey) throw new AlreadyDecidedError(f.invoice.accessKey);
        saved.push(f.invoice.accessKey);
      },
    };

    const round = await runDelegatedRound(deps({ approvals }), ON);

    expect(round).toMatchObject({ evaluated: 2, approved: 1, keptWithPerson: 1, errors: 0 });
    expect(saved).toEqual([won.invoice.accessKey]);
  });

  it('a delegação desligada no meio da rodada fica com a pessoa; o erro de programação é registrado e a rodada segue', async () => {
    const [off, mismatch, ok] = [caseFile(), caseFile(), caseFile()];
    const memory = new MemoryApprovalStore([off, mismatch, ok]);
    const approvals: DelegatedDeps['approvals'] = {
      listAwaiting: () => memory.listAwaiting(),
      find: (key) => memory.find(key),
      saveDecision: async (f) => {
        if (f.invoice.accessKey === off.invoice.accessKey) throw new EngineApprovalRefusedError(f.invoice.accessKey, 'delegation_off');
        if (f.invoice.accessKey === mismatch.invoice.accessKey) throw new EngineApprovalRefusedError(f.invoice.accessKey, 'mismatch');
        await memory.saveDecision(f);
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const round = await runDelegatedRound(deps({ approvals }), ON);

    expect(round).toMatchObject({ evaluated: 3, approved: 1, keptWithPerson: 1, errors: 1, firstError: 'EngineApprovalRefusedError' });
    expect((await memory.find(ok.invoice.accessKey))?.approval?.approver).toBe('motor');
  });

  it('o teto de decisões por rodada deixa o resto para a próxima, sem linha gravada', async () => {
    const approvals = new MemoryApprovalStore([caseFile(), caseFile(), caseFile()]);
    const store = new MemoryEngineStore([ON]);
    const first = await runEngineRound({ ...deps({ approvals, store }), decisionLimit: 2 });
    expect(first).toMatchObject({ mode: 'delegated', evaluated: 2, approved: 2, deferred: 1 });
    expect(store.decisions).toHaveLength(2);
    const next = await runEngineRound({ ...deps({ approvals, store }), decisionLimit: 2 });
    expect(next).toMatchObject({ evaluated: 1, approved: 1, deferred: 0 });
  });

  it('a segunda rodada não decide de novo o que a primeira já gravou', async () => {
    const approvals = new MemoryApprovalStore([clefCase()]);
    const store = new MemoryEngineStore([ON]);
    await runEngineRound(deps({ approvals, store, clef: clefAnswering('approve', 0.5) }));
    const clef = clefAnswering('approve', 0.99);
    const again = await runEngineRound(deps({ approvals, store, clef }));
    expect(again).toMatchObject({ evaluated: 0, approved: 0 });
    expect(clef.calls).toHaveLength(0);
  });
});

describe('#42 a aprovação do motor no Supabase', () => {
  const ENV = { url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake' };

  /** #42 O PostgREST que recusa o POST em approvals com o erro dado. */
  function refusing(code: string, message: string) {
    const file = caseFile();
    const fake = new FakePostgrest({ proposals: [{ id: 7, invoice_access_key: file.invoice.accessKey }] });
    const fetch = (input: string, init?: RequestInit) =>
      input.includes('/rest/v1/approvals') && init?.method === 'POST'
        ? Promise.resolve(new Response(JSON.stringify({ code, details: null, hint: null, message }), { status: code === '23505' ? 409 : 400 }))
        : fake.fetch(input, init);
    const store = new SupabaseApprovalStore(new SupabaseRest({ ...ENV, fetch }));
    const approval = {
      approver: 'motor', approverLevel: 'analista', dockAction: file.proposal.dockAction, justification: 'ok', decidedOn: TODAY,
      engine: { decisionId: 1, confidence: null, modelVersion: RULE_VERSION },
    } as const;
    return { fake, save: () => store.saveDecision({ ...file, approval }) };
  }

  it('23505 em approvals_proposal_key é a corrida: AlreadyDecidedError, nada muda', async () => {
    const { fake, save } = refusing('23505', 'duplicate key value violates unique constraint "approvals_proposal_key"');
    await expect(save()).rejects.toBeInstanceOf(AlreadyDecidedError);
    expect(fake.rows('titles')).toHaveLength(0);
  });

  it('23514 da delegação desligada: fica com a pessoa', async () => {
    const { save } = refusing('23514', 'delegação do nível analista desligada: o motor não aprova');
    await expect(save()).rejects.toMatchObject({ name: 'EngineApprovalRefusedError', reason: 'delegation_off' });
  });

  it.each([
    ['23514', 'aprovação do motor não bate com a engine_decision 1'],
    ['23503', 'engine_decision 1 não existe'],
  ])('%s de não bater: erro de programação (mismatch)', async (code, message) => {
    const { save } = refusing(code, message);
    await expect(save()).rejects.toMatchObject({ name: 'EngineApprovalRefusedError', reason: 'mismatch' });
  });

  it('grava a decisão do motor na aprovação e nunca manda approved_by', async () => {
    const file = caseFile();
    const fake = new FakePostgrest({ proposals: [{ id: 7, invoice_access_key: file.invoice.accessKey }] });
    const store = new SupabaseApprovalStore(new SupabaseRest({ ...ENV, fetch: fake.fetch }));
    await store.saveDecision({
      ...file,
      approval: {
        approver: 'motor', approverLevel: 'analista', dockAction: file.proposal.dockAction, justification: 'ok', decidedOn: TODAY,
        engine: { decisionId: 3, confidence: 0.99, modelVersion: 'clef-teste-v1' },
      },
    });
    const [row] = fake.rows('approvals');
    expect(row).toMatchObject({ proposal_id: 7, approver: 'motor', approver_level: 'analista', engine_decision_id: 3, engine_confidence: 0.99, engine_model_version: 'clef-teste-v1', decided_on: TODAY });
    expect(row).not.toHaveProperty('approved_by');
  });
});

describe('#42 o motor delegado na rodada do Cron', () => {
  const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
  const ai = (run: () => Promise<unknown>) => ({ run }) as unknown as Ai;
  const answer = async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } });
  const settings = (delegation: boolean) => [
    { level: 'analista', delegation_enabled: delegation, confidence_threshold: 0.98, clef_timeout_ms: 8000 },
  ];

  it('ligada: aprova as E4 elegíveis do kit, o título vai à lista do dia e conta em engine_approved', async () => {
    const fake = new FakePostgrest({ ...kitTables(), engine_settings: settings(true) });
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, { ...ENV, ai: ai(answer) });

    const decisions = fake.rows('engine_decisions');
    expect(decisions.every((d) => d.mode === 'delegated' && d.role === 'cascade')).toBe(true);
    const approving = decisions.filter((d) => d.outcome === 'approve');
    expect(approving.length).toBeGreaterThan(0);
    const engineApprovals = fake.rows('approvals').filter((a) => a.approver === 'motor');
    expect(engineApprovals).toHaveLength(approving.length);
    for (const a of engineApprovals) {
      const d = approving.find((x) => x.id === a.engine_decision_id);
      expect(d).toBeDefined();
      expect(a).toMatchObject({ proposal_id: d?.proposal_id, approver_level: 'analista', engine_confidence: d?.confidence, engine_model_version: d?.model_version });
      expect(a).not.toHaveProperty('approved_by');
      const key = fake.rows('proposals').find((p) => p.id === a.proposal_id)?.invoice_access_key;
      expect(fake.rows('titles').find((t) => t.invoice_access_key === key)?.state).toBe('na_lista_do_dia');
      expect(fake.rows('proposals').find((p) => p.id === a.proposal_id)?.state).toBe('aprovada');
    }
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', engine_approved: engineApprovals.length, engine_evaluated: decisions.length });

    // #42 A segunda rodada não aprova de novo: as aprovadas saíram da fila.
    await tick({ cron: '*/15 * * * *' }, { ...ENV, ai: ai(answer) });
    expect(fake.rows('approvals').filter((a) => a.approver === 'motor')).toHaveLength(engineApprovals.length);
    expect(fake.rows('automation_runs')[1]).toMatchObject({ engine_approved: 0 });
  });

  it('desligada: só a sombra, nada do motor em approvals e engine_approved zero', async () => {
    const fake = new FakePostgrest({ ...kitTables(), engine_settings: settings(false) });
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, { ...ENV, ai: ai(answer) });

    expect(fake.rows('engine_decisions').length).toBeGreaterThan(0);
    expect(fake.rows('engine_decisions').every((d) => d.mode === 'shadow')).toBe(true);
    expect(fake.rows('approvals').some((a) => a.approver === 'motor' || a.engine_decision_id !== undefined)).toBe(false);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', engine_approved: 0 });
  });
});
