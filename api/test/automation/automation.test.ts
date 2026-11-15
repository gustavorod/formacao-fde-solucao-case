// #211 AC-1 e AC-5: a rodada gravada, GET /api/automacao e o timeline[] da proposta.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { SupabaseApprovalStore } from '../../src/approval/supabase-store.js';
import { SupabaseTimelineSource } from '../../src/automation/readers.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { tick } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';
import { kitInvoice } from '../approval/kit.js';

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const env: Env = { ...ENV, ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com' };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const verifier: AccessVerifier = { verify: async (token) => ({ ok: true, identity: { email: token } }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#211 AC-1 o tick grava a rodada', () => {
  it('uma rodada ok vira uma linha com os números, sem dado sensível', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick({ cron: '*/15 * * * *' }, ENV);
    const runs = fake.rows('automation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', error: null });
    expect(runs[0]?.seen).toBeGreaterThan(0);
    expect(runs[0]?.proposed).toBeGreaterThan(0);
    expect(Date.parse(String(runs[0]?.finished_at))).toBeGreaterThanOrEqual(Date.parse(String(runs[0]?.started_at)));
    expect(Object.keys(runs[0] ?? {}).sort()).toEqual([
      'approved_by_rule', 'cadastro_e8', 'checked', 'dock_published', 'duplicates_blocked', 'engine_approved', 'engine_evaluated', 'error', 'failed',
      'finished_at', 'inserted', 'proposed', 'seen', 'started_at', 'status', 'store_published',
    ]);
  });

  it('a rodada que falha também fica gravada, só com a classe do erro, e o erro sobe', async () => {
    const fake = new FakePostgrest(kitTables());
    const failing = (input: string, init?: RequestInit) =>
      input.includes('/invoices') ? Promise.resolve(new Response('{"message":"segredo"}', { status: 500 })) : fake.fetch(input, init);
    vi.stubGlobal('fetch', failing);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(tick({ cron: '*/15 * * * *' }, ENV)).rejects.toThrow();
    const runs = fake.rows('automation_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'SupabaseRestError' });
    expect(JSON.stringify(runs[0])).not.toContain('segredo');
  });

  it('se gravar a rodada falha, o tick segue', async () => {
    const fake = new FakePostgrest(kitTables());
    const noRuns = (input: string, init?: RequestInit) =>
      input.includes('/automation_runs') ? Promise.resolve(new Response('{}', { status: 500 })) : fake.fetch(input, init);
    vi.stubGlobal('fetch', noRuns);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(tick({ cron: '*/15 * * * *' }, ENV)).resolves.toMatchObject({ seen: expect.any(Number) });
  });
});

