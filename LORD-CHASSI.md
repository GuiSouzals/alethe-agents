# LORD-CHASSI — desenho da aba condutora sobre o fork do Alethe

> Repositório: fork de `Kc1t/alethe-agents` em `GuiSouzals/alethe-agents`, criado em
> 2026-08-13. Base auditada: commit `ea27ae5`, versão **1.5.0** (`package.json`,
> `Cargo.toml`). Licença herdada: **AGPL-3.0-or-later**.
> Documento escrito pelo Claude Code em 2026-08-13, por autorização do Guilherme.
> Estudo de origem: `estudo IA/notas/auditoria-alethe-agents.md` (dono: Cursor).

---

## 1. O que é este fork

O chassi do **Lord Orchestration Agent**. O Alethe já é o que o plano do Lord descreve
como chassi: um *workspace* (área de trabalho) desktop em Tauri 2, com PTYs reais
(`portable-pty` + xterm.js), painéis, abas persistentes e histórico de sessão, hospedando
CLIs de agente (`claude`, `codex`, `opencode`, e outros) como processos spawnados.

O que **não** entra aqui, por decisão de arquitetura (ADR-0003, aceito em 2026-08-13):
diagnóstico, elicitação, contratos, recomendação ideal/viável, gates, régua — todo o
conteúdo de julgamento do Lord. Isso mora no Repo B, com licença própria, e fala com este
chassi por **fronteira de processo**: executar, passar arquivo, ler saída. Nunca por
`import`, nunca por link de código.

Consequência prática para quem escreve neste repositório: **todo código commitado aqui
nasce AGPL-3.0-or-later.** Se um recurso é vendável, ele não pode ser escrito aqui.

---

## 2. A topologia que o Guilherme pediu

Literal, do enunciado do trabalho:

> "é interessante que seja visual, que dê pra ele ver você acionando outra IA e ver o que
> você pediu... abre um terminal e ele vê você pedindo pra outra IA, tudo dentro dessa
> ferramenta"

Traduzido em topologia, decidida por ele:

