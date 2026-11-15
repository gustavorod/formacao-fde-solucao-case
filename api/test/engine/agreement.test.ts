// #41 AC-4 e AC-5 O motor ao lado da pessoa: o par motor × pessoa, o campo `engine` da proposta e o relatório.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryApprovalStore } from '../../src/approval/store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { DockAction } from '../../src/domain/index.js';
import { agreementReport, agrees, engineView, mondayOf, personOutcome } from '../../src/engine/agreement.js';
import { RULE_VERSION, type StoredDecision } from '../../src/engine/decision.js';
import { runShadowRound } from '../../src/engine/run.js';
import { MemoryEngineStore, type ProposalOutcomeRow } from '../../src/engine/store.js';
import { SupabaseEngineStore } from '../../src/engine/supabase-store.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { requestedWeeks } from '../../src/http/engine.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { accessKey, caseFile, FakeClef } from './support.js';

const ANALISTA = 'analista@jachegou.test';
const env: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  APPROVER_LEVELS: JSON.stringify({ [ANALISTA]: 'analista' }),
};
const SUPABASE = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** #41 Uma linha gravada do motor, com o padrão da regra que aprova. */
function row(over: Partial<StoredDecision> & Pick<StoredDecision, 'invoiceAccessKey'>): StoredDecision {
  return {
    outcome: 'approve',
    decidedBy: 'rule',
    confidence: null,
    modelVersion: RULE_VERSION,
    mode: 'shadow',
    role: 'cascade',
    reason: 'A conversão fecha',
    pendingReason: null,
    error: null,
    latencyMs: null,
    decidedAt: '2026-11-10T15:00:00.000Z',
    ...over,
  };
}

const clefRow = (key: string, outcome: 'approve' | 'refuse', confidence: number, decidedAt = '2026-11-10T15:00:01.000Z') =>
  row({ invoiceAccessKey: key, outcome, confidence, decidedBy: 'clef', modelVersion: 'clef-v1', role: 'benchmark', decidedAt });

describe('#41 AC-4 o par motor × pessoa', () => {
  it('a decisão da pessoa: aprovada é approve, alterada é refuse, aguardando é nula', () => {
    expect(personOutcome('aprovada')).toBe('approve');
    expect(personOutcome('alterada')).toBe('refuse');
    expect(personOutcome('aguardando_aprovacao')).toBeNull();
  });

  it('concorda quando decidem o mesmo; sem a pessoa ou com o motor pendente, não há par', () => {
    expect(agrees('approve', 'approve')).toBe(true);
    expect(agrees('refuse', 'approve')).toBe(false);
    expect(agrees('approve', null)).toBeNull();
    expect(agrees('pending', 'refuse')).toBeNull();
  });

  it('o engine traz a cascata, a medição do Clef mais recente e o acerto de cada um', () => {
    const key = accessKey();
    const view = engineView(
      [
        row({ invoiceAccessKey: key }),
        clefRow(key, 'refuse', 0.6, '2026-11-10T15:00:01.000Z'),
        clefRow(key, 'approve', 0.97, '2026-11-12T15:00:00.000Z'),
      ],
      'aprovada',
    );
    expect(view).toMatchObject({
      mode: 'shadow',
      outcome: 'approve',
      decided_by: 'rule',
      confidence: null,
      model_version: RULE_VERSION,
      pending_reason: null,
      person_outcome: 'approve',
      agreement: true,
      clef: { outcome: 'approve', confidence: 0.97, model_version: 'clef-v1', agreement: true },
    });
  });

  it('sem decisão da cascata o engine é nulo; com a cascata pendente, o acerto é nulo', () => {
    const key = accessKey();
    expect(engineView([], 'aprovada')).toBeNull();
    const pending = row({ invoiceAccessKey: key, outcome: 'pending', decidedBy: 'person', pendingReason: 'outside_criteria' });
    expect(engineView([pending], 'alterada')).toMatchObject({ agreement: null, person_outcome: 'refuse', clef: null });
  });
});