describe('#211 GET /api/automacao', () => {
  const call = (fake: FakePostgrest, path = '/api/automacao', token: string | null = 'ana@jachegou.test') => {
    vi.stubGlobal('fetch', fake.fetch);
    const headers = new Headers();
    if (token) headers.set('Cf-Access-Jwt-Assertion', token);
    return createWorker({ verifier }).fetch(new Request(`https://worker.test${path}`, { headers }), env, ctx);
  };
  const run = (id: number, startedAt: string, status: 'ok' | 'failed') => ({
    id, started_at: startedAt, finished_at: startedAt, status, seen: 12, inserted: 12, checked: 12, failed: 0,
    proposed: 11, approved_by_rule: 7, cadastro_e8: 0, dock_published: 5, store_published: 0, duplicates_blocked: 0, engine_evaluated: 0, engine_approved: 0, error: null,
  });

  it('exige o Access', async () => {
    const res = await call(new FakePostgrest({}), '/api/automacao', null);
    expect(res.status).toBe(401);
  });

  it('devolve a última rodada, a próxima, o estado, as rodadas (20 no máximo) e os indicadores', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:18:00Z'));
    const runs = Array.from({ length: 25 }, (_, i) => run(i + 1, new Date(Date.parse('2026-11-16T10:15:00Z') - i * 900_000).toISOString(), 'ok'));
    const res = await call(new FakePostgrest({ automation_runs: runs }));
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body.state).toBe('ok');
    expect(body.next).toBe('2026-11-16T10:30:00.000Z');
    expect(body.runs).toHaveLength(20);
    expect(body.last).toMatchObject({ id: 1, status: 'ok', figures: { seen: 12, approvedByRule: 7, dockPublished: 5 } });
    expect(body.indicators.day).toMatchObject({ decided: 0, withoutPersonPct: null });
  });

  it('failed quando a última falhou e stalled quando nada roda há mais de 2 rodadas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:18:00Z'));
    const failed = await (await call(new FakePostgrest({ automation_runs: [run(1, '2026-11-16T10:15:00Z', 'failed')] }))).json();
    expect((failed as { state: string }).state).toBe('failed');
    vi.setSystemTime(new Date('2026-11-16T11:01:00Z'));
    const stalled = await (await call(new FakePostgrest({ automation_runs: [run(1, '2026-11-16T10:15:00Z', 'ok')] }))).json();
    expect((stalled as { state: string }).state).toBe('stalled');
  });

  it('os indicadores saem das decisões gravadas (regra e pessoa)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T15:00:00Z'));
    const fake = new FakePostgrest({
      invoices: [{ access_key: 'A', captured_at: '2026-11-16T13:00:00Z' }, { access_key: 'B', captured_at: '2026-11-16T13:00:00Z' }],
      proposals: [{ id: 1, invoice_access_key: 'A', created_at: 'x' }, { id: 2, invoice_access_key: 'B', created_at: 'x' }],
      approvals: [
        { proposal_id: 1, approver_level: 'regra', approved_at: '2026-11-16T13:01:00Z' },
        { proposal_id: 2, approver_level: 'analista', approved_at: '2026-11-16T14:00:00Z' },
      ],
    });
    const body = (await (await call(fake)).json()) as Record<string, any>;
    expect(body.indicators.day).toEqual({
      date: '2026-11-16', decided: 2, byRule: 1, withoutPersonPct: 50,
      medianSeconds: { withoutPerson: 60, withPerson: 3600 },
    });
  });
});

describe('#211 AC-4 timeline[] na proposta', () => {
  it('vem na ordem, com hora e ator, da captura à decisão da regra', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);
    await captureInvoices(captureDeps);
    await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, wms: captureDeps.wms });
    const key = kitInvoice('NF-036').accessKey; // dentro da tolerância: aprovada pela regra
    const timeline = new SupabaseTimelineSource(rest, new SupabaseDossierSource(rest));
    const worker = createWorker({ verifier, approval: { store: new SupabaseApprovalStore(rest), timeline } });
    const res = await worker.fetch(new Request(`https://worker.test/api/propostas/${key}`, { headers: { 'Cf-Access-Jwt-Assertion': 'ana@jachegou.test' } }), env, ctx);
    const body = (await res.json()) as { timeline: { at: string; kind: string; actor: string; actor_name: string }[] };
    const kinds = body.timeline.map((e) => e.kind);
    expect(kinds.slice(0, 2)).toEqual(['captura', 'conferencia']);
    expect(kinds).toContain('proposta');
    expect(body.timeline.at(-1)).toMatchObject({ kind: 'decisao', actor: 'rule', actor_name: 'Regra' });
    expect(body.timeline.every((e) => e.at && e.actor_name)).toBe(true);
  });

  it('sem fonte de horários, a proposta traz timeline vazia', async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    const { captureDeps } = supabaseConnectors(rest);
    await captureInvoices(captureDeps);
    await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, wms: captureDeps.wms });
    const worker = createWorker({ verifier, approval: { store: new SupabaseApprovalStore(rest) } });
    const res = await worker.fetch(new Request(`https://worker.test/api/propostas/${kitInvoice('NF-036').accessKey}`, { headers: { 'Cf-Access-Jwt-Assertion': 'a' } }), env, ctx);
    expect(((await res.json()) as { timeline: unknown[] }).timeline).toEqual([]);
  });
});