```
┌─────────────────────────────────────────────────────────────────────┐
│  [ Lord ]  [ fatia 1 · codex ]  [ fatia 2 · claude ]  [ + ]         │  ← barra de abas
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Aba condutora (Lord)            │  Aba de execução (por fatia)    │
│   ───────────────────             │  ────────────────────────       │
│   O cérebro roda aqui.            │  Aberta PELO Lord, não pelo     │
│   Decide o corte em fatias,       │  humano. O prompt entra         │
│   despacha, lê a volta,           │  visível, digitado no PTY.      │
│   aplica o gate.                  │  A resposta sai ao vivo.        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Três requisitos, e é contra eles que as rotas abaixo são medidas:

| # | Requisito | Por que importa |
| --- | --- | --- |
| **R-1** | O Lord **abre** uma aba nova, sem o humano clicar | é o "ver você acionando outra IA" |
| **R-2** | O prompt despachado é **visível entrando** na aba | é o "ver o que você pediu" |
| **R-3** | A resposta do executor sai **ao vivo** na mesma aba | é o "tudo dentro dessa ferramenta" |

---

## 3. Mapa dos pontos de acoplamento externo

A auditoria do P5 listou quatro pontos. Reverifiquei os quatro no código do fork, e o
resultado muda a conclusão prática de um deles. Tudo abaixo é **fato lido no código**,
com `arquivo:linha`.

### 3.1 `POST /spawn` — o contrato v1

> Reescrito após o commit `c162d28` (D1). A descrição anterior — campos `agent`/`mode`,
> evento `agent-spawn`, resposta `{"accepted":true,…,"status":"queued"}` e alias `/codex` —
> descrevia o chassi **antes** de D1 e não existe mais no código. Tudo abaixo foi relido
> no código atual.

**Existe, sobe sempre, e é autenticado.**

| O quê | Onde | Detalhe |
| --- | --- | --- |
| Servidor sobe no boot do app | `src-tauri/src/lib.rs:224` | `agent_events::start_listener(...)`, incondicional, dentro do `setup` |
| Host e faixa de portas | `src-tauri/src/agent_events.rs:18-20` | `127.0.0.1`, varre `9123..=9143` |
| Escolha da porta | `src-tauri/src/agent_events.rs:325-334` | primeira que der `bind`; a porta efetiva vai para um `AtomicU16` |
| Token | `src-tauri/src/agent_events.rs:72-74` | `nanoid!(32)`, gerado **em memória**, por execução |
| Autenticação | `src-tauri/src/agent_events.rs:76-82`, `:356-359` | header **`X-Alethe-Token`**; sem ele ou errado → **401**, corpo vazio, antes de qualquer roteamento |
| Limite de corpo | `src-tauri/src/agent_events.rs:21` | 1 MB; falha de leitura → **400** com corpo vazio (`:362-365`) |
| Discovery do contrato | `src-tauri/src/agent_events.rs:25`, `:93-106` | escreve `lord-agent-listener.json` no diretório do perfil ativo, com `endpoint`, `token` e `spawn_protocol_version: 1` |
| Rota `/spawn` | `src-tauri/src/agent_events.rs:370-421` | só `POST`; outro método → rejeição `method_not_allowed` |
| Validação do corpo | `src-tauri/src/agent_events.rs:208-292` | `parse_spawn_request` |
| Providers aceitos | `src-tauri/src/agent_events.rs:250-259` | `shell` \| `claude` \| `codex` \| `cursor` \| `opencode` — qualquer outro → `invalid_provider` |
| Evento emitido | `src-tauri/src/agent_events.rs:404` | **`lord-agent-spawn-v1`**, payload em camelCase (`SpawnEventV1`, `:46-60`) |
| Estado e idempotência | `src-tauri/src/spawn_state.rs:61-183` | `SpawnRegistry`, registrado em `src-tauri/src/lib.rs:151` |
| Status HTTP | `src-tauri/src/agent_events.rs:295-304` | `spawn_http_status`, tabela abaixo |
| Rotas removidas | `src-tauri/src/agent_events.rs:424-427` | `POST /codex` e qualquer `/spawn/...` → **404** |
| Outras rotas | `:433-442` `/opencode-status` → evento `opencode-bridge-status`; `:444-472` qualquer outro caminho → evento `agent-hook` | |

**Corpo aceito.** A struct usa `#[serde(deny_unknown_fields)]`
(`src-tauri/src/agent_events.rs:30-43`): campo desconhecido derruba a requisição inteira
com `invalid_request`. Não há tradução do payload antigo.

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `version` | número | sim | tem de ser `1`; qualquer outro → `unsupported_version` |
| `request_id` | string | sim | não pode ser vazio/só espaço; é a chave de idempotência |
| `provider` | string | sim | um da lista de providers aceitos |
| `task` | string | sim | não pode ser vazia/só espaço |
| `origin` | string | sim | não pode ser vazia/só espaço; identifica quem pediu (ex.: `lord`) |
| `cwd` | string | condicional | ao menos um entre `cwd` e `project_id` precisa vir preenchido |
| `project_id` | string | condicional | idem |
| `name` | string | não | nome da aba; sem ele a UI usa o rótulo do provider |
| `parent_terminal_id` | string | não | vínculo pai/filho para a UI focar sem inferir |

**`reason` possíveis.** Rejeição sempre é JSON e sempre carrega `job_id` rastreável
(`src-tauri/src/spawn_state.rs:30-47`).