describe('#41 AC-4 o campo engine na proposta', () => {
  function setup(clefAnswer = { outcome: 'approve', confidence: 0.97, reason: 'A conversão pelo fator 4 fecha' }) {
    const file = caseFile();
    const approvals = new MemoryApprovalStore([file]);
    const engine = new MemoryEngineStore();
    const clef = new FakeClef(async () => ({ response: clefAnswer }));
    const worker = createWorker({ verifier, approval: { store: approvals, engine, today: () => '2026-11-15' } });
    const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
      worker.fetch(
        new Request(`https://worker.test${path}`, {
          method: init.method ?? 'GET',
          headers: { 'Cf-Access-Jwt-Assertion': ANALISTA, 'Content-Type': 'application/json' },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
        env,
        ctx,
      );
    const key = file.invoice.accessKey;
    return { approvals, engine, clef, call, key };
  }

  it('antes do motor, engine é nulo e o resto da proposta não muda', async () => {
    const { call, key } = setup();
    const body = (await (await call(`/api/propostas/${key}`)).json()) as Record<string, unknown>;
    expect(body.engine).toBeNull();
    expect(body).toHaveProperty('timeline');
    expect(body).toHaveProperty('approval', null);
  });

  it('a regra decide, o Clef medido ao lado; a pessoa aprova e o par fica concordou', async () => {
    const { approvals, engine, clef, call, key } = setup();
    await runShadowRound({ approvals, store: engine, clef });
    const before = (await (await call(`/api/propostas/${key}`)).json()) as { engine: Record<string, any> };
    expect(before.engine).toMatchObject({
      outcome: 'approve',
      decided_by: 'rule',
      person_outcome: null,
      agreement: null,
      clef: { outcome: 'approve', confidence: 0.97, agreement: null },
    });

    expect((await call(`/api/propostas/${key}/aprovar`, { method: 'POST' })).status).toBe(200);
    const after = (await (await call(`/api/propostas/${key}`)).json()) as { engine: Record<string, any> };
    expect(after.engine).toMatchObject({ person_outcome: 'approve', agreement: true, clef: { agreement: true } });
  });

  it('a pessoa pede para alterar e o motor aprovaria: o par fica discordou', async () => {
    const { approvals, engine, clef, call, key } = setup();
    await runShadowRound({ approvals, store: engine, clef });
    const res = await call(`/api/propostas/${key}/alterar`, {
      method: 'POST',
      body: { dockAction: DockAction.refuse(), justification: 'Fornecedor mandou caixa errada' },
    });
    expect(res.status).toBe(200);
    const body = (await (await call(`/api/propostas/${key}`)).json()) as { engine: Record<string, any> };
    expect(body.engine).toMatchObject({ person_outcome: 'refuse', agreement: false, clef: { agreement: false } });
  });

  it('um erro ao ler o motor não derruba a proposta: engine vai nulo', async () => {
    const file = caseFile();
    const engine = { forProposal: async () => Promise.reject(new Error('caiu')) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = createWorker({ verifier, approval: { store: new MemoryApprovalStore([file]), engine } });
    const res = await worker.fetch(
      new Request(`https://worker.test/api/propostas/${file.invoice.accessKey}`, { headers: { 'Cf-Access-Jwt-Assertion': ANALISTA } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { engine: unknown }).engine).toBeNull();
  });

  it('a loja no Supabase lê as linhas da nota no modo, com a confiança como número', async () => {
    const key = accessKey();
    const fake = new FakePostgrest({
      engine_decisions: [
        { ...decisionRow(key, 'cascade', 'rule', null, '2026-11-10T15:00:00Z') },
        { ...decisionRow(key, 'benchmark', 'clef', '0.97', '2026-11-10T15:00:01Z') },
        { ...decisionRow(accessKey(), 'cascade', 'rule', null, '2026-11-10T15:00:00Z') },
      ],
    });
    const store = new SupabaseEngineStore(new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }));
    const rows = await store.forProposal(key, 'shadow');
    expect(rows.map((r) => r.role)).toEqual(['cascade', 'benchmark']);
    expect(rows[1]?.confidence).toBe(0.97);
    expect(await store.forProposal('nao-e-chave', 'shadow')).toEqual([]);
  });
});

/** #41 Uma linha de engine_decisions como o PostgREST devolve. */
function decisionRow(key: string, role: 'cascade' | 'benchmark', decidedBy: 'rule' | 'clef' | 'person', confidence: number | string | null, decidedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id: Math.floor(Math.random() * 1e9),
    proposal_id: 1,
    invoice_access_key: key,
    outcome: 'approve',
    decided_by: decidedBy,
    confidence,
    model_version: decidedBy === 'clef' ? 'clef-v1' : RULE_VERSION,
    mode: 'shadow',
    role,
    reason: 'motivo',
    pending_reason: null,
    error: null,
    latency_ms: null,
    decided_at: decidedAt,
    ...extra,
  };
}

describe('#41 AC-5 o relatório de acerto', () => {
  const WEEK = '2026-11-09';
  const proposal = (key: string, state: ProposalOutcomeRow['state'], classification = 'E4'): ProposalOutcomeRow => ({
    invoiceAccessKey: key,
    classification,
    state,
  });

  it('a semana vai de segunda a domingo, no fuso de Brasília', () => {
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');
    expect(mondayOf('2026-11-16')).toBe('2026-11-16');
    // #41 Domingo 23h em Brasília é segunda 2h em UTC: fica no domingo, na semana anterior.
    const key = accessKey();
    const [item] = agreementReport({
      weeks: [WEEK],
      threshold: 0.98,
      decisions: [row({ invoiceAccessKey: key, decidedAt: '2026-11-16T02:00:00.000Z' })],
      proposals: [proposal(key, 'aguardando_aprovacao')],
    });
    expect(item).toMatchObject({ week: WEEK, evaluated: 1 });
  });

  it('semana vazia: uma linha da E4 com zeros e as taxas nulas (sem divisão por zero)', () => {
    expect(agreementReport({ weeks: [WEEK], threshold: 0.98, decisions: [], proposals: [] })).toEqual([
      {
        week: WEEK,
        classification: 'E4',
        evaluated: 0,
        excluded: 0,
        decided_by_person: 0,
        agreement: 0,
        agreement_rate: null,
        at_or_above_threshold: 0,
        agreement_rate_at_threshold: null,
        clef_failed: 0,
      },
    ]);
  });

  it('conta cada número sobre as linhas combinadas, e só a E4', () => {
    const [a, b, c, d, e, f] = Array.from({ length: 6 }, () => accessKey());
    const decisions = [
      // a: regra aprova, Clef 0,99 aprova, pessoa aprova: acerto da cascata e do Clef no limite.
      row({ invoiceAccessKey: a! }),
      clefRow(a!, 'approve', 0.99),
      // b: regra aprova, Clef 0,98 recusa (igual ao limite), pessoa altera: erro da cascata, acerto do Clef.
      row({ invoiceAccessKey: b! }),
      clefRow(b!, 'refuse', 0.98),
      // c: o Clef decide na cascata com 0,90 (abaixo do limite) e aprova; pessoa aprova.
      row({ invoiceAccessKey: c!, decidedBy: 'clef', confidence: 0.9, modelVersion: 'clef-v1' }),
      // d: exclusão, pendente com a pessoa; a pessoa aprova: só em `excluded`, fora das contas de acerto.
      row({ invoiceAccessKey: d!, outcome: 'pending', decidedBy: 'person', pendingReason: 'outside_criteria' }),
      // e: regra aprova e Clef 0,99, mas a pessoa ainda não decidiu.
      row({ invoiceAccessKey: e! }),
      clefRow(e!, 'approve', 0.99),
      // f: a proposta é E6: fora do relatório.
      row({ invoiceAccessKey: f!, outcome: 'pending', decidedBy: 'person', pendingReason: 'outside_criteria' }),
    ];
    const proposals = [
      proposal(a!, 'aprovada'),
      proposal(b!, 'alterada'),
      proposal(c!, 'aprovada'),
      proposal(d!, 'aprovada'),
      proposal(e!, 'aguardando_aprovacao'),
      proposal(f!, 'aprovada', 'E6'),
    ];
    const items = agreementReport({ weeks: [WEEK, '2026-11-16'], threshold: 0.98, decisions, proposals });
    expect(items).toEqual([
      {
        week: WEEK,
        classification: 'E4',
        evaluated: 4,
        excluded: 1,
        decided_by_person: 3,
        agreement: 2,
        agreement_rate: 2 / 3,
        at_or_above_threshold: 3,
        agreement_rate_at_threshold: 1,
        clef_failed: 0,
      },
      {
        week: '2026-11-16',
        classification: 'E4',
        evaluated: 0,
        excluded: 0,
        decided_by_person: 0,
        agreement: 0,
        agreement_rate: null,
        at_or_above_threshold: 0,
        agreement_rate_at_threshold: null,
        clef_failed: 0,
      },
    ]);
  });

  it('as exclusões não diluem o acerto: cinco E4 elegíveis certas e cinco de R$ 50 mil aprovadas pela pessoa dão 1', () => {
    const eligible = Array.from({ length: 5 }, () => accessKey());
    const outside = Array.from({ length: 5 }, () => accessKey());
    const decisions = [
      ...eligible.map((k) => row({ invoiceAccessKey: k })),
      ...outside.map((k) => row({ invoiceAccessKey: k, outcome: 'pending', decidedBy: 'person', pendingReason: 'outside_criteria' })),
      row({ invoiceAccessKey: accessKey(), outcome: 'pending', decidedBy: 'person', pendingReason: 'level_not_delegable' }),
    ];
    const proposals = [...eligible, ...outside].map((k) => proposal(k, 'aprovada'));
    proposals.push(proposal(decisions.at(-1)!.invoiceAccessKey, 'aprovada'));
    const [item] = agreementReport({ weeks: [WEEK], threshold: 0.98, decisions, proposals });
    expect(item).toMatchObject({ evaluated: 5, excluded: 6, decided_by_person: 5, agreement: 5, agreement_rate: 1 });
  });

  it('a medição que falhou (clef_failed) não conta como confiança', () => {
    const key = accessKey();
    const failed = row({
      invoiceAccessKey: key, outcome: 'pending', decidedBy: 'person', pendingReason: 'clef_failed',
      role: 'benchmark', modelVersion: 'clef-v1', error: 'ClefTimeoutError',
    });
    const [item] = agreementReport({
      weeks: [WEEK], threshold: 0.98, decisions: [row({ invoiceAccessKey: key }), failed], proposals: [proposal(key, 'aprovada')],
    });
    expect(item).toMatchObject({ evaluated: 1, decided_by_person: 1, agreement: 1, at_or_above_threshold: 0, agreement_rate_at_threshold: null, clef_failed: 1 });
  });

  it('clef_failed conta a proposta sem resposta do Clef; a que já tem resposta (de outra versão) não conta', () => {
    const [failedCascade, answeredLater] = [accessKey(), accessKey()];
    const failure = (key: string, role: 'cascade' | 'benchmark', modelVersion: string) =>
      row({ invoiceAccessKey: key, outcome: 'pending', decidedBy: 'person', pendingReason: 'clef_failed', role, modelVersion, error: 'ClefTimeoutError' });
    const decisions = [
      failure(failedCascade, 'cascade', 'clef-v1'),
      row({ invoiceAccessKey: answeredLater }),
      failure(answeredLater, 'benchmark', 'clef-v1'),
      { ...clefRow(answeredLater, 'approve', 0.99), modelVersion: 'clef-v2' },
    ];
    const proposals = [proposal(failedCascade, 'aguardando_aprovacao'), proposal(answeredLater, 'aguardando_aprovacao')];
    const [item] = agreementReport({ weeks: [WEEK], threshold: 0.98, decisions, proposals });
    expect(item).toMatchObject({ evaluated: 2, clef_failed: 1, at_or_above_threshold: 1 });
  });
});

describe('#41 AC-5 o período pedido', () => {
  const TODAY = '2026-11-15';
  it('sem parâmetro, as últimas 8 semanas com a atual', () => {
    const r = requestedWeeks(new URLSearchParams(), TODAY);
    expect(r).toEqual({ weeks: expect.arrayContaining(['2026-09-21', '2026-11-09']) });
    expect('weeks' in r && r.weeks).toHaveLength(8);
  });
  it('semana é a semana do dia; de e ate cobrem as semanas do primeiro ao último', () => {
    expect(requestedWeeks(new URLSearchParams('semana=2026-11-12'), TODAY)).toEqual({ weeks: ['2026-11-09'] });
    expect(requestedWeeks(new URLSearchParams('de=2026-11-01&ate=2026-11-10'), TODAY)).toEqual({
      weeks: ['2026-10-26', '2026-11-02', '2026-11-09'],
    });
  });
  it('recusa dia inválido, período invertido, os dois jeitos juntos e mais de 53 semanas', () => {
    for (const q of ['semana=2026-02-30', 'de=2026-11-10&ate=2026-11-01', 'semana=2026-11-12&de=2026-11-01', 'de=2026-11-01', 'de=2024-01-01&ate=2026-11-01']) {
      expect(requestedWeeks(new URLSearchParams(q), TODAY)).toHaveProperty('error');
    }
  });
});

describe('#41 AC-5 GET /api/motor/acerto', () => {
  const call = (fake: FakePostgrest, path: string, token: string | null = ANALISTA, withSupabase = true) => {
    vi.stubGlobal('fetch', fake.fetch);
    const headers = new Headers();
    if (token) headers.set('Cf-Access-Jwt-Assertion', token);
    return createWorker({ verifier }).fetch(new Request(`https://worker.test${path}`, { headers }), withSupabase ? { ...env, ...SUPABASE } : env, ctx);
  };

  it('exige o Access', async () => {
    expect((await call(new FakePostgrest({}), '/api/motor/acerto', null)).status).toBe(401);
  });

  it('sem o Supabase, 503; com o período inválido, 400', async () => {
    expect((await call(new FakePostgrest({}), '/api/motor/acerto', ANALISTA, false)).status).toBe(503);
    const res = await call(new FakePostgrest({}), '/api/motor/acerto?semana=ontem');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'periodo_invalido' });
  });

  it('lê as decisões, as propostas e o limite do analista, e devolve a semana pedida só com a E4', async () => {
    const [a, b, old, next] = [accessKey(), accessKey(), accessKey(), accessKey()];
    const fake = new FakePostgrest({
      engine_decisions: [
        decisionRow(a, 'cascade', 'rule', null, '2026-11-10T12:00:00Z'),
        decisionRow(a, 'benchmark', 'clef', 0.97, '2026-11-10T12:00:01Z'),
        decisionRow(b, 'cascade', 'person', null, '2026-11-11T12:00:00Z', { outcome: 'pending', pending_reason: 'outside_criteria' }),
        // #41 Da semana anterior: fora do período pedido.
        decisionRow(old, 'cascade', 'rule', null, '2026-11-03T12:00:00Z'),
        // #41 Segunda seguinte, 00:00 em Brasília: já fora do período (o limite de cima é excluído).
        decisionRow(next, 'cascade', 'rule', null, '2026-11-16T03:00:00Z'),
      ],
      proposals: [
        { id: 1, invoice_access_key: a, classification: 'E4', state: 'aprovada' },
        { id: 2, invoice_access_key: b, classification: 'E6', state: 'aprovada' },
        { id: 3, invoice_access_key: old, classification: 'E4', state: 'aprovada' },
        { id: 4, invoice_access_key: next, classification: 'E4', state: 'aprovada' },
      ],
      engine_settings: [{ level: 'analista', delegation_enabled: false, confidence_threshold: 0.95, clef_timeout_ms: 3000 }],
    });
    const res = await call(fake, '/api/motor/acerto?semana=2026-11-12');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: 'shadow',
      level: 'analista',
      threshold: 0.95,
      from: '2026-11-09',
      to: '2026-11-15',
      items: [
        {
          week: '2026-11-09',
          classification: 'E4',
          evaluated: 1,
          excluded: 0,
          decided_by_person: 1,
          agreement: 1,
          agreement_rate: 1,
          at_or_above_threshold: 1,
          agreement_rate_at_threshold: 1,
          clef_failed: 0,
        },
      ],
    });
    const read = fake.requests.find((r) => r.url.includes('/engine_decisions'));
    expect(new URL(read?.url ?? '').searchParams.get('decided_at')).toBe('gte.2026-11-09T03:00:00.000Z');
    // #41 Período fechado: até a meia-noite da segunda seguinte, em Brasília, excluída.
    expect(new URL(read?.url ?? '').searchParams.get('and')).toBe('(decided_at.lt."2026-11-16T03:00:00.000Z")');
  });

  it('se o Supabase falha, 502 sem o corpo do erro', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"message":"segredo"}', { status: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': ANALISTA });
    const res = await createWorker({ verifier }).fetch(new Request('https://worker.test/api/motor/acerto', { headers }), { ...env, ...SUPABASE }, ctx);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('segredo');
  });
});
