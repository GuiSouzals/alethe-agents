import { useEffect, useRef } from 'react'

import {
  ghosttySetFocus,
  ghosttySetHidden,
  ghosttySpawn,
  ghosttySurfaceExited,
  ghosttySyncFrame,
  ghosttyWriteText,
  type WebRect,
} from '../../lib/tauri'
import { webRectsEqual } from '../../lib/webRect'
import type { InitialInputGate } from '../XTermView/useXtermSession'

/** Espelha `INITIAL_INPUT_GATE_POLL_MS` de `useXtermSession.ts` — mesma
 *  cadência de checagem do portão, backends diferentes. */
const INITIAL_INPUT_GATE_POLL_MS = 250

/** Intervalo do polling de saída do processo (ver useEffect abaixo). Baixo o
 * bastante pra fechar o pane sem demora perceptível, alto o bastante pra não
 * disparar uma chamada IPC por pane a cada fração de segundo. */
const EXIT_POLL_MS = 2000

export type GhosttySurfaceProps = {
  /** ID estável da surface — usamos o id da sub-tab (mesmo papel do ptyId). */
  surfaceId: string
  /** Diretório inicial. undefined = padrão do shell. */
  cwd?: string
  /** Linha de comando a executar (agente). undefined = shell de login. */
  command?: string
  /**
   * True quando esta é a sub-tab ativa do pane. Quando false, a surface
   * continua VIVA (shell/agente rodando) mas escondida — é assim que trocar de
   * tab preserva o estado (espelha o PTY persistente do xterm). Só a surface
   * ativa é montada+visível; matar de verdade é no unmount (fechar o pane).
   */
  active?: boolean
  onSpawned?: (id: string) => void
  /** Chamado quando o processo do terminal (shell/agente) sai — o pane fecha. */
  onExit?: () => void
  /**
   * Lord: prompt inicial — mesmo campo que `XTermView.initialInput`
   * (`SubTab.initialInput`, `TerminalPane`). Digitado na surface uma única vez
   * após o spawn, atrás do mesmo portão (`initialInputGate`) do backend xterm.
   */
  initialInput?: string
  /**
   * Lord: decisão do portão de confirmação (`lib/spawnConfirmation.ts`) — ver
   * `XTermView`. Diferença deliberada em relação ao xterm: lá, `hold` escreve
   * um banner DENTRO do terminal (`terminal.write`, que é só display local,
   * nunca chega no PTY). Aqui não há equivalente — `ghosttyWriteText` manda
   * teclas de verdade pro shell (`alethe_ghostty_surface_send_text`), então
   * "escrever um aviso" apareceria como entrada real digitada no prompt do
   * usuário. O aviso de "segurando" já existe de forma agnóstica de backend no
   * banner HTML (`TerminalPane.spawnGate`, renderizado por cima da área do
   * terminal nos dois backends) — aqui só a espera silenciosa é necessária.
   */
  initialInputGate?: InitialInputGate
  onInitialInputSent?: () => void
  onInitialInputDiscarded?: () => void
}

/**
 * Renderiza um placeholder no DOM e mantém uma NSView nativa do Ghostty alinhada
 * a ele. A NSView vive FORA da WebView (irmã dela, por cima), então toda a
 * posição/tamanho é empurrada pro backend via `ghostty_sync_frame`.
 *
 * macOS-only: o componente só é montado quando `platform === 'macos'` e a flag
 * `nativeTerminalMacos` está ligada (decisão no TerminalPane). Em outras
 * plataformas os comandos retornariam erro, então nem chegamos aqui.
 *
 * O `command`/`cwd` são lidos na criação da surface (o backend Ghostty spawna o
 * processo no nascimento da surface). Trocar de sub-tab NÃO remonta: todas as
 * surfaces do pane ficam montadas e só a `active` fica visível+focada (as
 * outras seguem vivas mas escondidas). É o que preserva o estado ao voltar —
 * espelha o PTY persistente do xterm. A surface só é morta no unmount real
 * (fechar o pane / fechar a sub-tab).
 */