| `reason` | Origem | Quando |
| --- | --- | --- |
| `invalid_json` | `agent_events.rs:211` | corpo não é JSON |
| `invalid_request` | `:226-231` | JSON válido que não casa com a struct v1 (campo faltando, tipo errado, campo desconhecido) |
| `unsupported_version` | `:235-240` | `version != 1` |
| `invalid_request_id` | `:242-247` | `request_id` vazio |
| `invalid_provider` | `:250-259` | provider fora da lista |
| `empty_task` | `:260-266` | `task` vazia |
| `invalid_origin` | `:267-273` | `origin` vazia |
| `missing_target` | `:284-290` | nem `cwd` nem `project_id` |
| `provider_nao_permitido` | ADR-0013 D3 camada 2, `agent_events.rs::provider_allowed` | `provider` fora do `runtimesPermitidos` (D2) do terminal em `parent_terminal_id` — **403**, não 400 |
| `method_not_allowed` | `:371-375` | `/spawn` chamado sem `POST` |
| `emit_failed` | `:404-412` | o `emit` do evento Tauri falhou |
| `no_consumer` | `spawn_state.rs:177-180` | ninguém reivindicou o pedido dentro do prazo de 2s (`agent_events.rs:23`) |
| `no_matching_project` | reportado pelo frontend, `src/hooks/resolveSpawnTarget.ts:117` | nenhum projeto casa com `project_id`/`cwd` |
| `terminal_creation_failed` | reportado pelo frontend, `src/hooks/useAgentSpawnListener.ts:109-114` | `createAgentTerminal` lançou erro |
| `store_not_hydrated`, `invalid_job_id`, `missing_cwd` | `src/hooks/resolveSpawnTarget.ts:70-99` | validações que só o frontend consegue fazer |

**Mapa de status HTTP** (`spawn_http_status`, `src-tauri/src/agent_events.rs:295-304`), mais
os dois casos que nem chegam à função:

| Código | Quando |
| --- | --- |
| **200** | `status` final `terminal_created` ou `pty_started` |
| **202** | `status` `received` — pedido reivindicado por um consumidor, ainda sem aba confirmada |
| **400** | qualquer `rejected` de validação (todos os `reason` acima que não estejam nas linhas seguintes) |
| **401** | token ausente ou errado — antes do roteamento, corpo vazio |
| **403** | `rejected` com `provider_nao_permitido` (ADR-0013 D3 camada 2) |
| **404** | `POST /codex` e qualquer `/spawn/...` |
| **422** | `rejected` com `no_matching_project` |
| **500** | `rejected` com `terminal_creation_failed` |
| **503** | `rejected` com `no_consumer` |

**Idempotência por `request_id`.** `SpawnRegistry::begin`
(`src-tauri/src/spawn_state.rs:67-90`) devolve `(created, response)`: a primeira chamada
cria o registro, gera o `job_id` e libera a emissão do evento; qualquer repetição com o
mesmo `request_id` devolve `created = false` e **o mesmo registro**, sem emitir evento novo.
Consequência: repetir o `POST /spawn` devolve o mesmo `job_id` e, se a aba já existe, o
mesmo `terminal_id` — não nasce segunda aba. A reivindicação é atômica
(`claim`, `:93-106`, exposta como comando Tauri `agent_spawn_claim`,
`agent_events.rs:186-192`): só um consumidor pega cada pedido. As transições posteriores
entram por `agent_spawn_report` (`:195-206` → `report`, `spawn_state.rs:109-159`) e não
regridem — `rejected` e `pty_started` são terminais, e `pty_started` exige o mesmo
`terminal_id` já confirmado.

**O evento tem consumidor.** Diferente do build 1.5.0 auditado, `lord-agent-spawn-v1` é
escutado por `useAgentSpawnListener` (`src/hooks/useAgentSpawnListener.ts:134-179`),
montado incondicionalmente em `src/App.tsx:207`. O fluxo: resolve o alvo
(`resolveSpawnTarget`, puro), reivindica, cria a aba com o prompt como `initialInput`
(`buildSpawnTerminalArgs`, `:42-57`) e reporta de volta ao registry. **Os dois Sandbox/Canvas
antigos não participam mais deste caminho** — o evento v1 é exclusivo justamente para não
acordá-los.

