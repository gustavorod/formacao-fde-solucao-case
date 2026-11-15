# API

O Worker `formacao-fde-solucao-case-api`, na Cloudflare. Por enquanto, responde
`GET /health`, `GET /me` e `GET /api/valor-barrado` e a tela de `web/` (atrás do Cloudflare Access, #60; o
painel está em `src/panel/README.md`) e tem um Cron a cada 15 minutos que só
registra que rodou.

## Rodar local

```bash
npm ci
npm run dev
```

Os segredos ficam no `api/.dev.vars`, que o git ignora, um por linha:

```
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN=...
ACCESS_AUD=...
ACCESS_TEAM_DOMAIN=barte-academy.cloudflareaccess.com
```

## O Claude no Worker (#171)

O Cron chama o Claude pela Messages API (`src/claude/`), no começo de cada rodada, e grava as sugestões em
`claude_suggestions`. A regra determinística confirma cada uma; sem sugestão, decide sozinha.

- **Credencial:** o setup token do Claude Code, em `BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN` (`Authorization: Bearer` +
  `anthropic-beta: oauth-2025-04-20`). A esteira (`deploy-api.yml`) o põe no Worker com `wrangler secret put`. É uso
  da assinatura fora do Claude Code: a Anthropic pode limitar ou bloquear.
- **Plano B:** com `BARTE_ACADEMY_ANTHROPIC_API_KEY` no Worker, o cliente usa a chave (`x-api-key`) no lugar do
  token. Só o secret muda.
- **Falha fechada:** sem credencial, com 429 ou 401, a rodada é interrompida, a falha é contada e logada sem
  segredo, e nenhuma linha de erro gasta tentativa. A regra decide sozinha.