export function GhosttySurface({
  surfaceId,
  cwd,
  command,
  active = true,
  onSpawned,
  onExit,
  initialInput,
  initialInputGate,
  onInitialInputSent,
  onInitialInputDiscarded,
}: GhosttySurfaceProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const lastRectRef = useRef<WebRect | null>(null)
  const rafRef = useRef<number | null>(null)
  const spawnedRef = useRef(false)

  // cwd/command/initialInput capturados na 1ª montagem (a surface spawna o processo uma vez).
  const spawnArgsRef = useRef({ cwd, command, initialInput })

  // Lord: gate lido dentro do laço de espera (useEffect abaixo mantém o ref
  // atualizado) sem recriar o efeito de ciclo de vida — mesmo padrão de
  // `XTermView`/`useXtermSession.initialInputGateRef`.
  const initialInputGateRef = useRef(initialInputGate)
  useEffect(() => {
    initialInputGateRef.current = initialInputGate
  }, [initialInputGate])

  // onSpawned é recriado a cada render do pai; guardamos num ref para o efeito
  // de ciclo de vida NÃO depender dele — senão a cada re-render do TerminalPane
  // a surface seria morta e recriada (e o terminal piscaria/reiniciaria).
  const onSpawnedRef = useRef(onSpawned)
  const onExitRef = useRef(onExit)
  const onInitialInputSentRef = useRef(onInitialInputSent)
  const onInitialInputDiscardedRef = useRef(onInitialInputDiscarded)
  useEffect(() => {
    onSpawnedRef.current = onSpawned
    onExitRef.current = onExit
    onInitialInputSentRef.current = onInitialInputSent
    onInitialInputDiscardedRef.current = onInitialInputDiscarded
  })

  // Valor de `active` lido dentro dos efeitos (que não dependem dele p/ não
  // recriar observers). O efeito dedicado abaixo dispara a reavaliação.
  const activeRef = useRef(active)
  // Reavaliação de hidden registrada pelo efeito de visibilidade; chamada
  // quando `active` muda para aplicar hidden/foco/re-sync sem recriar observers.
  const reevaluateVisibilityRef = useRef<(() => void) | null>(null)
  // scheduleFrame vive no efeito de ciclo de vida; exposto p/ o efeito de
  // visibilidade forçar um re-sync do frame ao reativar a tab.
  const scheduleFrameRef = useRef<(() => void) | null>(null)
  // Posicionamento SÍNCRONO (sem rAF) — usado quando o rAF pode não disparar
  // (WebView oculta atrás de modal no boot). Garante o 1º sync_frame.
  const pushFrameNowRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const node = placeholderRef.current
    if (!node) return

    let disposed = false

    // Empurra o rect atual do placeholder pro backend, coalescido em rAF pra
    // não disparar um IPC por pixel durante um drag de separador.
    const pushFrame = () => {
      rafRef.current = null
      if (disposed) return
      const r = node.getBoundingClientRect()
      // Placeholder sem tamanho (layout ainda não assentou) → rect degenerado.
      // Não empurramos: o ResizeObserver reagenda quando ganhar tamanho real.
      if (r.width < 1 || r.height < 1) return
      const rect: WebRect = { x: r.left, y: r.top, width: r.width, height: r.height }
      if (webRectsEqual(lastRectRef.current, rect)) return
      lastRectRef.current = rect
      void ghosttySyncFrame(surfaceId, rect, window.devicePixelRatio || 1)
    }

    const scheduleFrame = () => {
      if (rafRef.current !== null) return
      rafRef.current = window.requestAnimationFrame(pushFrame)
    }
    scheduleFrameRef.current = scheduleFrame

    // Posiciona AGORA, sem esperar rAF. Enquanto um modal cobre a tela no boot, a
    // WebView pode não pintar, e um requestAnimationFrame pendente nunca dispara —
    // deixando rafRef travado e a surface no frame de nascimento (janela inteira,
    // cobrindo a UI). O caminho direto garante o 1º posicionamento independente
    // do pintor. Usado pós-spawn e ao reexibir a tab.
    const pushFrameNow = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      pushFrame()
    }
    pushFrameNowRef.current = pushFrameNow

    // Lord: digita o `initialInput` uma única vez, atrás do mesmo portão de
    // confirmação do backend xterm (`useXtermSession.sendInitialInput`).
    //
    // NÃO EXERCITADO EM RUNTIME — sem macOS disponível para testar. Duas
    // diferenças deliberadas em relação ao xterm, ambas por limitação real do
    // backend nativo, não por descuido:
    //   1. sem banner de "segurando" digitado no terminal (ver doc da prop
    //      `initialInputGate` acima) — o aviso fica só no banner HTML do
    //      `TerminalPane`, que já cobre os dois backends;
    //   2. sem espera por "silêncio" do PTY (`quietFor`, useXtermSession) — o
    //      Ghostty nativo não expõe um stream de dados pro frontend
    //      (`listenPtyData` não existe pra surface nativa; só há
    //      `ghostty_debug_send_read`, síncrono e caro, feito para smoke test,
    //      não para produção). Uma espera fixa substitui a detecção de
    //      silêncio — mais simples, mas sem o mesmo cuidado de "esperar o
    //      agente terminar de imprimir o boot antes de digitar por cima".
    const sendInitialInput = async (surfaceIdReady: string, prompt: string) => {
      for (;;) {
        if (disposed) return
        const gate = initialInputGateRef.current ?? 'auto'
        if (gate === 'discard') {
          onInitialInputDiscardedRef.current?.()
          return
        }
        if (gate !== 'hold') break
        await new Promise((resolve) => window.setTimeout(resolve, INITIAL_INPUT_GATE_POLL_MS))
      }
      if (disposed) return
      // Janela fixa pro shell/agente terminar o boot antes de digitarmos por cima
      // — mesmo piso de `earliestSendAt` do xterm (1500ms), sem o teto/deadline
      // dinâmico de lá porque não há sinal de atividade do PTY pra encurtar a
      // espera quando o processo já está pronto antes disso.
      await new Promise((resolve) => window.setTimeout(resolve, 1_500))
      if (disposed) return
      try {
        await ghosttyWriteText(surfaceIdReady, prompt)
        await new Promise((resolve) => window.setTimeout(resolve, 150))
        await ghosttyWriteText(surfaceIdReady, '\r')
        onInitialInputSentRef.current?.()
      } catch (error) {
        console.warn('[ghostty] não foi possível enviar o prompt inicial:', error)
      }
    }

    const start = async () => {
      try {
        const { cwd, command, initialInput } = spawnArgsRef.current
        const res = await ghosttySpawn({ id: surfaceId, cwd, command })
        if (disposed) return
        spawnedRef.current = true
        onSpawnedRef.current?.(res.id)
        // Posiciona já (síncrono) + um reforço no próximo tick, caso o layout do
        // placeholder ainda não tenha assentado no exato instante do spawn.
        pushFrameNow()
        window.setTimeout(() => pushFrameNow(), 50)
        const prompt = initialInput?.trim()
        if (prompt) void sendInitialInput(res.id, prompt)
      } catch (err) {
        console.error('ghostty_spawn falhou', err)
      }
    }
    void start()

    // Reposiciona a surface em qualquer mudança de layout: resize do
    // placeholder (separadores, troca de layout) e resize da janela.
    const ro = new ResizeObserver(scheduleFrame)
    ro.observe(node)
    window.addEventListener('resize', scheduleFrame)
    // Scroll de qualquer ancestral também move o rect na tela.
    window.addEventListener('scroll', scheduleFrame, true)

    return () => {
      disposed = true
      ro.disconnect()
      window.removeEventListener('resize', scheduleFrame)
      window.removeEventListener('scroll', scheduleFrame, true)
      scheduleFrameRef.current = null
      pushFrameNowRef.current = null
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      // NÃO matamos a surface no unmount. O componente desmonta ao trocar de aba
      // /projeto (o pane sai de vista), e matar aqui reiniciaria o shell/agente —
      // exatamente o bug "o terminal reseta ao voltar". A surface segue viva no
      // backend; só é morta por ação explícita de fechar (cleanupPtys →
      // ghosttyKill) ou pela limpeza de órfãs no boot (ghosttyKillAll). Enquanto
      // some da tela, escondemos a NSView para não vazar sobre a aba nova.
      void ghosttySetHidden(surfaceId, true)
    }
  }, [surfaceId])

  // Esconde a NSView nativa quando ela não deveria estar visível. A NSView vive
  // ACIMA do HTML, então nenhum z-index CSS a cobre — precisamos ocultá-la
  // explicitamente em dois casos:
  //   1. o placeholder saiu do viewport (scroll / troca de aba) — IntersectionObserver;
  //   2. há um modal aberto por cima — um overlay HTML NÃO muda a interseção do
  //      placeholder, então a surface "vazaria" por cima do diálogo. Detectamos
  //      qualquer Radix Dialog aberto ([role="dialog"][data-state="open"]), o que
  //      cobre todos os modais do app, inclusive o onboarding ("Criar perfil").
  useEffect(() => {
    const node = placeholderRef.current
    if (!node) return

    let intersecting = true
    let lastHidden: boolean | null = null
    let lastFocused: boolean | null = null

    const anyModalOpen = () => document.querySelector('[role="dialog"][data-state="open"]') !== null

    const applyHidden = () => {
      // Tab inativa também esconde: a surface segue viva, só sai da tela.
      const hidden = !activeRef.current || !intersecting || anyModalOpen()
      // O IPC vai à main thread do macOS; só dispara quando o estado muda.
      if (hidden !== lastHidden) {
        // Ao reaparecer, garante um re-sync do frame (o layout pode ter mudado
        // enquanto a tab estava oculta — ex.: resize da janela). O placeholder
        // fica sempre com tamanho real (position:absolute), então o rect é válido.
        // Síncrono: se um modal estava por cima, o rAF pode não ter disparado.
        if (!hidden) pushFrameNowRef.current?.()
        lastHidden = hidden
        void ghosttySetHidden(surfaceId, hidden)
      }
      // Foco de teclado acompanha o estado visível: só a surface ativa e à
      // vista recebe foco; escondida perde (senão roubaria o teclado da ativa).
      const focused = !hidden
      if (focused !== lastFocused) {
        lastFocused = focused
        void ghosttySetFocus(surfaceId, focused)
      }
    }
    reevaluateVisibilityRef.current = applyHidden

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) intersecting = entry.isIntersecting
        applyHidden()
      },
      { threshold: 0 },
    )
    io.observe(node)

    // Reavalia sempre que modais entram/saem do DOM (abrir/fechar diálogo).
    const mo = new MutationObserver(applyHidden)
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })

    return () => {
      io.disconnect()
      mo.disconnect()
      reevaluateVisibilityRef.current = null
    }
  }, [surfaceId])

  // Troca de sub-tab ativa/inativa: atualiza o ref e reavalia hidden/foco.
  // NÃO recria os observers (deps [surfaceId]) — só empurra o novo estado.
  useEffect(() => {
    activeRef.current = active
    reevaluateVisibilityRef.current?.()
  }, [active])

  // Detecção de saída do processo: o Ghostty (backend EXEC) não emite evento de
  // exit pro app — só mostra "Press any key to close" na própria surface. Fazemos
  // polling leve do estado do processo e, ao sair, disparamos onExit (o pane
  // fecha e o layout reajusta). Espelha o listenPtyExit do xterm.
  useEffect(() => {
    let stopped = false
    const iv = window.setInterval(async () => {
      if (stopped) return
      // Só depois do spawn confirmado: antes disso a surface não está no mapa do
      // backend e o comando reportaria "saiu" (ausente), fechando o pane novo.
      if (!spawnedRef.current) return
      try {
        const exited = await ghosttySurfaceExited(surfaceId)
        if (exited && !stopped) {
          stopped = true
          window.clearInterval(iv)
          onExitRef.current?.()
        }
      } catch {
        /* erro transitório — tenta de novo */
      }
    }, EXIT_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(iv)
    }
  }, [surfaceId])

  // Cada surface do pane é posicionada ABSOLUTA (inset:0) para EMPILHAR todas na
  // mesma área do terminalArea (que é flex) — se fossem filhos flex normais, N
  // tabs dividiriam o espaço em vez de sobrepor. A tab inativa continua ocupando
  // a área (rect real, não 0×0 — o que manteria o sync funcionando), apenas
  // invisível via `visibility:hidden` + a NSView escondida por ghosttySetHidden.
  // Assim o placeholder SEMPRE tem tamanho, e o pushFrame sempre posiciona certo.
  return (
    <div
      ref={placeholderRef}
      style={{
        position: 'absolute',
        inset: 0,
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
      }}
      data-ghostty-surface={surfaceId}
    />
  )
}
