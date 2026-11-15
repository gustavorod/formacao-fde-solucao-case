import { SupabaseDuplicatesReader } from "../connectors/duplicates-reader";
import { ErpPayablesConnector } from "../connectors/erp-payables";
import { SupabaseRest } from "../connectors/supabase-rest";
import type { Env } from "../env";
import { authenticate, type AccessVerifier, type Identity } from "./access";
import { MemoryApprovalStore } from "../approval/store";
import { approvalRoutes, type ApprovalDeps } from "./approval";
import { dockHandler, supabaseFromEnv, type DockDeps } from "./dock";
import { listDuplicates, noDuplicates, type DuplicatesReader } from "./duplicates";
import { health } from "./health";
import { me } from "./me";
import { adminRoutes } from "./admin";
import { automation } from "./automation";
import { barredAmount } from "./barred-amount";
import { engineAgreement } from "./engine";
import { returnNoteRoutes, type ReturnNotesDeps } from "./return-notes";

type PublicHandler = () => Response;
type ProtectedHandler = (identity: Identity, request: Request, env: Env) => Response | Promise<Response>;

/** Rotas abertas: não passam pelo Access. Só o `/health`, que a esteira e o monitor chamam (#54). */
const publicRoutes: Record<string, Record<string, PublicHandler>> = {
  "/health": { GET: health },
};

/**
 * Rotas que exigem um JWT válido do Cloudflare Access (#54). A doca lê o Supabase pelas dependências
 * injetadas (#72); as duplicidades também (#31/AC-6).
 */
function protectedRoutes(deps: RouterDeps): Record<string, Record<string, ProtectedHandler>> {
  const dock = dockHandler(deps.dock);
  const storeReceiving = dockHandler(deps.dock, "app_loja");
  const duplicates = deps.duplicates ?? defaultDuplicates;
  return {
    "/me": { GET: me },
    "/api/valor-barrado": { GET: barredAmount },
    "/api/automacao": { GET: automation },
    "/api/motor/acerto": { GET: engineAgreement },
    "/api/doca": { GET: (_identity, request, env) => dock(request, env) },
    "/api/recebimento-loja": { GET: (_identity, request, env) => storeReceiving(request, env) },
    "/api/duplicates": { GET: (_identity, _request, env) => listDuplicates(duplicates(env)) },
  };
}

export interface RouterDeps {
  verifier: AccessVerifier;
  /**
   * #63 A fila de aprovação, a proposta e a lista do dia. Uma função recebe o Env da requisição (as
   * credenciais do Supabase só chegam ali). Sem ela, uma loja vazia em memória.
   */
  approval?: ApprovalDeps | ((env: Env) => ApprovalDeps);
  /** Opcional: sem ele, a doca monta o Supabase do Env (#72). */
  dock?: DockDeps;
  /** #140 A fila de notas de devolução. Padrão: o Supabase do Env. */
  returnNotes?: ReturnNotesDeps;
  /** Leitura das duplicidades (#31/AC-6). Padrão: o Supabase, se o env tem as credenciais. */
  duplicates?: (env: Env) => DuplicatesReader;
}

/** #31/AC-6: com as credenciais do Supabase, lê o banco; sem elas, a lista vazia. */
function defaultDuplicates(env: Env): DuplicatesReader {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return noDuplicates;
  const rest = new SupabaseRest({ url, secretKey });
  return new SupabaseDuplicatesReader(rest, new ErpPayablesConnector(rest));
}

/**
 * Encaminha a requisição pela rota e pelo método. Fora das rotas abertas, o Access vem antes de
 * procurar a rota, então um caminho desconhecido sem token recebe 401, não 404 (#54).
 * Rota desconhecida: a tela (#60), se for um GET ou HEAD fora de `/api/` e os arquivos dela
 * existirem; senão 404. Método não aceito: 405.
 */
export async function route(request: Request, env: Env, deps: RouterDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  const open = own(publicRoutes, pathname);
  if (open) return dispatch(request, open, (handler) => handler());

  const auth = await authenticate(request, env, deps.verifier);
  if ("response" in auth) return auth.response;

  const approval = await approvalRoutes(
    request,
    auth.identity,
    env,
    typeof deps.approval === "function"
      ? deps.approval(env)
      : (deps.approval ?? { store: new MemoryApprovalStore() }),
  );
  if (approval) return approval;

  const admin = await adminRoutes(request, auth.identity, env);
  if (admin) return admin;

  const returnNotes = await returnNoteRoutes(request, auth.identity, env, deps.returnNotes ?? {}, supabaseFromEnv);
  if (returnNotes) return returnNotes;

  const methods = own(protectedRoutes(deps), pathname);
  if (methods) return dispatch(request, methods, (handler) => handler(auth.identity, request, env));
  if (env.ASSETS && isScreenRequest(request.method, pathname)) return env.ASSETS.fetch(request);
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** Um pedido da tela: só leitura, e nunca sob `/api/`, que é da API mesmo quando a rota não existe. */
function isScreenRequest(method: string, pathname: string): boolean {
  const reading = method === "GET" || method === "HEAD";
  const api = pathname === "/api" || pathname.startsWith("/api/");
  return reading && !api;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function dispatch<H>(
  request: Request,
  methods: Record<string, H>,
  run: (handler: H) => Response | Promise<Response>,
): Response | Promise<Response> {
  const handler = own(methods, request.method);
  if (!handler) {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: Object.keys(methods).join(", ") } },
    );
  }
  return run(handler);
}
