# Glossário: a linguagem ubíqua da Já Chegou

Este glossário decide as perguntas de linguagem do [modelo](README.md). Cada termo tem um sentido
só. A definição vem na língua do negócio, e a prova é o trecho que a sustenta: do dossiê
(`case/dossier/README.md`), do briefing (`case/briefing.md`) ou de um campo da base do kit. Onde não
há prova, isso está dito, e a questão aparece em [perguntas em aberto](#perguntas-em-aberto).

O briefing pede exatamente isto: anotar os "termos que cada cargo usa com sentidos diferentes".

## Os contextos

| Contexto | Definição | Prova (quem responde por ele) |
|---|---|---|
| **Conferência** | Confere a nota fiscal contra a compra e aprova a proposta. | "Conciliação ordem × nota × recebido" e "Check antecipado e devolução" (frentes do dossiê) |
| **Compras** | Emite a ordem de compra e mantém o saldo. | Briefing, gerente de compras: "Ordens de compra e negociação com fornecedores" |
| **Cadastro** | Mantém fornecedores e os seus produtos. | Briefing, gerente de compras: "cadastro de produtos e fornecedores" |
| **Recebimento** [2ª] | Registra o que chegou ao CD ou à loja. | Briefing, gerente de compras: "recebimento nos CDs e nas lojas e estoque" |
| **Contas a pagar** | Lança e mantém os títulos. | Briefing, controller: "o contas a pagar e o time de analistas" |
| **Pagamentos** | Paga os títulos e registra o pagamento fora do fluxo. | Briefing, CFO: "caixa, bancos e aprovação dos pagamentos" |

| Termo (código) | Definição | Prova | Sinônimos aceitos · proibidos |
|---|---|---|---|
| **Conector** (`Connector`) | Um por sistema (SEFAZ ou base do kit, ERP, WMS, app de loja, banco): leva os dados do sistema para as entidades do contexto. | "Captura de NF \| Busca as notas na SEFAZ \| Não cruza com a ordem antes da entrega"; "Integra só no sentido hub → ERP" (Anexo 5) | Aceito: **adaptador**, **camada anticorrupção** (o termo do DDD). Proibido: "camada de tradução", "camada de integração" |

## A compra

| Termo (código) | Definição | Prova | Sinônimos aceitos · proibidos |
|---|---|---|---|
| **Ordem de compra** (`PurchaseOrder`) | O que a Já Chegou pediu a um fornecedor para um destino: itens, quantidades e preços. | "a ordem sobe para o ERP; 20% dos pedidos ainda sobem por CSV"; "Notas sem ordem de compra"; o campo `pedido_referenciado` da nota guarda o `OC-…` da ordem | Aceito: **pedido**, **ordem**. Proibido: "OC" na prosa (é só o prefixo do identificador) |
| **Item da ordem** (`PurchaseOrderItem`) | Um produto pedido, com quantidade, unidade e preço. | Campo `itens` de `ordens.json` | |
| **Saldo da ordem** (`OrderBalance`) | O que ainda falta cobrar de cada item da ordem: o pedido menos o que as notas já cobraram. | Nenhuma no dossiê nem na base. É derivado ([pergunta 1](#perguntas-em-aberto)) | Proibido: "saldo" sozinho, que no dossiê é o caixa |
| **Ordem complementar** (`complements`) | Uma ordem de compra ligada a outra para cobrir uma divergência. É uma relação entre ordens, e não uma entidade nova. | "Divergência vira ordem complementar, criada por três áreas, em 2 dias a 3 meses"; "Ordens complementares: 5% a 7% dos pedidos" | |
| **Ordem travada** (`status = blocked`) | Ordem que não segue no ERP, em geral porque tem item sem cadastro. | "Item sem cadastro trava a ordem, mas a mercadoria entra mesmo assim"; `status: travada` em `ordens.json` | Proibido: "ordem bloqueada" (ver [bloqueio](#ambiguidades-resolvidas)) |
| **Ordem atendida** (`status = fulfilled`) | Ordem sem saldo: já foi toda cobrada. | `status: atendida` em `ordens.json`. O dossiê não usa o termo | |
| **Fornecedor** (`Supplier`) | Quem vende à Já Chegou e emite a nota, identificado pelo CNPJ. | "O fornecedor emite a nota antes de entregar"; campo `cnpj` de `fornecedores.json` | |
| **Fornecedor com pagamento bloqueado** (`Supplier.paymentsBlocked`) | Fornecedor que a diretoria proibiu de receber pagamentos até rever o contrato. | `motivo_bloqueio`: "Pagamentos bloqueados pela diretoria até revisão de contrato" | Proibido: "fornecedor bloqueado" sem complemento (ver [bloqueio](#ambiguidades-resolvidas)) |
| **Produto** (`Product`) | Um item que um fornecedor vende à Já Chegou, identificado pelo SKU, com unidade base e fator de caixa. O produto é do fornecedor. | "cadastro de produtos e fornecedores" (briefing, papel de compras); campos `fornecedor_id`, `codigo_fornecedor`, `unidade_base` e `fator_caixa` de `produtos.json` | Aceito: **item do cadastro** |
| **Item sem cadastro** (`E8`) | Item cobrado numa nota que não corresponde a nenhum produto do cadastro. | Exceção 8: "Item sem cadastro \| ordem travada \| nota \| recebido sob pressão comercial \| Não integra no ERP" | |
| **Fator de caixa** (`UnitConversion`) | Quantas unidades vêm numa caixa de um produto. | "O WMS não converte caixa em unidade"; exceção 4: "12 unidades \| 1 caixa \| 1 caixa"; campo `fator_caixa` | Aceito: **conversão de caixa para unidade** |
| **Destino** (`Destination`) | Onde a mercadoria é entregue: um CD ou uma loja. | "4 centros de distribuição (CDs) e 30 lojas escuras, que só atendem entrega"; campo `destino` (`CD-01`, `LJ-001`) | |

## A nota e a conferência

| Termo (código) | Definição | Prova | Sinônimos aceitos · proibidos |
|---|---|---|---|
| **Nota fiscal** (`Invoice`) | O documento com que o fornecedor cobra uma compra, identificado pela chave de acesso. Estados no modelo: **a conferir**, **conferida**, **com proposta**, **decidida**. | "Cerca de 11 mil notas fiscais de mercadoria por mês" (briefing); "A nota entra pela SEFAZ"; campo `chave` de `notas.json` | Aceito: **nota**. Proibido: "fatura" (é o título), "NF" na prosa |
| **Chave de acesso** (`AccessKey`) | Os 44 dígitos que identificam uma nota fiscal na SEFAZ. | Campo `chave` de `notas.json`. O dossiê não usa o termo | Proibido: "número da nota" como identidade (o número se repete entre fornecedores) |
| **Conferência** (`check`) | A atividade de confrontar a nota com a ordem de compra e, depois, com o recebido. | "o time cruza ordem, nota e recebido à mão"; "Conferir uma nota de 80 itens leva mais de 1h30" | Aceito: **conferir**. Proibido: "conciliação" para esta atividade (ver [ambiguidades](#ambiguidades-resolvidas)) |
| **Match** (`Classification.MATCH`) | A nota bate com a ordem, exatamente ou dentro da tolerância. | "Notas com match automático: 0,7% no CD, 0,4% na loja" | |
| **Tolerância** (`MatchTolerance`) | A diferença que ainda conta como match: até R$ 50 e até 0,5%, em nota de até R$ 5 mil. | `regua.json` da base: "diferença de até R$ 50 e até 0,5% em nota de até R$ 5 mil". O dossiê não fala de tolerância | |
| **Divergência** (`Discrepancy`) | Uma diferença concreta entre a nota e a ordem ou o recebido, com a sua evidência. | "Divergência vira ordem complementar"; "Divergência sobe por WhatsApp" | Proibido: usar como sinônimo de exceção |
| **Exceção** (`ExceptionKind`) | Um dos 8 tipos de divergência catalogados, E1 a E8. | O título "Anexo 4 · Exceções" e as suas oito linhas | Proibido: usar como sinônimo de divergência |
| **Duplicidade** (`E6`) | A mesma compra cobrada duas vezes. | Exceção 6: "Duplicidade \| ordem \| duas notas ou dois boletos \| recebido \| Paga duas vezes"; "Já pagamos o mesmo boleto duas vezes" | |
| **Nota sem ordem** (`E5`) | Nota que não cobra nenhuma ordem de compra. | Exceção 5: "Nota sem ordem \| — \| nota \| recebido \| Ninguém sabe quem comprou"; "Notas sem ordem de compra: Cerca de 4%" | |
| **Valor em risco** (`AmountAtRisk`) | Quanto a Já Chegou pagaria a mais se a nota fosse paga como veio. | A tool `registrar_proposta` do MCP do kit: "quanto a Já Chegou pagaria a mais se a nota passasse como veio". Liga-se ao P1: "Pago sem mercadoria correspondente, menos o recuperado" | |
| **Pagar errado** (P1) | Pagar por mercadoria que não chegou ou que não foi pedida. É a perda que o projeto move. | Briefing: "Pagar por mercadoria que não chegou ou que não foi pedida"; dossiê: "R$ 543 mil" por mês | |
| **Perda mensal** (P1) | O que a Já Chegou paga errado por mês hoje: pago sem mercadoria correspondente, menos o recuperado. São os R$ 543 mil. | Dossiê: "R$ 543 mil" por mês | |
| **Pagamento errado evitado** (#125) | O valor em risco das propostas aprovadas que recusam ou recebem parcial, sem E6 e E7. Compara-se com a perda mensal. Na tela, **Evitado**. | Liga o valor em risco ao P1 | Proibido: "valor barrado", "barrado" |
| **Em decisão** (#125) | O valor em risco das propostas que aguardam aprovação, sem E6 e E7. Um termo só para o que antes era "proposto, aguardando aprovação" e "ainda em risco". | Estado **aguardando aprovação** da proposta | Proibido: "ainda em risco" |
| **Pagamento em dobro evitado** (#125) | O valor em risco das propostas de duplicidade (E6) e de pago fora do fluxo (E7). É pagar duas vezes, e não pagar sem mercadoria, por isso fica numa linha separada e fora da comparação com a perda mensal. | Exceções 6 e 7 do Anexo 4: "Paga duas vezes" | |

## O recebimento

| Termo (código) | Definição | Prova | Sinônimos aceitos · proibidos |
|---|---|---|---|
| **Recebimento** (`Receipt`) **[2ª]** | O registro do que chegou a um destino, item a item. | "O CD recebe com doca agendada em planilha; a loja recebe a qualquer hora pelo app"; coluna "Recebido" do Anexo 4; campo `canal` (`doca_cd`, `app_loja`) | Aceito: **recebido**. Proibido: "conferência" para o recebimento |
| **Doca** (`Dock`) | O lugar do CD onde o caminhão é recebido, com hora agendada. | "O CD recebe com doca agendada em planilha"; "Agenda de doca dos CDs" | Proibido: "doca" para a loja (ver [ambiguidades](#ambiguidades-resolvidas)) |
| **Ação no recebimento** (`DockAction`) | O que fazer com a mercadoria da nota: receber, receber parcial ou recusar. O lugar sai do destino: a **doca do CD** (`CD-*`, via WMS, `outbox_dock_actions`) ou o **app da loja** (`LJ-*`, `outbox_store_actions`). | "a doca recebe, recebe parcial ou recusa, e a divergência vira recusa ou nota de devolução no ERP" (CD); "a loja recebe a qualquer hora pelo app" | Proibido: "pagamento parcial" para receber parcial |
| **Ação na doca** | A ação no recebimento quando o destino é um CD. | "a doca recebe, recebe parcial ou recusa" | Só para `CD-*`. Proibido: "ação na doca" para a loja; para ela, **ação no recebimento na loja** |
| **Aceite** (`Acceptance`) | Aceitar a mercadoria e a nota. Para o jurídico, aceita o pedido. | "O jurídico diz que aceitar a nota é aceitar o pedido" | Proibido: "recebimento" para o aceite |
| **Nota de devolução** (`ReturnNote`) | Documento que devolve ao fornecedor a diferença cobrada e não recebida ou não pedida. | "emitir nota de devolução"; "a divergência vira recusa ou nota de devolução no ERP" | Estados na fila do fiscal (#140): `pendente`, `emitida` (com o número da NF-e de devolução) e `cancelada` (com justificativa). |

## O pagamento

| Termo (código) | Definição | Prova | Sinônimos aceitos · proibidos |
|---|---|---|---|
| **Título** (`Payable`) | A obrigação de pagar uma nota, criada quando a nota é lançada no ERP. | "Exportação de títulos e pagamentos do ERP"; "Dias da nota ao lançamento da fatura"; `situacao` (`lançada`, `paga`) em `notas_lancadas.json` | Aceito: **nota lançada** (a nota com o seu título no ERP). Proibido: "fatura", "boleto" |
| **Pagamento** (`Payment`) | A saída de dinheiro que quita um título, ou, fora do fluxo, uma compra. | "Os boletos são pagos um a um no banco"; `pagamentos.json` | |
| **Boleto** | Um meio de pagamento, entre outros. Não é entidade do modelo. | "Valor pago por boleto: 66%"; campo `forma` (`pix`, `boleto avulso`) | Proibido: usar como sinônimo de título |
| **Pagamento fora do fluxo** (`Payment.offFlow`) | Pagamento feito pela loja numa compra emergencial, antes de a nota chegar, sem passar pela lista do dia. | "Compras emergenciais das lojas são pagas fora do fluxo e aparecem depois"; exceção 7: "nota tardia \| recebido na loja"; `origem`: "compra emergencial da loja, fora do fluxo" | |
| **Lista do dia** | Os títulos que o contas a pagar propõe pagar no dia. Fora do domínio da 1ª entrega. | "Os analistas do contas a pagar montam a lista do dia, com cerca de 400 propostas" | |
| **Proposta de pagamento** | Um item da lista do dia. Fora do domínio da 1ª entrega. | Briefing: "Todo dia o contas a pagar monta umas 400 propostas de pagamento na mão" | Sempre com "de pagamento" (ver [proposta](#ambiguidades-resolvidas)) |

## A aprovação

| Termo (código) | Definição | Prova | Sinônimos aceitos · proibidos |
|---|---|---|---|
| **Proposta** (`Proposal`) | O que o agente propõe para uma nota: classificação, ação na doca, encaminhamento, valor em risco e justificativa. Estados: **registrada**, **aguardando aprovação**, **aprovada** (pela regra ou por uma pessoa), **alterada**. | A tool `registrar_proposta` do MCP do kit. No dossiê, "proposta" é a de pagamento | Proibido: confundir com proposta de pagamento ([pergunta 2](#perguntas-em-aberto)) |
| **Limites de aprovação** (`ApprovalPolicy`) | Quem aprova o quê, por valor da nota e por tipo de divergência. | `regua.json`: "Régua de alçadas validada em 05/11 (R$ 5 mil, R$ 20 mil, R$ 100 mil)". O dossiê dá dois limites, "Abaixo de R$ 5 mil ele assina sem olhar; acima de R$ 100 mil quer ver cada caso", e cita "alçadas" | Aceito: **régua**, **régua de alçadas**, **alçada** (são os termos do dossiê e da base) |
| **Nível** (`ApprovalLevel`) | Um degrau dos limites: regra, analista, coordenação, diretoria, bloqueio. | Campo `niveis` de `regua.json` | |
| **Encaminhamento** (`Proposal.routing`) | O nível para o qual a proposta foi enviada. | Campo `encaminhamento` da proposta no MCP do kit | |
| **Aprovador** (`Approver`) | A pessoa cujo nível permite aprovar a proposta, a regra no match ou, #42, o **motor de decisão** (`motor`) no nível analista com a delegação ligada e a confiança no limite (ver a regra 8). Nunca o agente de IA, nunca o motor na diretoria ou no bloqueio. | "O agente nunca aprova nem paga" (`regua.json`); a delegação do motor é a #42 | |
| **Motor de decisão** (`engine`) | A cascata regra → Clef → pessoa que decide a proposta de E4 do analista. No **modo sombra** só registra o que faria; no **modo delegado** (delegação do nível ligada) aprova quando a regra fecha a conta ou o Clef tem confiança no limite ou acima. Aparece como "Motor" ("Aprovado pelo motor"). | `engine_decisions` e `engine_settings` (#41, #42) | Proibido: chamar de "agente"; o agente de IA nunca aprova |
| **Aprovação** (`Approval`) | O registro da decisão sobre a proposta: quem aprovou (a pessoa, a regra ou o motor), o nível, a ação final e a justificativa; na do motor, também a confiança e a versão do modelo. | Nenhuma no dossiê, que fala da aprovação de **pagamento** pelo CFO, outra coisa (ver [aprovar](#ambiguidades-resolvidas)) | Proibido: "caso de alçada", "decisão" como entidade |

## Ambiguidades resolvidas

| # | Ambiguidade | Evidência | Resolução |
|---|---|---|---|
| 1 | **Pedido × ordem de compra** | "a ordem sobe para o ERP; 20% dos pedidos ainda sobem por CSV"; "Ordens complementares: 5% a 7% dos pedidos"; "Notas sem ordem de compra"; `pedido_referenciado` guarda o `OC-…` da ordem; "aceitar a nota é aceitar o pedido" | São o mesmo objeto. O termo é **ordem de compra**, com "pedido" como sinônimo |
| 2 | **"O pedido do CFO"** | O título "O pedido do CFO" no briefing; "O contrato descreve o problema como o CFO o vê" | É o pedido de projeto, fora do domínio |
| 3 | **Plano de compra e ordem complementar** | "O forecast gera o plano de compra e a ordem sobe para o ERP"; "Divergência vira ordem complementar" | O **plano de compra** vem antes da ordem e fica fora do domínio. A **ordem complementar** é uma ordem de compra ligada a outra: uma relação, não uma entidade |
| 4 | **Nota × título × boleto × fatura** | "Dias da nota ao lançamento da fatura"; "Exportação de títulos e pagamentos do ERP"; "Já pagamos o mesmo boleto duas vezes"; "Valor pago por boleto: 66%" | **Nota fiscal** é o documento que cobra. **Título** é a obrigação de pagar, criada no lançamento. **Boleto** é um meio de pagamento. "Fatura" é proibido, porque o dossiê a usa para o título |
| 5 | **Divergência × exceção** | "Divergência vira ordem complementar"; "Anexo 4 · Exceções" | **Divergência** é o fato encontrado numa nota. **Exceção** é o tipo catalogado. Uma nota tem divergências, e cada uma é de um tipo |
| 6 | **Nível × encaminhamento × alçada** | `niveis` e `encaminhamento` na base do kit; "alçadas" no dossiê | **Nível** é o degrau dos limites de aprovação. **Encaminhamento** é o nível para onde a proposta foi. **Alçada** é sinônimo de limites de aprovação; o nível de uma pessoa é o do **aprovador** |
| 7 | **Recebimento × conferência × aceite** | "o time cruza ordem, nota e recebido à mão"; "Quando a gente olha a nota, a mercadoria já entrou"; "aceitar a nota é aceitar o pedido" | **Recebimento** registra o que chegou. **Conferência** confronta a nota com a ordem e o recebido. **Aceite** é o ato jurídico, e vem depois da decisão |
| 8 | **Doca × loja** | "O CD recebe com doca agendada em planilha; a loja recebe a qualquer hora pelo app" | **Doca** é só do CD. A loja recebe pelo app, sem doca. A "ação na doca" vale só para o CD. A loja tem a sua **ação no recebimento**, publicada para o app da loja ([pergunta 3](#perguntas-em-aberto), respondida na #135) |
| 9 | **Pagamento fora do fluxo × pagamento** | "Compras emergenciais das lojas são pagas fora do fluxo e aparecem depois"; `nota_chave: null` em `pagamentos.json` | Os dois são **pagamento**. O fora do fluxo é o que vem antes da nota e sem título, e por isso a nota tardia não pode gerar um segundo |
| 10 | **Proposta** | "a lista do dia, com cerca de 400 propostas"; briefing: "400 propostas de pagamento"; a tool `registrar_proposta` | **Proposta de pagamento** é item da lista do dia, fora do domínio. **Proposta**, sem complemento, é a do agente sobre a nota |
| 11 | **Saldo** | "O saldo é conferido às 8h e muda ao longo do dia" | No dossiê, saldo é o **caixa**. O que falta cobrar de uma ordem é sempre **saldo da ordem**, nunca "saldo" sozinho |
| 12 | **Parcial** | "com pagamentos parciais" (o CFO); "recebe parcial" (a doca) | **Receber parcial** é ação na doca. **Pagamento parcial** é decisão de caixa, fora do domínio. **Entrega parcial** é a nota que cobra só parte do saldo da ordem, e não é divergência |
| 13 | **Bloqueio** | "fornecedores que bloquearam entrega" (P3); `motivo_bloqueio`: "Pagamentos bloqueados pela diretoria"; "Item sem cadastro trava a ordem"; o nível `bloqueio` dos limites de aprovação | Quatro sentidos, quatro termos: o fornecedor que **suspende entregas** (P3, fora do domínio); o **fornecedor com pagamento bloqueado**; a **ordem travada**; o nível **bloqueio**, em que ninguém paga até resolver |
| 14 | **Aprovar** | "O próprio CFO aprova cada pagamento"; "Abaixo de R$ 5 mil ele assina sem olhar" | **Aprovar pagamento** é do caixa, fora do domínio. No modelo, o aprovador **aprova a proposta** (a aprovação), e o agente só **propõe** |
| 15 | **Conciliação** | "Quebra a conciliação bancária"; "notas sem conciliação"; "Conciliação ordem × nota × recebido" | **Conciliação bancária** é do pagamento contra o extrato, fora do domínio. Confrontar nota, ordem e recebido é **conferência** |
| 16 | **Cadastro** | "cadastro de produtos e fornecedores"; "Cadastro por planilha importada"; "Item sem cadastro" | **Cadastro** é o conjunto de produtos e fornecedores, mantido por compras num sistema. Sem cadastro é o item que não está nele |

## Perguntas em aberto

O dossiê não decide estas questões.

1. **Saldo da ordem.** Nem o dossiê nem a base têm saldo da ordem; a base só tem `aberta`,
   `atendida` e `travada`. O modelo o deriva: o pedido menos o que as notas cobraram. Uma ordem pode
   ser cobrada por várias notas?
2. **O nome "proposta".** No dossiê, proposta é a de pagamento. Basta qualificar (proposta de
   pagamento × proposta), ou o termo do modelo deve virar **proposta de ação**?
3. **Ação na loja.** *Respondida (#135).* A loja não tem doca nem agenda, mas a ação vale para ela:
   o conceito geral é a **ação no recebimento** (receber, receber parcial, recusar), e o lugar sai do
   destino. Nota de CD (`CD-*`): a ação vai para o WMS e aparece na tela da doca. Nota de loja
   (`LJ-*`): vai para o app da loja (`outbox_store_actions`) e aparece em "Recebimento na loja",
   filtrada pela loja. Nenhum texto chama de doca o recebimento da loja.
4. **O degrau de R$ 20 mil.** O dossiê dá R$ 5 mil e R$ 100 mil; R$ 20 mil só aparece nos limites
   de aprovação da base do kit. É o limite validado com a Já Chegou?
5. **Valor em risco × P1.** *Respondida (#125).* O P1 é "pago sem mercadoria correspondente, menos
   o recuperado". O valor em risco soma na comparação com a perda mensal só nas exceções que o P1
   cobre. A duplicidade (E6) e o pago fora do fluxo (E7) são pagar duas vezes, e aparecem numa linha
   separada, **pagamento em dobro evitado**, fora da comparação com os R$ 543 mil.
6. **Duplicidade por boleto.** O dossiê fala em "duas notas ou dois boletos". O segundo boleto da
   mesma nota é duplicidade de pagamento, e não de nota. Entra na 1ª entrega?
