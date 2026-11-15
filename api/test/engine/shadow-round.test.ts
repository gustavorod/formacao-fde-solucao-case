// #41 AC-1 A rodada em modo sombra: grava o que faria, não aprova, é idempotente e conta na rodada do Cron.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryApprovalStore } from '../../src/approval/store.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { tick } from '../../src/cron/tick.js';
import { RULE_VERSION } from '../../src/engine/decision.js';
import { runShadowRound } from '../../src/engine/run.js';
import { MemoryEngineStore } from '../../src/engine/store.js';
import { SupabaseEngineStore } from '../../src/engine/supabase-store.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { caseFile, FakeClef } from './support.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#41 AC-1 modo sombra', () => {
  it('nunca aprova: a proposta segue aguardando a pessoa e nada é gravado em approvals', async () => {
    const files = [caseFile(), caseFile({ riskCents: 1_500 })];
    const approvals = new MemoryApprovalStore(files);
    const saveDecision = vi.spyOn(approvals, 'saveDecision');
    const store = new MemoryEngineStore();

    await runShadowRound({ approvals, store, clef: new FakeClef() });

    expect(store.decisions.map((d) => d.outcome)).toEqual(['approve', 'approve']);
    expect(store.decisions.every((d) => d.mode === 'shadow')).toBe(true);
    expect(saveDecision).not.toHaveBeenCalled();
    expect((await approvals.listAwaiting()).map((f) => f.proposal.state)).toEqual([
      'aguardando_aprovacao',
      'aguardando_aprovacao',
    ]);
  });

  it('a nota sem E4 não é avaliada', async () => {
    const store = new MemoryEngineStore();
    const clef = new FakeClef();
    const round = await runShadowRound({
      approvals: new MemoryApprovalStore([caseFile({ withoutE4: true, extra: ['E3'] })]),
      store,
      clef,
    });
    expect(round.evaluated).toBe(0);
    expect(clef.calls).toHaveLength(0);
  });

  it('o teto de chamadas ao Clef deixa o resto para a próxima rodada, sem decisão gravada', async () => {
    const store = new MemoryEngineStore();
    const files = [caseFile({ riskCents: 1_500 }), caseFile({ riskCents: 1_500 }), caseFile({ riskCents: 1_500 })];
    const approvals = new MemoryApprovalStore(files);
    const first = await runShadowRound({ approvals, store, clef: new FakeClef(), clefLimit: 2 });
    expect(first).toMatchObject({ evaluated: 2, clefCalls: 2, deferred: 1 });
    const second = await runShadowRound({ approvals, store, clef: new FakeClef(), clefLimit: 2 });
    expect(second).toMatchObject({ evaluated: 1, clefCalls: 1, deferred: 0 });
  });
});

describe('#41 idempotência', () => {
  it('a segunda rodada não reavalia nem chama o Clef de novo para a mesma versão e modo', async () => {
    const approvals = new MemoryApprovalStore([caseFile(), caseFile({ riskCents: 1_500 }), caseFile({ supplierBlocked: true })]);
    const store = new MemoryEngineStore();
    const first = await runShadowRound({ approvals, store, clef: new FakeClef() });
    const clef = new FakeClef();
    const second = await runShadowRound({ approvals, store, clef });
    expect(first.evaluated).toBe(3);
    expect(second.evaluated).toBe(0);
    expect(clef.calls).toHaveLength(0);
    expect(store.decisions).toHaveLength(3);
  });

  it('com uma versão nova do Clef, só o que o Clef decidiu volta a ser avaliado', async () => {
    const approvals = new MemoryApprovalStore([caseFile(), caseFile({ riskCents: 1_500 })]);
    const store = new MemoryEngineStore();
    await runShadowRound({ approvals, store, clef: new FakeClef() });
    const next = new FakeClef(undefined, 'clef-teste-v2');
    const round = await runShadowRound({ approvals, store, clef: next });
    expect(round.evaluated).toBe(1);
    expect(next.calls).toHaveLength(1);
  });
});

