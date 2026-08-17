import type { AgentType } from './types'

/**
 * Lord: ponte de despacho por instrução (opt-in do chip "Alcance de despacho").
 *
 * O chip do modal de novo terminal grava `runtimesPermitidos`, que é
 * AUTORIZAÇÃO: serve para o backend RECUSAR um `POST /spawn` fora do conjunto
 * (ADR-0013 D3 camada 2). Autorização não ensina ninguém a despachar — medido na
 * prática: com Claude+Codex+Cursor marcados, o Claude criou subagentes internos
 * dele mesmo e gastou uma cota só.
 *
 * Decisão do dono do produto: marcar SÓ o próprio tipo continua sendo o
 * comportamento de hoje (nada é injetado). Marcar um SEGUNDO runtime é o pedido
 * explícito de despacho — aí o terminal nasce com a instrução de como acionar os
 * outros.
 *
 * Este módulo é só texto e uma decisão pura. Não lê env var, não faz HTTP, não
 * escreve no PTY: quem executa o despacho é o processo do agente, do outro lado
 * da fronteira (ADR-0003).
 */

/**
 * Flag do Claude Code que anexa texto ao system prompt da sessão. É flag de UM
 * fornecedor — não existe equivalente verificado em Codex ou Cursor, por isso a
 * injeção é restrita a `claude` (ver `buildSpawnBridgeArgs`).
 */
export const SPAWN_BRIDGE_FLAG = '--append-system-prompt'

/**
 * Texto da ponte v1.
 *
 * Escrito contra o contrato lido no código (`src-tauri/src/agent_events.rs`,
 * `SpawnRequestV1`) e contra as env vars que o chassi injeta no PTY
 * (`src-tauri/src/pty.rs`). NÃO reaproveita o `SPAWN_BRIDGE_PROMPT` do canvas
 * POC (`src/stores/agentSandboxStore.ts`), que está quebrado: manda o campo de
 * provider com o nome antigo, manda um campo de pai que não existe, não manda
 * `version` nem `request_id` e aponta para env vars que num terminal normal do
 * Lord estão vazias.
 *
 * Nada aqui é suposição sobre comportamento de fornecedor: só o que está no
 * contrato do chassi.
 */