**Visibilidade honesta do escopo (`scopeNote`).** `SpawnEventV1` carrega `scope_note:
Option<String>` (serializado `scopeNote`, ver `agent_events.rs::ScopeVisibility`). Ausência
de `parent_terminal_id` (ordem externa sem aba pai) **não bloqueia** o `/spawn` — é decisão
correta, contida por token + casamento de `cwd` + portão de confirmação humana — mas o campo
torna essa ausência de verificação visível em vez de deixar a tela parecer que conferiu algo
que não conferiu. Valores: `null` (escopo verificado contra o `runtimesPermitidos` real do
terminal de origem), `"sem_terminal_origem"` (sem `parent_terminal_id`) ou
`"terminal_origem_desconhecido"` (`parent_terminal_id` presente, mas terminal desconhecido ou
aba anterior à D2 sem o campo). O frontend traduz o código por i18n e mostra no painel
"Agentes despachados" (`OrchestrationPanel`, `SCOPE_NOTE_KEYS`) — nunca cru na tela.

> **Atenção a quem adicionar provider:** há **duas** allowlists independentes —
> `agent_events.rs:250-259` (Rust) e `SPAWN_PROVIDERS` em
> `src/hooks/resolveSpawnTarget.ts:7-13` (TypeScript). Mudar só uma faz o `/spawn`
> responder e o frontend rejeitar com `invalid_provider`.

**Obtenção do token continua interna ao app.** Ele vive só em memória e sai por dois
caminhos: o comando Tauri `agent_hooks_token` (`src-tauri/src/agent_events.rs:133-136`,
registrado em `src-tauri/src/lib.rs:245`), chamável só pelo frontend; e arquivos escritos
em disco — `lord-agent-listener.json` no diretório do perfil ativo (`:93-106`, escrito no
boot do listener) e `%TEMP%\alethe-agent-hooks.json` via `agent_hooks_settings_path`
(`:142-182`). O discovery do perfil é o caminho pretendido para um cliente externo, e é
escrito sem depender de Canvas ou Sandbox.

### 3.2 `write_pty` / `initialInput` — escrever prompt visível

Este ponto é **sólido e em produção**. É o que atende R-2 e R-3, e já existe pronto.

| O quê | Onde |
| --- | --- |
| `initialInput` é campo do `SubTab` (persistido em `projects.json`) | `src/lib/types.ts:107` |
| Entra na criação da aba | `src/lib/terminalFactory.ts:65` (assinatura), `:92` (aplicação) |
| A digitação visível | `src/components/XTermView/useXtermSession.ts:1366-1393` |
| Escrita crua no PTY | comando Tauri `write_pty` (`src/lib/tauri/pty.ts`) |

O trecho `useXtermSession.ts:1366-1393` é o coração do R-2: depois do spawn, ele **espera o
agente ficar quieto** (`quietFor >= 700ms`, com teto de 4s e prazo de 10s), então escreve o
prompt via `writePtyChunked` e manda `\r`. Não é injeção silenciosa: o texto entra pelo PTY
e aparece no terminal como se tivesse sido digitado. É literalmente "ver o que você pediu".

**Precedente já existente na UI:** o campo de prompt rápido da Home faz exatamente o fluxo
que o Lord precisa — cria um terminal de agente novo com o prompt dentro
(`src/components/HomeView/index.tsx:191-205`), chamando
`createAgentTerminal(projectId, { name, cwd, firstTab: { type, cwd, extraArgs, initialInput } })`
(store em `src/stores/projectsStore.terminalSlices.ts:103`, tipo em
`src/stores/projectsStore.ts:206`). O mesmo caminho está em
`src/components/modals/NewTerminalModal.tsx:113`.

> **Análise:** R-1, R-2 e R-3 já estão todos implementados no chassi. O que falta não é
> capacidade, é **gatilho externo**. A UI sabe fazer; só não aceita ordem de fora.

### 3.3 Controle remoto (`remote.rs`) — o ponto que a auditoria não destacou

A auditoria listou `remote.rs` como "Remote control local / avaliar depois". Ele é mais
relevante do que parecia: é **o único servidor HTTP do chassi que fala com o workspace
normal**, e não com a POC.