describe('#41 a loja no Supabase', () => {
  const ENV = { url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake' };

  it('grava em engine_decisions ligada à proposta, lê o limite do nível e não toca em approvals nem em proposals', async () => {
    const file = caseFile({ riskCents: 1_500 });
    const fake = new FakePostgrest({
      proposals: [{ id: 7, invoice_access_key: file.invoice.accessKey }],
      engine_settings: [
        { level: 'analista', delegation_enabled: false, confidence_threshold: 0.98, clef_timeout_ms: 20, updated_at: 'x' },
      ],
    });
    const rest = new SupabaseRest({ ...ENV, fetch: fake.fetch });
    const store = new SupabaseEngineStore(rest);
    const clef = new FakeClef((_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abortado')))));

    const round = await runShadowRound({ approvals: { listAwaiting: async () => [file] }, store, clef });

    expect(round).toMatchObject({ evaluated: 1, clefFailed: 1 });
    expect(fake.rows('engine_decisions')).toEqual([
      expect.objectContaining({
        proposal_id: 7,
        invoice_access_key: file.invoice.accessKey,
        outcome: 'pending',
        decided_by: 'person',
        confidence: null,
        mode: 'shadow',
        pending_reason: 'clef_failed',
        error: 'ClefTimeoutError',
        model_version: 'clef-teste-v1',
      }),
    ]);
    const writes = fake.requests.filter((r) => r.method !== 'GET').map((r) => new URL(r.url).pathname);
    expect(writes).toEqual(['/rest/v1/engine_decisions']);

    const again = await runShadowRound({ approvals: { listAwaiting: async () => [file] }, store, clef });
    expect(again.evaluated).toBe(0);
    expect(fake.rows('engine_decisions')).toHaveLength(1);
  });

  it('a gravação repetida é ignorada pela unicidade (proposta, versão, modo)', async () => {
    const file = caseFile();
    const fake = new FakePostgrest({ proposals: [{ id: 3, invoice_access_key: file.invoice.accessKey }] });
    const store = new SupabaseEngineStore(new SupabaseRest({ ...ENV, fetch: fake.fetch }));
    const decision = {
      invoiceAccessKey: file.invoice.accessKey, outcome: 'approve', decidedBy: 'rule', confidence: null,
      modelVersion: RULE_VERSION, mode: 'shadow', reason: 'fecha', pendingReason: null, error: null, latencyMs: null,
    } as const;
    expect(await store.record([decision])).toBe(1);
    expect(await store.record([decision])).toBe(0);
    expect(await store.settings('analista')).toMatchObject({ confidenceThreshold: 0.98, clefTimeoutMs: 3000 });
  });
});

describe('#41 o motor na rodada do Cron', () => {
  const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
  const ai = (run: () => Promise<unknown>) => ({ run }) as unknown as Ai;
  const answer = async () => ({ response: { outcome: 'approve', confidence: 0.99, reason: 'fecha' } });

  it('as avaliadas entram em automation_runs.engine_evaluated, e a segunda rodada não reavalia', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, { ...ENV, ai: ai(answer) });
    const decisions = fake.rows('engine_decisions');
    const [run] = fake.rows('automation_runs');
    expect(decisions.length).toBeGreaterThan(0);
    expect(run?.engine_evaluated).toBe(decisions.length);
    expect(decisions.every((d) => d.mode === 'shadow')).toBe(true);

    // #41 Modo sombra: nenhuma proposta avaliada pelo motor foi aprovada.
    const evaluated = new Set(decisions.map((d) => d.proposal_id));
    const approvedIds = new Set(fake.rows('approvals').map((a) => a.proposal_id));
    expect([...evaluated].some((id) => approvedIds.has(id))).toBe(false);
    expect(fake.rows('proposals').filter((p) => evaluated.has(p.id)).every((p) => p.state === 'aguardando_aprovacao')).toBe(true);

    await tick({ cron: '*/15 * * * *' }, { ...ENV, ai: ai(answer) });
    expect(fake.rows('automation_runs')[1]?.engine_evaluated).toBe(0);
    expect(fake.rows('engine_decisions')).toHaveLength(decisions.length);
  });

  it('se o motor falha, a rodada segue ok e conta zero', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/rest/v1/engine_decisions')
        ? Promise.resolve(new Response('{"message":"relation does not exist"}', { status: 404 }))
        : fake.fetch(input, init),
    );
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await expect(tick({ cron: '*/15 * * * *' }, { ...ENV, ai: ai(answer) })).resolves.toMatchObject({ seen: expect.any(Number) });
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', engine_evaluated: 0 });
    expect(logs.some((l) => l.includes('motor de decisão indisponível (HTTP 404)'))).toBe(true);
  });

  it('sem o binding do Workers AI, o motor é pulado e a rodada segue', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick({ cron: '*/15 * * * *' }, ENV);
    expect(fake.rows('engine_decisions')).toHaveLength(0);
    expect(fake.rows('automation_runs')[0]).toMatchObject({ status: 'ok', engine_evaluated: 0 });
  });
});
