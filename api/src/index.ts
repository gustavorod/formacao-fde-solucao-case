import { tick } from "./cron/tick";
import type { Env } from "./env";
import { createAccessVerifier, fetchJwksOverNetwork } from "./http/access";
import { route, type RouterDeps } from "./http/router";
import { MemoryApprovalStore } from "./approval/store";
import { SupabaseApprovalStore } from "./approval/supabase-store";
import { SupabaseRest } from "./connectors/supabase-rest";
import { supabaseConnectors } from "./connectors/supabase-connectors";
import { loadDossierContext } from "./dossier/context";
import { SupabaseDossierSource } from "./dossier/source";
import { SupabaseTimelineSource } from "./automation/readers";
import { appStoreActionOutbox } from "./connectors/store-action";
import { wmsDockActionOutbox } from "./connectors/wms-dock-action";
import { SupabaseEngineStore } from "./engine/supabase-store";

export interface Worker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** Monta o Worker com as dependências dadas. Os testes injetam um verificador sem rede (#54). */
export function createWorker(deps: RouterDeps): Worker {
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      return route(request, env, deps);
    },
    async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
      await tick(controller, env);
    },
  } satisfies ExportedHandler<Env>;
}

// O verificador vive no escopo do módulo, então o cache das chaves do Access dura o isolate.
/** #63 A loja da aprovação nas tabelas do domínio; sem as credenciais do Supabase, vazia em memória. */
function approvalDeps(env: Env) {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return { store: new MemoryApprovalStore() };
  const rest = new SupabaseRest({ url, secretKey });
  const { captureDeps } = supabaseConnectors(rest);
  return {
    store: new SupabaseApprovalStore(rest),
    // #43 AC-1: aprovar ou alterar publica a ação na doca para o WMS.
    dockOutbox: wmsDockActionOutbox(rest),
    // #135 A nota de loja vai para o app da loja.
    storeOutbox: appStoreActionOutbox(rest),
    // #68: o dossiê que o job do Claude gravou, conferido contra o contexto da nota.
    // #176 A unidade de estoque do receber parcial vem do fator de caixa do cadastro.
    products: () => captureDeps.registry.listProducts(),
    timeline: new SupabaseTimelineSource(rest, new SupabaseDossierSource(rest)),
    // #41 AC-4 A decisão do motor em modo sombra, ao lado da pessoa.
    engine: new SupabaseEngineStore(rest),
    dossier: {
      source: new SupabaseDossierSource(rest),
      context: (key: string) => loadDossierContext(captureDeps, key),
    },
  };
}

export default createWorker({
  verifier: createAccessVerifier(fetchJwksOverNetwork),
  approval: approvalDeps,
});