export const SPAWN_BRIDGE_PROMPT_V1 = `PONTE DE DESPACHO DO LORD (contrato /spawn v1)

Você roda dentro de uma aba do Lord, o chassi que hospeda este terminal. Além de trabalhar
você mesmo, você pode pedir uma fatia do trabalho a OUTRA ferramenta de IA — Claude Code,
Codex, Cursor, OpenCode — abrindo uma aba nova dentro do próprio Lord. Isto é despacho
externo por HTTP, não subagente interno seu: subagente interno consome a SUA cota; despacho
externo usa a cota da outra ferramenta. Quando o pedido do humano envolve mais de uma
ferramenta, é este canal que ele quer, não um enxame de subagentes seus.

1. DESCOBRIR ENDEREÇO E TOKEN — A CADA DESPACHO

A variável de ambiente LORD_SPAWN_DISCOVERY contém o caminho absoluto de um arquivo JSON com
três campos: "endpoint", "spawn_protocol_version" e "token".

LEIA esse arquivo no momento de cada despacho. O token é gerado em memória e MUDA a cada
reinício do app: token guardado de uma rodada anterior devolve 401 com corpo vazio. Nunca
guarde o token em arquivo, resumo, log ou mensagem — releia sempre.

Se LORD_SPAWN_DISCOVERY não estiver definida, ou o arquivo não existir, você NÃO tem canal de
despacho. Diga isso e faça o trabalho sozinho. Não varra portas, não adivinhe endereço.

2. A CHAMADA

POST <endpoint>/spawn
Cabeçalhos: X-Alethe-Token: <token lido agora>  e  Content-Type: application/json

Corpo — versão 1. Estes são os ÚNICOS campos aceitos:

  version             número   sempre 1
  request_id          texto    novo e único a cada despacho de verdade
  provider            texto    shell | claude | codex | cursor | opencode
  task                texto    o prompt integral da fatia; não pode ser vazio
  cwd                 texto    caminho absoluto do projeto — ou use project_id
  project_id          texto    alternativa ao cwd; ao menos um dos dois vem preenchido
  origin              texto    quem está pedindo; não pode ser vazio
  name                texto    opcional; nome da aba
  parent_terminal_id  texto    o valor de LORD_TERMINAL_ID, copiado sem alterar
  transcript_capture  objeto   opcional; { demandaDir, agente, assunto }

É PROIBIDO enviar qualquer campo fora dessa lista. A struct do servidor usa
deny_unknown_fields: UM campo a mais — mesmo bem-intencionado, mesmo vazio, mesmo só de
metadado — derruba a requisição inteira com 400 invalid_request. Não invente campo de modelo,
de prioridade, de prazo, de tags ou de contexto.

request_id é CHAVE DE IDEMPOTÊNCIA, não identificador de log. Repetir o mesmo valor devolve a
resposta anterior — mesmo job_id, mesmo terminal_id — e NÃO abre segunda aba nem reexecuta
nada. É o que torna seguro repetir a chamada depois de um timeout de rede. Gere um valor novo
só quando a intenção for um despacho novo de verdade.

3. LER A RESPOSTA

  200  terminal_created         a aba existe; vem o terminal_id
  202  received                 aceito; aba ainda não confirmada
  400  invalid_request e afins   o pedido está errado; a resposta diz qual campo
  401  —                        token ausente ou errado; releia o arquivo de discovery
  403  provider_nao_permitido   fora do escopo desta aba; ver item 4
  422  no_matching_project      nenhum projeto do app casa com o cwd/project_id enviado
  503  no_consumer              servidor no ar, mas a interface não está ouvindo

Toda resposta traz um job_id rastreável, inclusive as rejeições.

4. PARA QUEM VOCÊ PODE DESPACHAR

A variável LORD_RUNTIMES_PERMITIDOS traz, separados por vírgula, os runtimes que ESTA aba pode
acionar. Só despache para provider presente nessa lista.

Se a variável não estiver definida, ou vier vazia, o escopo é DESCONHECIDO. Nunca leia ausência
como "todos". Nesse caso não despache: relate que não sabe o escopo.

403 provider_nao_permitido é FIM DE ASSUNTO. Você não amplia o próprio conjunto, não repete a
chamada com outro request_id, não troca o provider para contornar, não pede ao humano para
liberar e não volta ao tema depois com outro argumento. Uma recusa não vira barganha: registre
a recusa e siga — faça a fatia você mesmo ou diga que não dá.

5. PROVIDER PAGO PARA NO PORTÃO HUMANO

Para claude, codex, cursor e opencode a aba nasce mas o prompt NÃO é enviado ao CLI: ele fica
visível numa barra e nada é cobrado até o humano clicar. Portanto 200 terminal_created quer
dizer "a aba existe", nunca "o trabalho começou". Não fique em laço de espera assumindo
execução, e não redespache achando que falhou. Com provider shell o envio é imediato, porque
não há custo — é o jeito certo de testar a porta sem gastar.

6. COMO SABER QUE A FATIA TERMINOU

O ENTREGÁVEL EM DISCO É A VERDADE. A morte do processo é só o gatilho para ir conferir; nunca
é a prova.

- Antes de despachar, combine dentro da própria task QUAL artefato prova a fatia: caminho de
  arquivo e o que precisa estar dentro dele.
- Quando o processo do filho sair, VÁ VERIFICAR esse artefato.
- Saiu com código 0 e o artefato não existe, está vazio ou não contém o combinado: isso é
  REPROVADO, não concluído.
- É PROIBIDO declarar que a fatia terminou com base apenas em o processo ter saído, no estado
  da aba, no código de saída ou no que o filho disse sobre si mesmo. Estado de processo não é
  estado de qualidade (ADR-0008): autodeclaração de executor é hipótese a verificar, não
  evidência.

7. CONTROLE DE GASTO

- UMA fatia por despacho. Não empacote três tarefas numa task para "economizar chamada": você
  perde o corte, perde a verificação e paga o mesmo.
- NUNCA cole o transcript do filho no seu contexto. É o jeito mais rápido de queimar cota:
  você paga de novo, em tokens seus, tudo o que ele já produziu.
- O que você lê de volta é PONTEIRO CURTO: caminho do artefato, caminho do transcript,
  terminal_id, job_id. Só abra o arquivo se precisar de um trecho específico, e leia só o
  trecho.`

/**
 * Decide os argumentos extras da ponte para um terminal novo.
 *
 * Regra (opt-in): injeta somente quando o usuário marcou MAIS DE UM runtime no
 * chip de alcance E o tipo do terminal é `claude`. Um runtime marcado = escopo
 * do próprio tipo = comportamento de antes, nada muda.
 *
 * LACUNA DECLARADA: para `codex`, `cursor` e qualquer outro tipo com dois ou
 * mais runtimes marcados, esta função devolve lista vazia — de propósito.
 * `--append-system-prompt` é flag do Claude Code; não verifiquei flag
 * equivalente de anexo ao system prompt nos CLIs do Codex ou do Cursor, e flag
 * de fornecedor não verificada não entra aqui. Enquanto isso, nesses tipos o
 * chip segue sendo só autorização.
 *
 * Pura: não lê store, não lê env, não faz IO.
 */
export function buildSpawnBridgeArgs(
  type: AgentType,
  runtimesPermitidos: readonly AgentType[] | null | undefined,
): string[] {
  const runtimes = runtimesPermitidos ?? []
  if (runtimes.length <= 1) return []
  if (type !== 'claude') return []
  return [SPAWN_BRIDGE_FLAG, SPAWN_BRIDGE_PROMPT_V1]
}
