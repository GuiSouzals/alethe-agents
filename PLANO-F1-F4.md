# Plano de implementação F1–F4 — chassi do Lord Orchestration Agent

> **Entregável de arquitetura, não código de produção.** Elaborado em 2026-08-14 com autorização
> explícita do Guilherme. Repositório observado: `lord-chassi`, branch `lord/aba-condutora`,
> `HEAD 039c8f3`. Este plano não autoriza commit, push, release nem alteração dos ADRs.

## Premissas e legenda

- **Fato verificado** traz referência `arquivo:linha` ou, quando for uma observação de execução,
  identifica data, processo e arquivo observado.
- **NÃO CONFIRMADO** significa que a API, comportamento ou garantia não foi demonstrada no código,
  na documentação oficial ou em ensaio local não destrutivo.
- **[DECISÃO DO GUILHERME]** é um gate: a fatia dependente não começa antes da escolha explícita.
- **[MODELO PEQUENO]** significa mudança mecânica, contrato já fechado e oráculo automatizado.
- **[MODELO FORTE]** significa decisão de fronteira, segurança, concorrência, protocolo ou ciclo de
  vida; não deve ser delegada a um modelo menor sem que o desenho já tenha sido congelado.
- O arquivo `POLITICA-DE-FORK.md` citado por `LORD-CHASSI.md:340-347` não existe neste checkout.
  Portanto, o texto formal adicional dessa política é **NÃO CONFIRMADO**; este plano usa a regra
  verificável de fork mínimo e PR genérico registrada em `LORD-CHASSI.md:268-281` e
  `ADR-0003-separacao-chassi-cerebro-por-licenca.md:71-87`.

# 1. Estado atual verificado

## 1.1 Limites do fork e dos ADRs

O fork é o chassi AGPL: workspace, PTYs, painéis, abas, persistência e adaptadores de runtime.
Conteúdo de julgamento, seleção de executor, corte de histórias, prompts proprietários e veredito
pertencem ao cérebro separado; a fronteira aceita é processo, CLI e arquivos
(`LORD-CHASSI.md:13-25`; `ADR-0003-separacao-chassi-cerebro-por-licenca.md:71-90`). Melhorias
genéricas do chassi devem ser candidatas a PR upstream para reduzir divergência
(`ADR-0003-separacao-chassi-cerebro-por-licenca.md:73-85`).

Segurança não pode depender de instrução no prompt nem da boa vontade do agente. A permissão
efetiva é a interseção entre baseline, concessão da demanda, teto do agente e adaptador seguro;
negação vence e concessão expira (`ADR-0006-seguranca-da-ferramenta.md:48-60`). Sandbox comum,
rede mediada, cotas e canários negativos devem falhar fechados
(`ADR-0006-seguranca-da-ferramenta.md:61-79`). Sem isso, só cabe modo degradado explicitamente
rotulado (`ADR-0006-seguranca-da-ferramenta.md:80-83`).

O ADR-0008 escolheu aba condutora mais uma aba de execução por despacho, com prompt verbatim e
saída ao vivo (`ADR-0008-visibilidade-da-orquestracao.md:54-67,71-85`). A aba não é a evidência
canônica e “processo concluído” não significa “trabalho aprovado”
(`ADR-0008-visibilidade-da-orquestracao.md:86-105`).

## 1.2 Veredito crítico do B1 — `/spawn`

**Veredito: o `sandbox-job-oNnjQlgQTw` não virou aba no estado observado. Ele também não ficou em
uma fila de sandbox.** O backend gerou um nome `sandbox-job-*`, emitiu um evento Tauri sem verificar
se havia consumidor e respondeu imediatamente `accepted: true, status: "queued"`
(`src-tauri/src/agent_events.rs:183-228`). Não existe, no fluxo normal, fila, registro de estado ou
associação desse `job_id` com um terminal. As únicas ocorrências funcionais de `job_id` fora do
listener pertencem ao store do Agent Sandbox desativado
(`src/stores/agentSandboxStore.ts:77,158-183`; `src/lib/featureFlags.ts:1`). O prefixo
`sandbox-job` é dívida de nomenclatura, não prova de enfileiramento.

O B1 **é capaz** de abrir uma aba, mas apenas condicionalmente. O hook global:

1. exige `cwd`, `task` não vazia e um `agent` conhecido;
2. encontra projeto por `projectId` exato ou por igualdade de `cwd` com o diretório padrão;
3. descarta o evento se não houver projeto correspondente;
4. só então chama `createAgentTerminal`, passa `initialInput` e foca o workspace
   (`src/hooks/useAgentSpawnListener.ts:18-81`).

O hook está realmente montado depois da hidratação do store (`src/App.tsx:46,203-206`). A criação
normal persiste o terminal no projeto e pode provisionar worktree antes de cair no terminal comum
(`src/stores/projectsStore.terminalSlices.ts:54-155`). Portanto, `HTTP 200` hoje significa somente
“requisição autenticada e evento emitido”, não “aba criada” nem “PTY iniciado”.

**Evidência de execução de 2026-08-14:** a instância Lord PID `71252` escutava
`127.0.0.1:9123`; o discovery ativo era
`%LOCALAPPDATA%\com.lord.chassi\profiles\default\lord-agent-listener.json`; o `projects.json` do
mesmo perfil tinha zero projetos e zero terminais após o teste. Nessa condição, o descarte em
`useAgentSpawnListener.ts:48-51` é determinístico. A porta exata chamada pelo teste informado pelo
Guilherme é **NÃO CONFIRMADO**; havia também uma instância Alethe PID `24136` em `:9124`.

Há mais duas fragilidades:

- o payload tipado pelo hook não inclui nem conserva `job_id`, `mode`, pai ou profundidade
  (`src/hooks/useAgentSpawnListener.ts:9-16`), logo não há correlação fim a fim;
- o Agent Canvas registra outro consumidor do mesmo evento e pode criar um segundo PTY se essa
  view estiver montada (`src/components/AgentCanvasPOC/hooks/useAgentWorkers.ts:122-174`). A view
  não tem entrada normal verificada no app atual, mas o risco de consumidor duplo permanece.