| Rota | Onde | O que faz |
| --- | --- | --- |
| autenticação | `src-tauri/src/remote.rs:407-413` | token por **query string** `?token=…`; `/api/*` sem token → 401 |
| `GET /api/info` | `:414-416` | estado do pareamento |
| `GET /api/state` | `:417-420` | **lista projetos, terminais e abas com seus `ptyId`** (lê `projects.json`, `:451-473`) |
| `GET /api/scrollback?id=` | `:421-425` | **lê a saída** de um PTY (até 512 KB) |
| `POST /api/message` | `:426-434` | **escreve texto + `\r`** num PTY existente (`write_remote`, `:491-500`); limite 16 KB (`:25`) |

Isso entrega **R-2 e R-3 sem tocar em uma linha de código**: o Lord consegue escrever um
prompt visível numa aba e ler a resposta ao vivo. O que **não** entrega é R-1 — não existe
rota para criar aba ou terminal. `/api/state` só enumera o que já existe.

Ressalvas de fato: o hub nasce **desligado** (`running: AtomicBool::new(false)`,
`src-tauri/src/remote.rs:82`), só liga por comando da UI
(`remote_control_set_enabled`, `:248`), e o host é o **IP de LAN** da máquina
(`host: local_ip()`, `:81`, com `local_ip()` em `:534`) — foi desenhado para celular na
mesma rede, não para loopback. O token também é `nanoid!(32)` em memória (`:80`), obtido
pela UI (é o QR code de pareamento, `pairing_url` em `:103-105`).

### 3.4 Wrapper por `cliPaths`

`cliPaths.<agente>` aponta o chassi para um binário alternativo
(`setCliPath` em `src/stores/projectsStore.ts:322`; resolução em
`src-tauri/src/cli_resolver.rs`). O Lord pode instalar um *shim* que registra o que passou
e faz `exec` do CLI real. **Zero patch no chassi.** Serve para observar e para injetar
contexto — mas é um ponto *dentro* do processo do agente, não um gatilho de UI: não abre
aba nenhuma. Complementar, não substituto.

### 3.5 Plugins `agentType` (RFC-012)

`src-tauri/src/plugins.rs` guarda manifestos com `kind: agentType | skill |
validationPipeline`. A auditoria registrou como **não confirmado** se um plugin
`agentType` aparece sozinho no seletor de novo terminal sem código de frontend adicional.
Não reverifiquei — segue não confirmado, e não é caminho para R-1 de qualquer forma:
plugin adiciona um *tipo* de agente, não a capacidade de abrir aba por ordem externa.

---

## 4. As duas rotas

### Rota A — zero alteração de código

Usar só o que já está compilado no binário 1.5.0.

**O que entrega**

| Requisito | Entrega? | Por quê |
| --- | --- | --- |
| R-1 — Lord abre a aba | **Não** | `/spawn` emite evento sem consumidor vivo (§3.1); `remote.rs` não tem rota de criação (§3.3) |
| R-2 — prompt visível entrando | **Sim, com ressalva** | `POST /api/message` do controle remoto (`remote.rs:426`), numa aba que **o humano abriu antes** |
| R-3 — resposta ao vivo | **Sim** | a aba é uma aba normal do workspace; e o Lord ainda pode ler por `GET /api/scrollback` |

**O que custa**

- O humano abre uma aba por fatia, à mão, antes de cada despacho. O Lord não "aciona"
  ninguém — ele fala numa sala que já estava montada.
- Ligar o controle remoto no menu a cada sessão, e passar o token de pareamento para o
  Lord (hoje é UI/QR code).
- O servidor escuta no IP de LAN, não em loopback. Para um cérebro na mesma máquina isso é
  superfície de rede desnecessária.
- Nenhum vínculo entre aba e fatia: a aba não sabe que é fatia 2 de um despacho do Lord.
- `/spawn`, que é o ponto de acoplamento mais citado no ADR-0003, fica **inútil na prática**
  enquanto o Canvas estiver órfão.

**Divergência do upstream:** zero. É o único mérito real, e é grande — sincronizar com
`upstream` vira `git merge` sem conflito, sempre.

### Rota B — alteração no chassi

Dividida em dois estágios, porque o primeiro já resolve o objetivo e o segundo é acabamento.

#### B1 — despacho ligado ao workspace (o mínimo que satisfaz R-1)

