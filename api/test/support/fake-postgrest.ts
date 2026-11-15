// Fake do PostgREST em memória, servido por um fetch injetado (#59). Cobre o que o cliente usa:
// #59 select paginado por Range, filtros eq, insert com on_conflict e resolution, PATCH e DELETE.
import type { FetchFn } from '../../src/connectors/supabase-rest.js';

type Row = Record<string, unknown>;

export class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  readonly requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  private nextId = 1;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables.set(t, rows.map((r) => ({ ...r })));
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  readonly fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const method = init.method ?? 'GET';
    this.requests.push({ method, url: input, headers });
    const params = url.searchParams;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const rows = this.tables.get(table) ?? [];
    this.tables.set(table, rows);
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (method === 'GET') {
      let result = rows.filter((r) => this.matches(r, params));
      const order = params.get('order');
      if (order) {
        const cols = order.split(',');
        result = [...result].sort((a, b) => {
          for (const spec of cols) {
            const [c = '', dir] = spec.split('.');
            const x = String(a[c] ?? '');
            const y = String(b[c] ?? '');
            if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
          }
          return 0;
        });
      }
      const limit = params.get('limit');
      if (limit) result = result.slice(0, Number(limit));
      const range = headers.Range;
      if (range) {
        const [from, to] = range.split('-').map(Number) as [number, number];
        result = result.slice(from, to + 1);
      }
      const select = params.get('select');
      if (select && select !== '*') {
        const cols = select.split(',');
        result = result.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return json(200, result);
    }
    if (method === 'POST') {
      const conflict = params.get('on_conflict')?.split(',');
      const prefer = headers.Prefer ?? '';
      const out: Row[] = [];
      for (const incoming of body as Row[]) {
        const existing = conflict ? rows.find((r) => conflict.every((c) => r[c] === incoming[c])) : undefined;
        if (existing) {
          if (prefer.includes('resolution=ignore-duplicates')) continue;
          if (prefer.includes('resolution=merge-duplicates')) {
            Object.assign(existing, incoming);
            out.push(existing);
            continue;
          }
          return json(409, { message: 'duplicate key' });
        }
        const row: Row = { ...this.defaults(table), ...incoming };
        rows.push(row);
        out.push(row);
      }
      return json(201, out);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => this.matches(r, params));
      for (const r of hit) Object.assign(r, body as Row);
      return json(200, hit);
    }
    if (method === 'DELETE') {
      this.tables.set(table, rows.filter((r) => !this.matches(r, params)));
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  };

  private defaults(table: string): Row {
    const now = new Date().toISOString();
    // #140 A fila de devolução: o estado inicial e as colunas que a migração deixa nulas.
    if (table === 'outbox_return_notes') {
      return {
        id: this.nextId++,
        published_at: now,
        status: 'pendente',
        nfe_number: null,
        emitted_by: null,
        emitted_at: null,
        cancel_justification: null,
        cancelled_by: null,
        cancelled_at: null,
      };
    }
    if (table.startsWith('outbox_')) return { id: this.nextId++, published_at: now };
    if (table === 'invoices') return { captured_at: now, classification: null, checked_at: null };
    // #63 As colunas com default da migração do domínio e da aprovação.
    if (table === 'proposals') return { id: this.nextId++, state: 'registrada', regua_line: null, created_at: now };
    if (table === 'approvals') return { id: this.nextId++, dock_action: null, decided_on: null, approved_at: now };
    if (table === 'titles') return { state: 'lancado', updated_at: now };
    // #41 engine_decisions: a hora da decisão, o papel da linha e as tentativas têm default na migração.
    if (table === 'engine_decisions') {
      return { id: this.nextId++, role: 'cascade', decided_at: now, similar_cases: [], delegation_id: null, attempts: 1, last_attempt_at: now };
    }
    return {};
  }

  private matches(row: Row, params: URLSearchParams): boolean {
    for (const [col, expr] of params) {
      if (['select', 'order', 'on_conflict', 'limit'].includes(col)) continue;
      // #71 e #63: in.(a,"b") do PostgREST, valores separados por vírgula, aspas opcionais.
      const inList = /^in\.\((.*)\)$/.exec(expr);
      if (inList) {
        const values = (inList[1] ?? '').split(',').map((v) => v.replace(/^"(.*)"$/, '$1'));
        if (!values.includes(String(row[col]))) return false;
        continue;
      }
      // #56 not.is.null: o filtro que pega todas as linhas de uma coluna not null.
      if (expr === 'not.is.null') {
        if (row[col] === null || row[col] === undefined) return false;
        continue;
      }
      // #41 and=(col.lt."v"): o limite de cima de um período, quando a coluna já tem outro filtro.
      if (col === 'and') {
        const inner = /^\((.*)\)$/.exec(expr)?.[1] ?? '';
        for (const part of inner.split(',')) {
          const m = /^([a-z_]+)\.lt\."?([^"]*)"?$/.exec(part);
          if (!m) throw new Error(`fake: filtro and não suportado ${part}`);
          if (!(Date.parse(String(row[m[1] ?? ''])) < Date.parse(m[2] ?? ''))) return false;
        }
        continue;
      }
      if (expr.startsWith('gte.')) {
        if (Date.parse(String(row[col])) < Date.parse(expr.slice(4))) return false;
        continue;
      }
      if (!expr.startsWith('eq.')) throw new Error(`fake: filtro não suportado ${col}=${expr}`);
      if (String(row[col]) !== expr.slice(3)) return false;
    }
    return true;
  }
}