O mecanismo de prompt em si é sólido: `initialInput` é persistido no `SubTab`
(`src/lib/types.ts:91-107`), aplicado pela fábrica (`src/lib/terminalFactory.ts:58-96`) e, depois de
o CLI ficar quieto, é escrito em chunks no PTY e submetido com `\r`
(`src/components/XTermView/useXtermSession.ts:1366-1394`). Isso satisfaz prompt visível e resposta
ao vivo; a falha está antes, no aceite/roteamento do spawn.

## 1.3 F1 — paridade visual do Cursor

### O que o chassi já modela

`AgentType` contém `shell`, `claude`, `codex`, `opencode`, `freebuff`, `mimo` e `antigravity`, mas
não `cursor` (`src/lib/types.ts:1-29`). `agentCliCommand` só trata `antigravity -> agy`; um valor
novo sem adaptação viraria literalmente `cursor`, não `cursor-agent` (`src/lib/types.ts:31-34`).
As preferências persistem agentes habilitados e política de recursos
(`src/lib/types.ts:328-404`), com backfill central em
`src/stores/projectsStore.migrations.ts:37-86,261-278`.

Cursor não tem paridade visual hoje:

- a Home oferece atalhos apenas para Claude, Codex, Antigravity e OpenCode
  (`src/components/HomeView/index.tsx:45-50,152-198`);
- o dispatcher de ícones conhece Claude, Codex e os demais tipos existentes; um tipo desconhecido
  cai no ícone do OpenCode (`src/components/icons/AgentIcons.tsx:74-90`), e não há asset Cursor;
- faltam tokens `--agent-cursor-*` no tema, que hoje terminam em Antigravity
  (`src/styles/theme.css:92-105`);
- modais de novo terminal, nova subaba e preferências têm listas/estados específicos para os tipos
  atuais (`src/components/modals/NewTerminalModal.tsx:15-48`;
  `src/components/modals/NewSubTabModal.tsx:14-22,43-80`;
  `src/components/modals/preferences/TerminalPage.tsx:14-22`);
- o monitor de conclusão só é instalado para Claude, Codex e OpenCode, e seu label de fallback é
  OpenCode (`src/components/XTermView/useXtermSession.ts:775-784,1145-1153`;
  `src/lib/agentCompletionMonitor.ts:124-127`);
- lançamento/retomada tem contratos específicos para Claude, Codex, OpenCode e Antigravity; Cursor
  não tem adaptador (`src/lib/sessionLaunch.ts:46-121`).

O uso exibido não é genérico. Home renderiza cartões Claude e Codex
(`src/components/HomeView/UsageStrip.tsx:186-393,497-509`); a TitleBar tem pills Claude, Codex e
Antigravity (`src/components/TitleBar/index.tsx:563-705`); `uiStore` mantém somente esses três
caches (`src/stores/uiStore.ts:61-71,134-175`); e o custo por sessão no Rust reconhece apenas
Claude, Codex e OpenCode (`src-tauri/src/agent_cost.rs:284-370`). Portanto, “adicionar um ícone”
não produz paridade de consumo.

### O que o CLI do Cursor realmente expõe

Na máquina observada, `cursor-agent` existe em
`%LOCALAPPDATA%\cursor-agent\cursor-agent.ps1`, versão `2026.08.11-e8db854`. O `--help` local
ofereceu `-p/--print`, `--output-format text|json|stream-json`, `--resume`, `--continue`,
`--model`, `--list-models`, `--force/--yolo`, modos de sandbox e opções de workspace. O resolver
genérico pode encontrá-lo pelo PATH, mas não procura explicitamente esse diretório quando o app é
aberto fora do shell (`src-tauri/src/cli_resolver.rs:132-188,249-276`).