Duas mudanças, ambas pequenas, ambas reaproveitando código que já existe:

1. **Um ouvinte de `agent-spawn` no workspace.** Um `useEffect` (em `src/App.tsx` ou num
   hook próprio em `src/hooks/`) que escuta `agent-spawn` e chama
   `useProjectsStore.getState().createAgentTerminal(projectId, { name, cwd, firstTab: {
   type: payload.agent, cwd: payload.cwd, initialInput: payload.task } })` — exatamente a
   chamada que `src/components/HomeView/index.tsx:191-205` já faz. R-2 e R-3 vêm de graça:
   `useXtermSession.ts:1366-1393` digita o prompt visível e o xterm mostra a saída.
2. **Descoberta de token e porta.** Escrever, no boot do `start_listener`
   (`src-tauri/src/agent_events.rs:144`), um arquivo com `{"endpoint":…,"token":…}` em
   caminho previsível dentro do diretório do perfil. Hoje isso só acontece por efeito
   colateral de uma view morta (§3.1). Sem esse passo, nenhum processo externo consegue
   falar com `/spawn`.

Custo estimado: um arquivo novo de ~40 linhas em `src/hooks/`, ~3 linhas em `src/App.tsx`,
~15 linhas em `agent_events.rs`. Nada de UI nova, nada de estado novo.

#### B2 — a aba condutora explícita (acabamento visual)

O que o enunciado do trabalho pede além de B1: aba marcada como Lord, rótulo da fatia na
aba, faixa de estado (despachado / trabalhando / voltou / reprovado no gate).

Isso é maior: exige campos novos no `SubTab` (`src/lib/types.ts:107` e vizinhança), que são
**persistidos em `projects.json`** — ou seja, mexe no formato de dados que o upstream
também evolui. É o tipo de mudança que produz conflito de merge de verdade. E exige CSS e
componentes na barra de abas.

**O que a Rota B entrega:** os três requisitos, com B1; a leitura visual completa, com B2.