- **Tarefas:** `src/claude/tasks/` (`description-match`, #66; `probable-order`, #65). Para acrescentar uma, crie o
  arquivo exportando um `ClaudeTask` e uma linha em `tasks/index.ts`.
- **Eval do casamento de descrição** (fora do gate, precisa da credencial): `npm run eval:description-match`.

## O motor de decisão em modo sombra (#41)

A cada rodada, depois do Claude, o Cron passa pelo motor (`src/engine/`) as propostas que aguardam uma pessoa e
têm a E4 (unidade de medida), e grava em `engine_decisions`, com `mode = shadow`, o que o motor faria. Ele não
aprova nada: não escreve em `approvals` nem muda `proposals`. O número de decisões da cascata gravadas na rodada
(as novas e as refeitas depois de uma falha do Clef) vai para `automation_runs.engine_evaluated`.

- **Cascata** (`cascade.ts`): primeiro as exclusões, que nunca chegam ao Clef e ficam com a pessoa
  (`pending`): duplicidade (E6), fornecedor bloqueado, nota acima de R$ 100 mil, pedido de alterar (ação na doca
  que não é receber), E4 junto de outra exceção e o que passa da linha 5 da régua (`outside_criteria`); diretoria
  e bloqueio (`level_not_delegable`). Depois a **regra**: se, em UN pelo fator do cadastro, a nota bate com a ordem
  e o valor em risco é zero, aprova. Só o resto vai ao **Clef**.
- **Regra e Clef lado a lado** (decisão do dono): cada linha tem um `role`. A decisão efetiva da cascata é
  `cascade`, uma por proposta e modo. Quando a regra decide uma E4 elegível (analista, até R$ 20 mil, sem
  exclusão), o Clef também é avaliado, só para ser medido, numa linha `benchmark` da versão dele; o mesmo vale
  para uma versão nova do Clef sobre a cascata já gravada. A medição nunca muda quem decide, e as exclusões nunca
  chegam ao Clef, nem como medição (migração `20261116120000_engine_decisions_role.sql`).
- **Clef** (`clef.ts`): o Workers AI pelo binding `ai` do `wrangler.jsonc`, sem chave, com o modelo
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` em modo JSON. A versão gravada (`CLEF_MODEL_VERSION`) junta o prompt e o
  modelo. No modo sombra a decisão do Clef fica como ele deu, com a confiança; o limite de `engine_settings` é do
  relatório e do modo delegado (#42). A justificativa e a evidência, que vêm de fora, vão no prompt entre
  `<justificativa>` e `<evidencia>`, com `<` e `>` trocados por `‹` e `›`; o prompt de sistema diz que o conteúdo
  delimitado é dado, nunca instrução, e a confiança só sai do JSON conferido (versão `clef-e4-v2`).
- **Falha fechada:** o tempo limite é `engine_settings.clef_timeout_ms` (8 segundos no analista, #42). Falha, tempo esgotado ou resposta fora do
  formato ficam com a pessoa (`clef_failed`), com a classe do erro e a latência. Na medição, a falha grava
  `clef_failed` na linha `benchmark` e a decisão da regra fica como está. Se o motor inteiro falha, uma linha no
  log e a rodada segue.
- **Idempotente:** a proposta que já tem a decisão da cascata no modo não volta à cascata, e a que já tem uma
  resposta da versão atual do Clef (cascata ou medição) não volta ao Clef. No máximo 5 chamadas ao Clef por
  rodada, da cascata e da medição juntas, a cascata primeiro; o resto fica para a próxima.
- **A falha do Clef é tentada de novo, até 3 vezes:** a linha `clef_failed` da versão atual não conta como
  avaliada. Numa rodada seguinte o Clef é chamado de novo, no mesmo papel (cascata ou medição), por um `PATCH`
  filtrado por `pending_reason = clef_failed` e pelas tentativas lidas (`attempts`): a resposta que deu certo nunca
  é sobrescrita, e duas rodadas ao mesmo tempo não contam a mesma tentativa duas vezes. A resposta substitui a
  linha da falha e conta em `engine_evaluated`; a nova falha só soma a tentativa e troca `last_attempt_at`, o erro
  e a latência, sem mover `decided_at` e sem contar como avaliada (a falha repetida não é decisão nova, e a
  proposta não muda de semana no relatório). Com `attempts = 3` (`CLEF_MAX_ATTEMPTS`) a falha fica definitiva: o
  Clef não é mais chamado para aquela linha, e ela segue em `clef_failed` no relatório. As novas tentativas entram
  no teto de 5 por rodada, depois do que nunca foi avaliado, a de `last_attempt_at` mais antiga primeiro: uma
  falha que persiste não toma o lugar das outras (migração `20261116130000_engine_decisions_attempts.sql`). Se a
  gravação das novas tentativas ou da medição falha, a cascata nova já gravada segue contada em
  `engine_evaluated`.
- **A cascata que falhou só volta ao Clef se a proposta de agora ainda é dele.** Se, depois da falha, a proposta
  passou a cair numa exclusão ou na regra (a evidência ou o valor em risco mudou), a cascata não é tentada de novo:
  segue `clef_failed`, conta em `clef_failed` no relatório e não é refeita pela regra. A cascata é uma por
  proposta e modo, e refazê-la pela regra trocaria quem decide numa linha já gravada; fica assim nesta história.

### O motor ao lado da pessoa (AC-4) e o relatório de acerto (AC-5)

Calculados na leitura (`src/engine/agreement.ts`), das linhas de `engine_decisions` em modo sombra e do estado da
proposta; nada novo é gravado.

- **A decisão da pessoa:** aprovar e alterar gravam uma linha em `approvals`; o estado da proposta separa as duas.
  `aprovada` é `approve`; `alterada` (a pessoa pediu outra ação na doca, não aprovou a proposta como veio) é
  `refuse`. O par concorda quando o motor decidiu o mesmo; com a pessoa ainda sem decidir, ou com o motor deixando
  com ela (`pending`), o par é nulo.
- **`engine` na proposta** (`GET /api/propostas/:chave`, só acrescentado): a decisão efetiva da cascata
  (`outcome`, `decided_by`, `confidence`, `model_version`, `reason`, `pending_reason`, `decided_at`), a medição do
  Clef em `clef` (a linha mais recente com `decided_by = clef`, da cascata ou da medição, com o próprio
  `agreement`), `person_outcome` e `agreement`. Sem decisão do motor, ou se a leitura falha, `engine` é nulo.
- **`GET /api/motor/acerto`** (atrás do Access): `?semana=AAAA-MM-DD` (a semana desse dia) ou
  `?de=AAAA-MM-DD&ate=AAAA-MM-DD` (as semanas do primeiro ao último, até 53); sem nada, as últimas 8. O período é
  fechado: lê as linhas de `decided_at` da meia-noite da primeira segunda até a meia-noite da segunda seguinte à
  última semana (excluída), em Brasília. O filtro de período vale para todas as linhas, a medição também: a
  proposta entra na semana da cascata, mas a medição do Clef gravada depois do fim do período não entra, e a
  proposta conta como sem medição (fora de `at_or_above_threshold`). Por isso o número de uma semana pode subir
  quando o período pedido vai além dela, e a semana fechada pode mudar enquanto a medição dela ainda está sendo
  feita. A cascata que o Clef respondeu numa nova tentativa tem o `decided_at` da resposta e entra na semana dela.
  Uma linha por semana (segunda a domingo, no fuso de Brasília) e classificação, só a E4 nesta história, mesmo a
  semana vazia.
  A proposta entra na semana em que o motor gravou a decisão da cascata, com a classificação da proposta.
  - `evaluated`: as propostas elegíveis (a E4 até R$ 20 mil do analista, sem exclusão) com a decisão da cascata
    na semana. Só elas entram nos números abaixo.
  - `excluded`: as que caíram numa exclusão da cascata (`outside_criteria` ou `level_not_delegable`); ficam fora
    de todas as contas de acerto, para não diluir a taxa.
  - `decided_by_person`: delas, as já decididas pela pessoa.
  - `agreement`: delas, as em que a cascata decidiu o mesmo que a pessoa (`pending` nunca é acerto);
    `agreement_rate = agreement / decided_by_person`.
  - `at_or_above_threshold`: das avaliadas, as que têm a medição do Clef com confiança igual ou acima do limite,
    o `engine_settings.confidence_threshold` do analista (devolvido em `threshold`).
  - `agreement_rate_at_threshold`: só nessas e já decididas pela pessoa, a parte em que o Clef decidiu o mesmo
    que a pessoa (é o número que decide ligar a delegação, que é do Clef).
  - `clef_failed`: das avaliadas, as que têm uma falha do Clef sem nenhuma resposta dele, as que ainda serão
    tentadas de novo e as que chegaram às 3 tentativas; mostra o quanto falta na amostra.
  - Divisão por zero dá `null`.

## O motor de decisão em modo delegado (#42)

Com `engine_settings.delegation_enabled` ligado para o nível analista, a rodada do Cron (`src/engine/delegated.ts`)
decide com `mode = delegated` em vez de rodar a sombra. Liga e desliga no banco, nível a nível, sem deploy, e vale
na rodada seguinte; desligada (o padrão), o modo sombra roda exatamente como acima, e nada vai para `approvals`.

- **Quem aprova:** a regra que fecha a conta (`decided_by = rule`, confiança nula, versão `regra-e4-v1`) e o Clef com
  confiança de `confidence_threshold` (0,98) ou mais e `outcome = approve`. A decisão é gravada antes e a aprovação
  a cita: entra em `approvals` pelo mesmo caminho da aprovação da pessoa (`approve()` e `saveDecision`), com
  `approver = 'motor'`, `approver_level = 'analista'`, `engine_decision_id`, `engine_confidence` e
  `engine_model_version`; `approved_by` é gerada pelo banco (`engine`). O título vai para a lista do dia, e a ação
  chega à doca na varredura da rodada seguinte do Cron. `automation_runs.engine_approved` conta as aprovações.
- **Quem fica com a pessoa:** abaixo do limite, `below_confidence` com `recommendation` (`approve` ou `refuse`) e o
  porquê, que a proposta mostra em `engine`; a falha do Clef (`clef_failed`, com a classe do erro e a latência, sem
  nova tentativa no modo delegado); diretoria e bloqueio (`level_not_delegable`) e o resto das exclusões, que nunca
  chegam ao Clef; o `refuse` do Clef no limite (o motor nunca recusa sozinho).
- **A pessoa que decidiu antes ganha:** a proposta é relida na hora de aprovar. A corrida que só o banco vê
  (`23505` em `approvals`) e a delegação desligada no meio (`23514` do gatilho) deixam a proposta com a pessoa sem
  derrubar a rodada; a aprovação que não bate com a decisão (`23503`/`23514`) é erro de programação, vai para o log
  e a rodada segue com as outras. A decisão `approve` gravada sem aprovação é a que ficou com a pessoa.
- **Sem medição com a delegação ligada:** a rodada delegada não grava `benchmark` nem a sombra. O relatório de
  acerto (`GET /api/motor/acerto`) continua só sobre `mode = shadow`: a proposta que o motor aprova não passa pela
  pessoa, então não há com o que comparar. Para medir de novo, desliga-se a delegação.
- **Teto:** até 10 propostas decididas e 5 chamadas ao Clef por rodada; o resto fica para a seguinte.
- **A doca, a linha do tempo e a lista do dia** mostram o motor: `decidedBy` com `actor = 'engine'` e
  `actor_name = 'Motor'`, o passo "Aprovada pelo motor" e `approvedBy = 'engine'` em `GET /api/hoje`.

### Ligar a delegação

Ligar é decisão de negócio (AC-6): só depois de o relatório do modo sombra mostrar, numa semana com pelo menos 20
propostas decididas pela pessoa, `agreement_rate_at_threshold` de 0,98 ou mais. O código não confere isso. Na demo,
liga-se à mão no banco:

```sql
-- Atenção: a partir da rodada seguinte o motor APROVA SOZINHO a E4 do analista e o título vai para a lista do dia.
-- Só na demo, ou depois do acerto combinado com o CFO no modo sombra.
update public.engine_settings set delegation_enabled = true, updated_at = now() where level = 'analista';
-- Para voltar ao modo sombra:
update public.engine_settings set delegation_enabled = false, updated_at = now() where level = 'analista';
```

## Testar

```bash
npm run typecheck
npm test
```

Na raiz do repositório, `make check` roda os dois junto com o resto do gate.

## Publicar

Não se publica à mão. Cada merge na `main` que mexe em `api/` roda o workflow
`.github/workflows/deploy-api.yml`, que testa e publica com `wrangler deploy`.
Ele também pode ser disparado pela aba Actions, mas só publica a partir da `main`. Os segredos do Worker em
produção entram com `npx wrangler secret put <NOME>`, nunca no git.

## Cloudflare Access

Toda rota, menos `GET /health`, exige o JWT do Cloudflare Access (#54). O Worker lê o token do
cabeçalho `Cf-Access-Jwt-Assertion` ou do cookie `CF_Authorization` e confere a assinatura RS256
contra as chaves do time, o `aud`, o `iss` e a validade. `GET /me` devolve o e-mail de quem entrou.

| Situação | Resposta |
|---|---|
| Sem token (mesmo com as variáveis vazias) | 401 `unauthenticated` |
| Com token, mas `ACCESS_AUD` ou `ACCESS_TEAM_DOMAIN` vazios | 503 `access_not_configured` |
| Token inválido (assinatura, `aud`, `iss`, expirado, kid desconhecido) | 403 `forbidden` |
| Chaves do time fora do ar | 503 `access_unavailable` |

As duas variáveis não são segredo. Em produção, a esteira passa com `wrangler deploy --var`, a
partir das variáveis do repositório `BARTE_ACADEMY_ACCESS_AUD` e `BARTE_ACADEMY_ACCESS_TEAM_DOMAIN`.
Localmente, ficam no `.dev.vars`; sem elas, só o `/health` responde 200.

### Provisionar

Uma vez por conta, no painel da Cloudflare: abra o Zero Trust, crie o time `barte-academy` e
escolha o plano Free. Depois, na raiz do repositório:

```bash
export BARTE_ACADEMY_CLOUDFLARE_API_TOKEN=...   # com permissão de Access: Apps and Policies
export BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID=...
export BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS="aluno1@gmail.com, aluno2@gmail.com"
python3 scripts/cloudflare_access.py --dry-run   # mostra o que enviaria
python3 scripts/cloudflare_access.py
```

O script garante o login por código no e-mail e a aplicação `formacao-fde-solucao-case`, com a
política que libera a `barte.com` e os alunos listados. Rodar de novo atualiza, não duplica. No fim,
imprime `ACCESS_AUD=...` e `ACCESS_TEAM_DOMAIN=...`: são os valores das variáveis do repositório.