A [referência oficial de parâmetros](https://docs.cursor.com/en/cli/reference/parameters) confirma
`cursor-agent`, `-p`, os três formatos, retomada e modelo. A
[especificação oficial de output](https://docs.cursor.com/en/cli/reference/output-format) documenta
eventos de sessão, texto, ferramenta, duração e resultado. **Ela não documenta percentual de
franquia, custo ou contagem de tokens.** A documentação informa que o detalhamento de consumo fica
no [dashboard de uso do Cursor](https://docs.cursor.com/account/pricing), não no contrato do CLI.

Conclusão honesta para F1: é possível entregar tipo de primeira classe, ícone, detecção, launch,
modelo consultado por `--list-models`, estado de autenticação e badges de processo. **Não é possível
prometer a mesma porcentagem de consumo de Claude/Codex com o contrato oficial atual.** O plano
deve mostrar “consumo indisponível no CLI” ou omitir o medidor e oferecer acesso ao dashboard.
Parser de campo não documentado ou scraping do dashboard não entra. O formato default diverge
entre a documentação rastreada e o `--help` local; qualquer execução headless deve passar o formato
explicitamente. Native Windows é observado localmente, mas o suporte oficial exato fora de WSL é
**NÃO CONFIRMADO**.

## 1.4 F2 — terminal de time e orquestração cruzada

Hoje não existe distinção de capacidade entre terminais: o tipo identifica o CLI, não o direito de
criar outro CLI (`src/lib/types.ts:1-34,91-107`). O listener usa um único bearer token global em
memória e grava esse token no discovery do perfil (`src-tauri/src/agent_events.rs:22-56`). Todo
processo do mesmo usuário que leia o arquivo pode tentar usar `/spawn`; não há concessão por PTY,
pai, projeto, provider, etapa, TTL ou profundidade.

O Canvas POC já instrui um agente a usar `/spawn`, mas a string de curl não envia
`X-Alethe-Token` e, portanto, recebe 401 no listener atual
(`src/lib/agentCanvasUtils.ts:54-68`; `src-tauri/src/agent_events.rs:30-34,168-174`). A mesma string
contém regras de escolha de worker e afirma custos de “centenas de MB” sem medição
(`src/lib/agentCanvasUtils.ts:60-66`): isso não deve ser promovido a arquitetura. Julgamento de
roteamento no chassi colide com ADR-0003; número não medido colide com a regra desta tarefa.

O Canvas tem teto local de três workers vivos (`src/lib/agentCanvasConfig.ts:42`;
`src/components/AgentCanvasPOC/hooks/useAgentWorkers.ts:138-148`), mas ele só existe enquanto a
view está montada, não é capability e não limita o hook global B1. Assim, o endpoint atual não
impede recursão, replay nem bomba de fork.

Há uma colisão direta com ADR-0006: esconder token/endpoint de terminais solo por convenção não é
contenção. Como os PTYs atuais rodam sob a mesma identidade do usuário e têm acesso amplo ao host,
separar capabilities por variável de ambiente seria apenas modo consultivo. A herança de
credenciais por filhos e a equivalência de sandboxes entre providers continuam explicitamente
pendentes de canários (`ADR-0006-seguranca-da-ferramenta.md:107-119`).

## 1.5 F3 — modos dev e animado

O app já tem peças úteis, mas não o produto pedido:

- workers cross-provider do Canvas são PTYs reais, podem nascer em background e abrir sob demanda
  (`src/components/AgentCanvasPOC/hooks/useAgentWorkers.ts:29-101`);
- o store do Canvas correlaciona hooks Claude por `agent_id`, mas quando o hook não traz prompt usa
  uma fila FIFO, sujeita a associação errada sob simultaneidade
  (`src/stores/agentCanvasStore.ts:9-18,145-225,304-317`);
- o card atual mostra prompt, ferramentas, resultado e custo
  (`src/components/AgentCanvasPOC/AgentNodeCard.tsx:20-93`), porém é POC e contém acoplamentos que
  não devem virar o novo modelo de domínio;
- para filhos cross-provider, `/spawn` mais `createAgentTerminal` já pode produzir um terminal real
  persistente. Para subagente nativo dentro do mesmo Claude, não nasce outro PTY: o máximo hoje é
  projeção por hook/transcript. Saída verbatim e ao vivo desse subagente é **NÃO CONFIRMADO**;
- observabilidade equivalente para subagentes nativos de Codex e Cursor é **NÃO CONFIRMADO**.

O modo animado colide potencialmente com o ADR-0008 se substituir a aba de execução e ocultar prompt
ou saída. Ele é compatível somente se for outra projeção do mesmo run e o clique abrir o terminal
real, preservando o que `ADR-0008-visibilidade-da-orquestracao.md:65-85` tornou obrigatório. Um
balão não pode inventar pensamento interno: a documentação do Cursor declara que eventos de
`thinking` são suprimidos no modo print. Texto animado só pode derivar de estado estruturado e
observável, como “aguardando”, “executando ferramenta X” e “processo terminou”.

## 1.6 F4 — memória e scrollback

### Custos e limites reais já implementados

- Cada PTY vivo mantém uma cauda de scrollback de até **4 MiB em RAM**. O arquivo é compactado
  quando passa de **8 MiB**, retendo os últimos 4 MiB
  (`src-tauri/src/pty.rs:19-24,1383-1393,1396-1454,1474-1516`). Isso é teto por bytes de output,
  não o custo total do processo do agente.
- Quando o PTY morre, a cauda é persistida e o buffer backend é liberado
  (`src-tauri/src/pty.rs:701-733`).
- O xterm mantém ainda scrollback frontend por linhas: 3.000/6.000 para shell/agente em orçamento
  até 1.536 MB; 5.000/8.000 até 3.072 MB; 6.000/10.000 acima disso
  (`src/components/XTermView/terminalInput.ts:9-18`). Linhas não permitem converter para bytes sem
  medir o conteúdo. TUIs no alternate buffer não usam o scrollback normal da mesma forma
  (`src/components/XTermView/terminalInput.ts:20-29`).
- Painéis ocultos deixam de receber/renderizar o fluxo completo, embora o backend continue
  armazenando scrollback (`src/components/XTermView/useXtermSession.ts:695-797`). Isso reduz CPU/UI,
  não a memória do processo filho.
- O monitor de recursos amostra a cada 5 s e mede árvore de processos por PTY
  (`src-tauri/src/resources.rs:12,250-375`; `src/hooks/useResourceSupervisor.ts:20,235-243`). A
  janela da UI guarda no máximo 720 amostras (`src/stores/uiStore.ts:57-59,165-170`).
- A política default é `manual`; `smart-lru` pode estacionar um candidato não visível/não focado
  e ordena por tipo, LRU e memória (`src-tauri/src/resources.rs:27-60,393-476`). A suspensão
  específica de PTY mata a árvore, preserva scrollback/identidade e espera o flush
  (`src-tauri/src/pty.rs:1124-1185`).
- “Suspender grupo” realmente libera processos, mas usa `cleanupPtys -> killPty`, remove sessão e
  apaga scrollback (`src/stores/projectsStore.projectSlices.ts:109-140`;
  `src/lib/terminalLifecycle.ts:6-26`; `src-tauri/src/pty.rs:1110-1119`). Ao retomar, os terminais
  são apenas reabilitados (`src/stores/projectsStore.projectSlices.ts:142-164`). Não é a mesma
  hibernação preservadora de `suspend_pty`.
- A fila de spawn tem concorrência configurável, default 3 (`src/lib/types.ts:519-528`), mas é
  controle de rajada, não teto de agentes vivos. Mesmo sob bloqueio de memória ela libera progresso
  depois de 1,5 s; o backend também prossegue depois de esperar memória por tempo limitado. Logo,
  os mecanismos atuais não são um limite fail-closed para orquestração.

### O que não foi medido

O custo incremental real de um processo Claude, Codex, Cursor ou OpenCode — idle, após prompt,
durante ferramenta e após conclusão — é **NÃO CONFIRMADO**. A afirmação de “centenas de MB” em
`agentCanvasUtils.ts:66` não é benchmark. Também não estão medidos: custo do webview/xterm por aba,
duplicação entre buffer do provider, ConPTY, backend e xterm, nem p95 de um fan-out. Portanto este
plano não escolhe um orçamento numérico; primeiro define o experimento e só depois pede aprovação.

# 2. Decisões de desenho assumidas

## D1. Corrigir o contrato B1 antes de construir F2/F3

**Assunção:** `/spawn` passa a ter protocolo versionado, idempotência, correlação e estados
observáveis; “evento emitido” não será chamado de `queued` sem fila. O pai recebe um `request_id`, e
o estado só chega a `terminal_created` e `pty_started` após confirmação real do frontend/runtime.

**Alternativa rejeitada:** manter HTTP 200 fire-and-forget. Ela repete exatamente o falso positivo
observado e impossibilita limite, revogação, animação e medição por run.

**[DECISÃO DO GUILHERME]:** compatibilidade da rota atual: (A) introduzir `/v1/spawns` e manter
`/spawn` como legado com aviso; ou (B) corrigir `/spawn` de forma incompatível antes de haver
consumidores externos. Recomendação: **B**, se o B1 ainda não tem cliente publicado; caso contrário,
**A**.

## D2. “Time” é capability; Cursor/Claude/Codex são runtimes

**Assunção:** adicionar `orchestrationMode: 'solo' | 'team'` ao terminal/subaba, com backfill
`solo`. `AgentType` continua representando o executável.

**Alternativa rejeitada:** criar `AgentType = 'team'`. Isso mistura quem executa com o que pode
fazer, quebra ícones/launch/uso e impede “Claude solo” versus “Claude de time”.

## D3. Cursor de primeira classe sem medidor inventado

**Assunção:** `cursor` ganha identidade, ícone, resolver, launch, modelos e estado de processo. O
chassi não mostra porcentagem/custo enquanto o contrato oficial não fornecer dados verificáveis.

**Alternativas rejeitadas:** scraping do dashboard, estimativa por caracteres, parsing de campo
não documentado ou reaproveitar o medidor de outro provider. Todos criam número falso ou frágil.

**[DECISÃO DO GUILHERME]:** apresentação sem consumo: (A) card/pill “CLI conectado · consumo no
dashboard”; ou (B) nenhum pill de consumo, apenas identidade no terminal. Recomendação: **A**, sem
barra nem porcentagem.

## D4. A concessão cross-provider é uma lease restrita e monotônica

**Assunção:** uma lease efêmera liga pai, projeto/cwd, providers permitidos, expiração,
profundidade, concorrência, total de filhos, taxa e versão de capability. Filhos nascem `solo`.
Delegação, se aprovada, só pode reduzir limites. Requisição repetida com a mesma chave é idempotente.
Revogar impede novos filhos imediatamente.

**Alternativa rejeitada:** passar o token global do discovery por variável de ambiente. Qualquer
filho pode herdá-lo; ele concede toda a rota e não representa a interseção do ADR-0006.

**[DECISÃO DO GUILHERME]:** valores de `maxDepth`, `maxConcurrentChildren`, `maxTotalChildren`,
`maxSpawnsPerMinute` e TTL; e se revogação (A) só nega novos spawns ou (B) também encerra
descendentes ainda vivos. Nenhum valor deve ser escolhido pelo implementador.

## D5. F2 de produção depende da fronteira de segurança escolhida

**Assunção:** somente o plano de controle externo (Repo B) pode pedir a concessão; o chassi aplica
uma capability genérica e não contém regra de julgamento.

**Alternativas possíveis — decisão não delegável:**

- **[DECISÃO DO GUILHERME — A, produção]:** broker sob identidade/ACL separada mais sandbox externo
  e canários fail-closed. É a opção compatível com a promessa plena do ADR-0006.
- **[DECISÃO DO GUILHERME — B, piloto consultivo]:** token por terminal, expiração e limites, mas
  explicitamente rotulado “não é fronteira de segurança”. Serve para validar UX, não para dados
  sensíveis nem promessa de contenção.
- **[DECISÃO DO GUILHERME — C, adiar]:** não habilitar terminal de time até existir a fundação de
  segurança externa.

Não é lícito chamar B de sandbox seguro. A recomendação arquitetural é **A**; se o objetivo imediato
for apenas validar interação local, **B** só com aceite explícito do risco.

## D6. Dev e animado são projeções do mesmo run

**Assunção:** o PTY e o estado de execução são únicos. No modo dev ele é aberto/mostrado; no modo
animado ele roda em background e um card animado o projeta, com clique que foca o terminal real.
Trocar preferência não recria processo nem perde correlação.

**Alternativa rejeitada:** implementar dois motores. Isso duplica lifecycle, uso de memória e
comportamentos de segurança.

**[DECISÃO DO GUILHERME]:** modo default e interpretação do ADR-0008. Se o terminal ficar apenas a
um clique no modo animado, isso conta como “usuário vê ao vivo” ou o ADR deve ser emendado? Sem
resposta, o default seguro é **dev** e o modo animado não substitui a aba aberta.

## D7. Subagente nativo não será fingido como PTY independente

**Assunção:** filho cross-provider criado por `/spawn` aparece em PTY real. Filho interno do mesmo
provider aparece como card/transcript **somente com os dados que o provider realmente emite**, com
rótulo “subagente interno — visualização somente leitura”.

**Alternativa rejeitada:** desenhar um xterm falso com saída reconstruída. Viola o terminal real do
ADR-0008 e cria a impressão de interação bidirecional inexistente.

**[DECISÃO DO GUILHERME]:** se saída live verbatim não existir para subagentes nativos, aceitar
card de atividade + transcript final ou exigir que toda delegação visível use um novo PTY via
`/spawn`. A segunda opção muda a semântica/custo e não deve ser tomada pelo chassi.

## D8. Persistir identidade mínima; evidência e julgamento ficam fora

**Assunção:** `SubTab` persiste apenas modo, origem e IDs estáveis necessários para retomar/focar.
O grafo de eventos do run é efêmero no chassi; a evidência canônica continua no Repo B/arquivos.

**Alternativa rejeitada:** persistir prompts, decisões e todo o grafo em `projects.json`. Isso
aumenta schema/divergência, pode vazar segredos e invade o cérebro. O ADR-0008 já diz que scrollback
ou aba não substituem evidência (`ADR-0008-visibilidade-da-orquestracao.md:86-96`).

## D9. Orçamento de memória será derivado de medição

**Assunção:** conservar os tetos existentes inicialmente, medir por provider e calcular orçamento
com baseline + p95 dos filhos simultâneos + reserva aprovada. Limite de filhos é hard cap antes de
spawn; política de RAM é uma segunda camada.

**Alternativa rejeitada:** usar o número textual do Canvas ou escolher “um valor razoável”. Não há
base empírica e providers/versões mudam.

**[DECISÃO DO GUILHERME]:** aprovar, depois do benchmark, orçamento total, reserva mínima, limites
por provider e política de pressão: recusar, enfileirar ou hibernar. Recomendação de segurança:
falhar fechado para novo filho quando o orçamento efetivo não comportar o spawn.

## D10. Estratégia upstream por fatia, não um PR Lord

**Assunção:** Cursor genérico, correção do ack, correlação genérica, hibernação e projeção de
processo são candidatos a PRs pequenos upstream. Branding Lord, defaults do produto e integração
com o cérebro ficam no fork.

**Alternativa rejeitada:** um PR monolítico F1–F4. Mistura política específica com mecanismos
reutilizáveis, dificulta revisão e aumenta conflito futuro.

# 3. Fatias de implementação por dependência

Cada fatia abaixo deve terminar sozinha, sem deixar feature parcialmente “ligada”. Features novas
também atualizam `docs/CHANGELOG.md` em `[Não lançado]`, em inglês, conforme
`docs/CHANGELOG.md:7-15`; strings visíveis entram em `en.ts` e `pt-BR.ts`. Os comandos de gate já
existem em `package.json:7-20`.

## Fatia 0 — congelar decisões e protocolo v1 **[MODELO FORTE]**

- **Depende de:** respostas D1, D3–D7 e parâmetros D4; escolha de segurança D5 é bloqueante.
- **Escopo/arquivos:** produzir ADR/adendo no Repo B e especificação pública do protocolo na
  fronteira; no chassi, futuramente apenas um documento genérico de contrato. Não implementar.
- **Entrada:** escolhas explícitas do Guilherme, fórmula de capability do ADR-0006 e estados do
  ADR-0008.
- **Saída contratual:** JSON Schema/versionamento para `SpawnRequest`, `SpawnAccepted`,
  `SpawnStatus`, `SpawnRevoked`; máquina de estados e matriz de erros; sem regra de julgamento.
- **Oráculo:** todos os campos, transições, códigos 4xx/5xx, compatibilidade e parâmetros têm uma
  decisão registrada; nenhum item marcado `TBD` chega à Fatia 1.
- **Por que forte:** congela interface pública, segurança e semântica irreversível.

## Fatia 1 — tornar o B1 verdadeiro e testável **[MODELO FORTE]**

- **Arquivos:** `src-tauri/src/agent_events.rs`, `src-tauri/src/lib.rs`, novo módulo Rust de estado
  de spawn se necessário; `src/hooks/useAgentSpawnListener.ts`; testes Rust e Vitest focados.
- **Entrada:** request v1 autenticado com `request_id`, provider, task, cwd/projeto e origem.
- **Saída contratual:** aceite distingue `received` de `terminal_created`/`pty_started`; falha de
  validação ou projeto inexistente vira estado terminal explícito; `job_id` não é perdido; um único
  consumidor cria a aba.
- **Oráculo:** testes provam (1) zero projetos -> `rejected/no_matching_project`; (2) projeto
  correspondente -> exatamente um terminal; (3) request repetido -> o mesmo terminal; (4) emitir
  evento sem consumidor não retorna “queued”. Rodar `npm test` e `npm run test:rust`.
- **Por que forte:** concorrência backend/frontend, idempotência e evolução de protocolo.

## Fatia 2 — extrair resolução B1 em funções puras **[MODELO PEQUENO]**

- **Arquivos:** `src/hooks/useAgentSpawnListener.ts`, novo helper próximo ao hook, novo teste em
  `tests/`.
- **Entrada:** payload validado e snapshot de projetos.
- **Saída contratual:** `resolveSpawnTarget` retorna união discriminada `matched | invalid |
  no_project`, sem efeito colateral; o hook só executa a decisão.
- **Oráculo:** Vitest cobre projectId válido/inválido, cwd equivalente/não equivalente, task vazia,
  provider inválido e store não hidratado; `npm test -- useAgentSpawnListener` passa.
- **Por que pequeno:** refatoração local com contrato e casos já definidos na Fatia 1.

## Fatia 3 — adapter de launch do Cursor **[MODELO PEQUENO]**

- **Arquivos:** `src/lib/types.ts`, `src/lib/sessionLaunch.ts`,
  `src-tauri/src/cli_resolver.rs`, testes correspondentes, `docs/CHANGELOG.md`.
- **Entrada:** `AgentType='cursor'`, caminho configurado ou PATH/instalação local, args interativos.
- **Saída contratual:** comando resolve para `cursor-agent` (ou alias oficial detectado), sem usar
  flags irrestritas por default; `--list-models` é consultado por adaptador próprio e falha sem
  bloquear launch básico.
- **Oráculo:** teste Rust resolve fixture `cursor-agent(.cmd/.ps1/.exe)`; teste TS garante comando e
  args; `npm run build`, `npm test`, `npm run test:rust`; observação manual cria PTY Cursor e mostra
  a TUI correta.
- **Por que pequeno:** integração mecânica depois de congelar permissões. Retomada fica fora desta
  fatia porque o schema de `cursor-agent ls` é **NÃO CONFIRMADO**.

## Fatia 4 — identidade visual completa do Cursor **[MODELO PEQUENO]**

- **Arquivos:** `src/components/icons/AgentIcons.tsx`, asset de origem/licença verificada,
  `src/styles/theme.css`, `src/components/HomeView/index.tsx`, modais de terminal/subaba,
  `src/components/modals/preferences/TerminalPage.tsx`, `src/lib/i18n/messages/en.ts`,
  `src/lib/i18n/messages/pt-BR.ts`, testes, `docs/CHANGELOG.md`.
- **Entrada:** `AgentType='cursor'` funcional da Fatia 3.
- **Saída contratual:** Cursor selecionável/habilitável, ícone correto em Home/sidebar/pane/subaba,
  token de tema próprio e nenhuma queda no ícone OpenCode; strings traduzidas.
- **Oráculo:** `npm run build` valida exaustividade/i18n; teste de `AgentIcon('cursor')`; inspeção
  objetiva nos quatro pontos visuais e em tema claro/escuro; busca não encontra cor literal nova.
- **Por que pequeno:** alterações exaustivas, mas sem nova semântica.

## Fatia 5 — cartão honesto de disponibilidade Cursor **[MODELO PEQUENO]**

- **Depende de:** decisão D3.
- **Arquivos:** `src/components/HomeView/UsageStrip.tsx`, `src/components/TitleBar/index.tsx`,
  `src/stores/uiStore.ts` somente se houver cache de status, wrapper Tauri de CLI status, i18n,
  testes e changelog.
- **Entrada:** resultado estável de “CLI instalado/autenticado”; não recebe porcentagem.
- **Saída contratual:** estado textual e link ao dashboard, ou ausência de pill conforme decisão;
  nunca produz `%`, token ou custo Cursor.
- **Oráculo:** fixtures instalado/autenticado, instalado/desautenticado e ausente; teste procura e
  rejeita `%`/progressbar no card Cursor; `npm run build && npm test`.
- **Por que pequeno:** apresentação fechada; nenhum parser financeiro.

## Fatia 6 — canários e threat model do spawn **[MODELO FORTE]**

- **Depende de:** decisão D5; bloqueia todo terminal de time.
- **Arquivos:** novo módulo/testes de segurança do broker no chassi; harness de canários; eventual
  parte de identidade/sandbox pertence ao Repo B, não a este repositório.
- **Entrada:** processos solo, team, filho, token expirado/roubado, cwd fora do escopo, rede negada,
  request em replay e runtime sem sandbox.
- **Saída contratual:** matriz pedido/teto/efetiva e resultado de cada canário; produção falha
  fechada; piloto degradado retorna rótulo inequívoco.
- **Oráculo:** testes negativos demonstram que solo, token expirado, provider fora do teto,
  profundidade excedida e cwd divergente recebem negação e **nenhum PID/PTY novo aparece**.
- **Por que forte:** adversarial, identidade de processo e promessa de segurança.

## Fatia 7 — persistir `solo | team` com migração **[MODELO PEQUENO]**

- **Arquivos:** `src/lib/types.ts`, `src/stores/projectsStore.migrations.ts`, factories/slices de
  terminal, modal de criação, preferências se aplicável, i18n, testes, changelog.
- **Entrada:** projetos v2–v6 e novos terminais com modo escolhido.
- **Saída contratual:** registros antigos e ausentes normalizam para `solo`; modo é visível e
  persistido; trocar apresentação não troca capability.
- **Oráculo:** fixtures de cada versão migram sem perda; terminal legado é `solo`; round-trip salvar/
  carregar mantém `team`; `npm run build && npm test`.
- **Por que pequeno:** schema e backfill explícitos, sem enforcement ainda; a UI `team` permanece
  desabilitada por feature gate até a Fatia 9.

## Fatia 8 — broker de leases e máquina de estados **[MODELO FORTE]**

- **Arquivos:** novo `src-tauri/src/orchestration_capabilities.rs` (nome indicativo), registro em
  `src-tauri/src/lib.rs`, tipos/wrappers em `src/lib/tauri/`, testes Rust.
- **Entrada:** concessão assinada/autenticada pelo plano de controle e spawn ligado ao PTY pai.
- **Saída contratual:** lease em memória com TTL, escopo, caps, profundidade e revogação; IDs
  opacos; concessão filha nunca amplia a efetiva; logs não contêm segredo.
- **Oráculo:** testes de interseção e negação, relógio controlável para expiração, concorrência
  atômica em N requests, replay idempotente e revogação; `npm run test:rust`.
- **Por que forte:** estado concorrente e capability de segurança.

## Fatia 9 — terminal de time chama outro runtime **[MODELO FORTE]**

- **Arquivos:** `src-tauri/src/agent_events.rs`, broker da Fatia 8,
  `src/components/XTermView/useXtermSession.ts`, `src/hooks/useAgentSpawnListener.ts`, stores de
  terminal, i18n, testes, changelog.
- **Entrada:** terminal `team` com lease válida e request `/v1/spawns`; terminal `solo` sem lease.
- **Saída contratual:** somente team recebe canal/handle scoped; filho nasce solo, com
  `parent_request_id`, `depth+1`, provider e cwd aprovados; status liga pai -> request -> terminal ->
  PTY; feature gate só abre após canários verdes.
- **Oráculo:** cenário Claude-team -> Codex cria exatamente uma aba e o prompt aparece verbatim;
  Claude-solo fazendo a mesma chamada é negado; filho tentando neto é negado ou permitido conforme
  `maxDepth`; N+1 além do cap não cria processo. Verificar por teste mais snapshot de processos.
- **Por que forte:** junta segurança, PTY, correlação e concorrência.

## Fatia 10 — store de projeção de orquestração **[MODELO PEQUENO]**

- **Arquivos:** novo store Zustand efêmero, tipos de evento/run, adaptador do B1 e testes de reducer.
- **Entrada:** eventos estruturados `requested`, `accepted`, `terminal_created`, `pty_started`,
  `tool_started`, `tool_finished`, `process_exited`, `failed`, `revoked`.
- **Saída contratual:** `OrchestrationRun` correlacionado por IDs, provider, pai e terminal; reducer
  ignora repetição, rejeita regressão de estado e não interpreta sucesso de conteúdo.
- **Oráculo:** tabela de transições completa em Vitest, inclusive evento duplicado/fora de ordem;
  nenhum campo de prompt/julgamento é persistido em `projects.json`.
- **Por que pequeno:** contrato fechado pelas Fatias 0/1/8; lógica pura.

## Fatia 11 — modo dev **[MODELO PEQUENO]**

- **Arquivos:** Workspace/TerminalPane/SubTabsLane, componentes CSS Modules próprios, store da
  Fatia 10, i18n, testes e changelog.
- **Entrada:** run com terminal/PTY real já criado.
- **Saída contratual:** abre/foca conforme preferência, exibe origem e estado sem cor de “aprovado”,
  mantém prompt e saída no xterm normal; múltiplos filhos não roubam foco repetidamente.
- **Oráculo:** teste de UI: um spawn -> uma aba; prompt é o primeiro input; output chega pelo evento
  PTY; clique no pai/filho foca o terminal correto; processo concluído é rotulado “terminou”, não
  “aprovado”. `npm run build && npm test` mais observação manual objetiva.
- **Por que pequeno:** usa componentes e lifecycle existentes; sem novo processo.

## Fatia 12 — spike de subagentes nativos **[MODELO FORTE]**

- **Arquivos:** fixtures/harness para hooks Claude e, se oficialmente suportado, eventos Codex e
  Cursor; não construir UI final nesta fatia.
- **Entrada:** duas chamadas simultâneas do mesmo tipo, tool calls, sucesso, erro e interrupção.
- **Saída contratual:** matriz por provider: ID estável, prompt verbatim, output live, transcript
  final, ferramentas, custo e completion; cada célula `sim/não/NÃO CONFIRMADO` com evidência.
- **Oráculo:** fixtures reproduzíveis demonstram correlação sem FIFO; se só houver FIFO, a coluna
  “concorrência segura” falha e a UI não habilita essa projeção.
- **Por que forte:** protocolos externos incompletos e risco de atribuir fala ao agente errado.

## Fatia 13 — preferência e modo animado **[MODELO PEQUENO]**

- **Depende de:** decisão D6 e matriz da Fatia 12.
- **Arquivos:** `src/lib/types.ts`, migração/defaults, página de preferências, novo componente
  animado + `.module.css`, workspace, i18n, testes, changelog.
- **Entrada:** o mesmo `OrchestrationRun` e terminal da Fatia 11.
- **Saída contratual:** preferência `developer | animated`; boneco usa apenas tokens do tema e
  estados estruturados; balão não mostra pensamento inventado; clique foca terminal; reduced motion
  desliga movimento sem perder estado.
- **Oráculo:** alternar modo mantém o mesmo `ptyId`; clique abre saída live; teste de
  `prefers-reduced-motion`; screenshots claros/escuros sem gradiente/cor literal; `npm run build`.
- **Por que pequeno:** projeção visual com dados já estabilizados. Se o design ainda não estiver
  aprovado, a fatia passa a **MODELO FORTE**.

## Fatia 14 — benchmark real de memória **[MODELO FORTE]**

- **Arquivos:** harness de diagnóstico baseado em `get_resource_snapshot`, exportação versionada de
  amostras e documentação do procedimento; não alterar caps nesta fatia.
- **Entrada:** baseline limpo; por provider: cold start, idle, prompt padronizado, ferramenta,
  conclusão, suspensão e retomada; fan-out 1..N dentro de um limite manual seguro.
- **Saída contratual:** dataset com versão do app/CLI, SO, RAM total, provider/model, timestamp,
  parent/run/pty, working set, private bytes, pico, p50/p95, número de processos e estado visível/
  oculto/suspenso. Segredos e texto do prompt não entram.
- **Oráculo:** executar duas rodadas cold/warm por cenário; totais batem com a árvore de processos;
  suspensão mostra queda mensurável e retomada preserva scrollback. Se não houver repetibilidade,
  resultado é “inconclusivo”, não um número de orçamento.
- **Por que forte:** desenho experimental e interpretação sem confundir cache/ruído com custo.

## Fatia 15 — hard caps antes do spawn **[MODELO FORTE]**

- **Depende de:** benchmark e decisões D4/D9.
- **Arquivos:** broker, resource supervisor/backend, preferências, store de projeção, UI/i18n,
  testes e changelog.
- **Entrada:** lease válida mais snapshot atual e caps aprovados.
- **Saída contratual:** reserva atômica de slot/memória antes do processo; `queued` só existe se
  houver fila real e cancelável; `rejected_resource_limit` não cria PTY; liberação em exit/falha/
  revogação.
- **Oráculo:** corrida com N requests respeita exatamente o cap; N+1 não aumenta PID nem memória de
  árvore; slot é devolvido em todos os caminhos; teste sob pressão não usa o escape de 1,5 s da fila
  genérica. `npm run test:rust && npm test`.
- **Por que forte:** contabilidade concorrente e prevenção de fork bomb.

## Fatia 16 — hibernar execução inativa com segurança **[MODELO FORTE]**

- **Arquivos:** lifecycle de terminal, `suspend_pty`, session launch/resume por provider, supervisor,
  store de projeção, UI/i18n e testes.
- **Entrada:** run explicitamente terminado ou idle elegível, não visível, não focado, sem gate/
  tool ativo e provider com retomada comprovada.
- **Saída contratual:** usa suspensão preservadora, não `cleanupPtys`; libera processo, conserva
  scrollback e identidade; provider sem retomada comprovada é encerrado somente por ação explícita
  e recebe rótulo correto.
- **Oráculo:** snapshot mostra processo ausente após hibernação; reabrir recupera scrollback e, onde
  suportado, sessão; terminal visível/focado/working nunca é hibernado; timeout/erro de flush mantém
  estado de falha e não finge sucesso.
- **Por que forte:** risco de perda de sessão/trabalho e diferenças entre CLIs.

## Fatia 17 — gate integrado e estratégia de upstream **[MODELO FORTE]**

- **Arquivos:** testes de integração, documentação/changelog; nenhuma publicação automática.
- **Entrada:** F1–F4 atrás de flags, decisões registradas e canários aprovados.
- **Saída contratual:** matriz solo/team x provider x modo visual x pressão de memória; lista de
  commits/PRs proposta separando genérico de Lord-specific.
- **Oráculo:** `npm run build`, `npm test`, `npm run test:rust`; ensaio manual sem reiniciar/matar o
  app já aberto: Cursor abre com ícone correto; solo não spawna; team respeita caps; dev e animado
  apontam para o mesmo PTY; hibernação reduz processos e preserva evidência. `git diff --name-only`
  não mostra conteúdo de julgamento no chassi. Commit/PR só com nova autorização do Guilherme.
- **Por que forte:** gate sistêmico, segurança e decisão de divergência/upstream.

# 4. Riscos e mitigação

| Prioridade | Risco | Evidência | Mitigação/gate |
|---|---|---|---|
| **1 — crítico** | **Escalada de capability e fork bomb.** Um agente comprometido cria filhos, herda credenciais, recursa ou drena RAM/custo. | Token atual é global e gravado em discovery (`agent_events.rs:22-56`); não há pai/profundidade/cap (`agent_events.rs:183-228`). O ADR-0006 exige interseção, expiração e fail-closed (`:48-79`). | F2 desligada até Fatias 6, 8, 9 e 15; lease scoped, filhos solo, hard caps atômicos, TTL, idempotência, canários e escolha explícita produção vs consultivo. |
| **2 — alto** | **B1 declara sucesso sem aba.** O cérebro pode acreditar que delegou enquanto nada executou; retries podem futuramente duplicar terminais. | `accepted/queued` é retornado após `emit` ignorado (`agent_events.rs:202-220`); o hook descarta sem projeto (`useAgentSpawnListener.ts:48-51`). | Corrigir contrato/idempotência primeiro; estados confirmados pelo consumidor; teste com zero projetos, mismatch e duplicidade. |
| **3 — alto** | **Explosão de memória/processos.** Cada filho é CLI completo além de ConPTY, buffers e xterm; fila atual não é hard cap. | 4 MiB backend por PTY mais linhas xterm (`pty.rs:19-24`; `terminalInput.ts:9-18`); spawn sob pressão ainda progride; custo do provider não medido. | Benchmark antes de orçamento; slots antes de spawn; fail-closed; suspensão preservadora; telemetry por run/provider. |
| **4 — alto** | **Divergência do upstream.** Schema, stores, workspace, resource supervisor e Rust listener são áreas centrais de alto conflito. | Fork deve permanecer mínimo e mecanismos genéricos voltar por PR (`LORD-CHASSI.md:268-281`; ADR-0003 `:73-85`; ADR-0008 `:91-96,118-126`). | PRs pequenos: Cursor adapter; ack/idempotência; lifecycle genérico; resource caps. Manter julgamento/branding/defaults Lord fora dos PRs. Rebase/teste por fatia. |
| **5 — alto** | **Violação de licença/fronteira.** Regras de “quem chamar e por quê” entram no AGPL. | Canvas já contém instrução de escolha (`agentCanvasUtils.ts:54-68`); ADR-0003 reserva julgamento ao Repo B (`:73-87`). | Chassi recebe apenas provider/task/capability já decididos; revisão de diff procurando prompts/regras de roteamento; protocolo estreito/versionado. |
| **6 — médio/alto** | **UI animada mascara execução ou inventa pensamento.** | ADR-0008 exige prompt/saída ao vivo (`:65-85`); Cursor suprime thinking no output oficial. | Mesmo PTY em ambos os modos; um clique para terminal; balão só de eventos estruturados; default dev até decisão. |
| **7 — médio/alto** | **Correlação errada de subagente nativo.** Fala/resultado pode ser atribuído ao filho errado. | Store atual usa fallback FIFO (`agentCanvasStore.ts:9-18,304-317`). | Spike concorrente; exigir ID estável; degradar para card não correlacionado ou desabilitar, nunca adivinhar. |
| **8 — médio** | **Paridade Cursor falsa ou frágil.** UI mostra consumo que o CLI não garante; update quebra parser/session resume. | Contrato oficial de stream não documenta uso; backend de custo não reconhece Cursor (`agent_cost.rs:284-370`). | Sem porcentagem; capability probe/versionamento; ignorar campos desconhecidos; sessão resume só após fixture estável. |
| **9 — médio** | **Suspensão perde dados.** Confundir suspensão de grupo com hibernação apaga scrollback/sessão. | Grupo usa `killPty` (`projectsStore.projectSlices.ts:109-140`; `terminalLifecycle.ts:6-26`); `suspend_pty` é o caminho preservador (`pty.rs:1124-1185`). | Fatia 16 usa apenas API preservadora; flush barrier; testes de retomada por provider; nunca autoencerrar por heurística de idle. |

# 5. O que não fazer nesta rodada

| Não fazer | Motivo | Gatilho para reabrir |
|---|---|---|
| Não ligar F2 para uso de produção com o token global atual. | Contraria a capability efetiva e o fail-closed do ADR-0006. | Broker/identidade/sandbox escolhidos, canários negativos verdes e aceite explícito do Guilherme. |
| Não colocar prompts de roteamento, critérios de escolha, história ou julgamento no chassi. | Conteúdo pertence ao Repo B pelo ADR-0003. | Nunca para conteúdo proprietário; só reabrir para mecanismo genérico revisável upstream. |
| Não criar porcentagem, custo ou tokens do Cursor por estimativa/scraping. | API oficial não garante os dados. | Cursor publicar contrato oficial estável ou API autorizada; fixtures e termos revisados. |
| Não implementar resume do Cursor nesta primeira paridade. | `cursor-agent ls/resume` existe, mas schema e estabilidade de discovery local são NÃO CONFIRMADOS. | Spike com versões suportadas, fixtures estáveis e estratégia de migração/fallback. |
| Não transformar subagente nativo em xterm falso. | Não é PTY real e pode atribuir output ao filho errado. | Provider oferecer stream live correlacionado por ID ou Guilherme aceitar explicitamente viewer somente leitura. |
| Não fazer o balão narrar “pensamento” do agente. | Não há fonte confiável; cria falsa transparência. | Nunca para chain-of-thought; reabrir apenas para eventos estruturados documentados. |
| Não autoencerrar/hibernar porque o monitor viu 4,5 s de silêncio. | O monitor atual é heurístico; silêncio pode ser aprovação, rede ou ferramenta longa. | Evento explícito de lifecycle ou detector por provider comprovado em testes negativos. |
| Não reduzir/aumentar scrollback nem definir orçamento de RAM agora. | O teto backend já existe, mas o custo total e p95 por provider não foram medidos. | Dataset da Fatia 14, decisão D9 e teste de retenção/retomada. |
| Não reutilizar Agent Canvas POC como núcleo de F2/F3. | Listener duplicado, auth incompatível, FIFO de correlação e regras de julgamento acopladas. | Componentes isolados podem ser reaproveitados só após extração genérica e testes; o store/fluxo POC não é fundação. |
| Não persistir grafo completo, prosa ou veredito em `projects.json`. | Aumenta divergência, risco de segredo e cruza a fronteira com o cérebro. | Um ADR posterior definir retenção mínima e classificação de dados; evidência continua no Repo B. |
| Não abrir PR, commit, tag, instalador ou release. | Esta tarefa autoriza apenas planejamento. | Nova autorização explícita do Guilherme no momento da ação. |

## Sequência mínima recomendada

O caminho crítico é: **decisões (0) -> B1 correto (1–2) -> Cursor honesto (3–5) -> canários e
capability (6–9) -> projeção dev (10–11) -> spike nativo e animado (12–13) -> benchmark, caps e
hibernação (14–16) -> gate/upstream (17)**. F1 pode ser entregue antes de F2. F3 deve usar o mesmo
run de F2. F4 não é uma etapa final cosmética: benchmark e hard cap bloqueiam a habilitação segura
do fan-out.