**O que custa:** manutenção de divergência. E, mais sério, **disciplina de fronteira**: o
ouvinte de B1 é o lugar exato onde a tentação de colocar julgamento aparece ("já que estou
aqui, deixa eu decidir qual agente pega a fatia"). Essa decisão é do Repo B. O ouvinte só
obedece ao payload.

**Divergência do upstream:**

| | B1 | B2 |
| --- | --- | --- |
| Arquivos tocados | 3 (`App.tsx`, 1 hook novo, `agent_events.rs`) | ~8+, incluindo tipos persistidos e CSS |
| Risco de conflito no merge | baixo — arquivos estáveis, adições isoladas | alto — `types.ts`, `projects.json`, barra de abas |
| Candidata a PR upstream? | **Sim** — ver abaixo | Não |

Sobre B1 como PR upstream: o argumento é forte e vale registrar. `/spawn` é um endpoint que
o próprio upstream escreveu, documentou em comentário (`agent_events.rs:162-166`),
anunciou no `CHANGELOG.md:155` e deixou sem consumidor no release. Ligá-lo ao workspace
não adiciona nada do Lord — é **consertar uma promessa quebrada do chassi**. Não tem
conteúdo de julgamento, não tem marca, não tem diferencial comercial. Pelo ADR-0003, regra
1, é exatamente o tipo de melhoria genérica que deve voltar para o upstream.

---

## 5. Recomendação

**Rota B, estágio B1. E propor B1 como PR ao upstream.**

Justificativa, em ordem de peso:

1. **A Rota A não atende o pedido.** Não é uma questão de entregar menos: R-1 — "ver você
   acionando outra IA" — é o núcleo do que o Guilherme descreveu, e nenhuma combinação da
   API existente abre uma aba. O que a Rota A entrega é o Lord falando numa aba que o
   humano montou; a demonstração perde justamente a parte que ele quis ver.
2. **B1 é menor do que parece porque o chassi já faz tudo.** Abrir aba com prompt digitado
   visivelmente e saída ao vivo é o fluxo do prompt rápido da Home, em produção. B1 não
   constrói capacidade — liga um cabo entre um endpoint órfão e uma função existente.
3. **O custo de divergência de B1 é quase o da Rota A.** Três arquivos, adições isoladas,
   sem tocar em tipo persistido. Se virar PR upstream e for aceito, a divergência vai a
   zero e o Lord passa a depender de API do produto, não de patch local.
4. **B1 não fere o ADR-0003.** Nada do cérebro entra: o ouvinte recebe `agent` e `task`
   prontos e obedece. Quem decidiu o corte da fatia e escolheu o executor foi o processo
   Lord, do outro lado do HTTP. A fronteira continua sendo processo + payload JSON
   versionado — que é, inclusive, o "protocolo estreito, público e versionado" que o
   ADR-0003 exige nas pendências bloqueantes.

**B2 fica para depois**, e só se o Guilherme achar que a leitura visual de B1 não basta. É
onde mora o conflito de merge, e é acabamento sobre um fluxo que já vai estar visível.

**O que fazer com a Rota A mesmo assim:** ela não morre. `GET /api/scrollback` e
`POST /api/message` do controle remoto continuam sendo o caminho para o Lord **falar de
novo** numa aba já aberta — a segunda rodada de uma conversa, o pedido de correção depois
do gate reprovar. B1 abre a aba; a Rota A conversa com ela. São complementares.

---

## 6. Evidência levantada em máquina (2026-08-13)

Testado contra o Alethe **instalado e rodando** (`C:\Users\guilherme.souza\AppData\Local\Alethe\alethe.exe`,
`FileVersion 1.5.0`, PID 43308, iniciado 09:05:23) — mesma versão do commit base do fork.

| Verificação | Resultado | Confirma |
| --- | --- | --- |
| Porta em escuta na faixa 9123–9143 | `127.0.0.1:9123`, dona = processo `alethe` | `agent_events.rs:15-17`, `:123-134`, `lib.rs:220` |
| `POST /spawn` sem header de token | **HTTP 401** | `agent_events.rs:150-153` |
| `POST /spawn` com `X-Alethe-Token: token-invalido` | **HTTP 401** | `agent_events.rs:26-32` |
| `%TEMP%\alethe-agent-hooks.json` | **não existe** | o único escritor é view inalcançável (§3.1) |

**O que isso prova:** o endpoint está vivo, sobe sozinho e a autenticação funciona
exatamente como lida no código.

**O que isso não prova, e não dá para provar:** o laço completo. O token só sai para o
disco por uma view sem porta de entrada. Sem token não há `200`, e mesmo com token o
evento não teria consumidor. **A Rota A não foi provada porque não é provável no build
1.5.0** — e essa é a descoberta, não uma falha do teste. Roteiro de reprodução e o que
seria preciso para destravá-la: `lord/SPIKE-ROTA-A.md`.

---

## 7. Restrições que valem para qualquer trabalho neste repositório

- **AGPL-3.0-or-later.** Código escrito aqui nasce AGPL. Não há como recolher depois.
- **Nada do cérebro entra aqui** (ADR-0003). Julgamento, gates, régua, conteúdo de
  elicitação: Repo B.
- **`LICENSE`, `NOTICE` e `TRADEMARK.md` não se alteram.** O fork herda o código sob AGPL,
  **não** o direito de usar o nome e a identidade do projeto original.
- Disciplina de divergência e sincronização com `upstream`: `POLITICA-DE-FORK.md`.

## 8. Não confirmado

- Se um plugin `kind: agentType` (RFC-012) aparece sozinho no seletor de novo terminal sem
  código de frontend adicional (§3.5) — herdado da auditoria do P5, não reverificado aqui.
- Se o Canvas ficou órfão por decisão ou por regressão. O `CHANGELOG.md:155` anuncia o
  `/spawn` como recurso do Sandbox; a remoção da entrada do Canvas não foi rastreada
  commit a commit.
- Se o upstream aceitaria B1 como PR. É leitura do `CONTRIBUTING.md` e do histórico, não
  compromisso de ninguém.
