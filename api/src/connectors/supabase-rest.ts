// Cliente mínimo do PostgREST do Supabase, com fetch puro (#59, AC-1). Nunca registra a chave.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type SupabaseRestConfig = {
  readonly url: string;
  readonly secretKey: string;
  readonly fetch?: FetchFn;
  /** #59 Linhas por página no select. */
  readonly pageSize?: number;
  /** #59 REL-1: tempo máximo de cada requisição, em milissegundos. */
  readonly timeoutMs?: number;
};

export type Row = Record<string, unknown>;

/** #59 Filtros no formato do PostgREST: { chave: 'eq.X' }. */
export type Filters = Readonly<Record<string, string>>;

export type SelectOptions = {
  readonly select?: string;
  readonly order?: string;
  readonly filters?: Filters;
  /** #211 Só as primeiras N linhas (uma requisição, sem paginar). */
  readonly limit?: number;
};

export type InsertOptions = {
  /** #59 Colunas da restrição única que decide a duplicada. */
  readonly onConflict?: string;
  /** #59 true: a duplicada é ignorada (resolution=ignore-duplicates). */
  readonly ignoreDuplicates?: boolean;
};

export type RestOperation = 'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'network' | 'parse';

/** #59 Falha do PostgREST. A mensagem diz a operação, a tabela e o status; nunca a chave nem os dados. */
export class SupabaseRestError extends Error {
  constructor(
    readonly operation: RestOperation,
    readonly table: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`supabase-rest: ${operation} em ${table} falhou (HTTP ${status}) ${detail}`.trim());
    this.name = 'SupabaseRestError';
  }
}

/**
 * #42 O código do Postgres (SQLSTATE, ex.: `23505`) e a mensagem que o PostgREST devolve no corpo do erro. O corpo
 * vem cortado em `detail`; o código e a mensagem são lidos à parte, sem depender do JSON inteiro. Nulo quando o
 * erro não veio do banco.
 */
export function postgresErrorOf(error: unknown): { readonly code: string; readonly message: string } | null {
  if (!(error instanceof SupabaseRestError)) return null;
  const code = /"code"\s*:\s*"([0-9A-Z]{5})"/.exec(error.detail)?.[1];
  if (!code) return null;
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(error.detail)?.[1] ?? '';
  return { code, message };
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DETAIL = 300;

export class SupabaseRest {
  private readonly base: string;
  private readonly secretKey: string;
  private readonly doFetch: FetchFn;
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  constructor(config: SupabaseRestConfig) {
    this.base = config.url.replace(/\/+$/, '') + '/rest/v1/';
    this.secretKey = config.secretKey;
    this.doFetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** #59 Lê a tabela inteira, paginando pelo cabeçalho Range. As linhas saem sem tipo: quem lê valida. */
  async select(table: string, options: SelectOptions = {}): Promise<unknown[]> {
    const params = new URLSearchParams({ select: options.select ?? '*' });
    if (options.order) params.set('order', options.order);
    for (const [column, expr] of Object.entries(options.filters ?? {})) params.append(column, expr);
    if (options.limit !== undefined) {
      params.set('limit', String(options.limit));
      return this.request('select', table, 'GET', params, undefined, {});
    }
    const rows: unknown[] = [];
    for (let start = 0; ; start += this.pageSize) {
      const page = await this.request('select', table, 'GET', params, undefined, {
        'Range-Unit': 'items',
        Range: `${start}-${start + this.pageSize - 1}`,
      });
      rows.push(...page);
      if (page.length < this.pageSize) return rows;
    }
  }

  /**
   * #59 Insere e devolve só as linhas que entraram de fato. Com ignoreDuplicates (o padrão), a linha
   * que bate na restrição de onConflict é ignorada sem erro.
   */
  async insert(table: string, rows: readonly Row[], options: InsertOptions = {}): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const params = new URLSearchParams();
    if (options.onConflict) params.set('on_conflict', options.onConflict);
    const prefer = ['return=representation'];
    if (options.ignoreDuplicates ?? true) prefer.push('resolution=ignore-duplicates');
    return this.request('insert', table, 'POST', params, rows, { Prefer: prefer.join(',') });
  }

  /** #59 Insere ou atualiza pela restrição de onConflict (resolution=merge-duplicates). */
  async upsert(table: string, rows: readonly Row[], onConflict: string): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const params = new URLSearchParams({ on_conflict: onConflict });
    return this.request('upsert', table, 'POST', params, rows, {
      Prefer: 'return=representation,resolution=merge-duplicates',
    });
  }

  /** #59 Atualiza as linhas que passam nos filtros. Exige ao menos um filtro. */
  async update(table: string, filters: Filters, patch: Row): Promise<unknown[]> {
    const params = this.requireFilters('update', table, filters);
    return this.request('update', table, 'PATCH', params, patch, { Prefer: 'return=representation' });
  }

  /** #59 Apaga as linhas que passam nos filtros. Exige ao menos um filtro. */
  async delete(table: string, filters: Filters): Promise<void> {
    const params = this.requireFilters('delete', table, filters);
    await this.request('delete', table, 'DELETE', params, undefined, { Prefer: 'return=minimal' });
  }

  private requireFilters(operation: RestOperation, table: string, filters: Filters): URLSearchParams {
    const entries = Object.entries(filters);
    if (entries.length === 0) {
      throw new SupabaseRestError(operation, table, 0, 'sem filtro: recusado para não atingir a tabela inteira');
    }
    return new URLSearchParams(entries);
  }

  private async request(
    operation: RestOperation,
    table: string,
    method: string,
    params: URLSearchParams,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<unknown[]> {
    const headers: Record<string, string> = { apikey: this.secretKey, 'Content-Type': 'application/json', ...extra };
    // #59 Chave nova (sb_...) vai só no apikey; a legada (JWT) também vai no Authorization.
    if (!this.secretKey.startsWith('sb_')) headers.Authorization = `Bearer ${this.secretKey}`;
    const query = params.toString();
    const url = `${this.base}${table}${query ? `?${query}` : ''}`;
    let response: Response;
    let text: string;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      // #59 REL-1: o aborto por tempo e a falha de rede viram o mesmo tipo de erro, sem a chave.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const detail = timedOut ? `sem resposta em ${this.timeoutMs} ms` : 'falha de rede';
      throw new SupabaseRestError('network', table, 0, detail);
    }
    if (!response.ok) {
      throw new SupabaseRestError(operation, table, response.status, text.slice(0, MAX_DETAIL));
    }
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SupabaseRestError('parse', table, response.status, 'a resposta não é JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new SupabaseRestError('parse', table, response.status, 'a resposta não é uma lista');
    }
    return parsed;
  }
}
