// Listener da POC do canvas de subagents (Fase 1).
//
// O Claude Code dispara hooks `SubagentStart`/`SubagentStop` como POST HTTP
// (hook type "http" no settings do projeto de teste). Este módulo sobe um
// servidor mínimo em 127.0.0.1:9123, lê o JSON de cada POST e re-emite pro
// frontend como evento Tauri `agent-hook`. Fluxo novo e isolado — não toca
// em PTY, projects nem em nenhum fluxo existente.

use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::paths::projects_file_path;
use crate::spawn_state::{SpawnRegistry, SpawnResponseV1, SpawnStatus};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9123;
const MAX_PORT: u16 = 9143;
const BODY_LIMIT: u64 = 1024 * 1024; // 1 MB
// Lord D1: Prazo curto para observar consumidor; trabalho já reivindicado continua como `received`.
const SPAWN_CONSUMER_TIMEOUT: Duration = Duration::from_secs(2);
// Lord B1: Keep the bridge contract discoverable inside the active profile.
const DISCOVERY_FILE_NAME: &str = "lord-agent-listener.json";
static LISTENER_PORT: AtomicU16 = AtomicU16::new(0);
static LISTENER_TOKEN: OnceLock<String> = OnceLock::new();

// Lord D1: `/spawn` aceita somente este contrato v1; não há tradução do payload legado.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnRequestV1 {
    version: u8,
    request_id: String,
    provider: String,
    task: String,
    cwd: Option<String>,
    project_id: Option<String>,
    origin: String,
    name: Option<String>,
    // Lord F3: Vínculo opcional e estável para a UI focar pai/filho sem inferência.
    parent_terminal_id: Option<String>,
}

// Lord D1: O evento interno usa camelCase por ser consumido diretamente pelo TypeScript.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnEventV1 {
    version: u8,
    request_id: String,
    job_id: String,
    provider: String,
    task: String,
    cwd: Option<String>,
    project_id: Option<String>,
    origin: String,
    name: Option<String>,
    // Lord F3: O evento interno usa camelCase pela serialização da struct.
    parent_terminal_id: Option<String>,
    // Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013,
    // item 2). `None` = escopo verificado contra a allowlist real do
    // terminal de origem. `Some(code)` = a checagem NÃO pôde ser aplicada
    // (ver `ScopeVisibility`); o request seguiu contido só por token + cwd +
    // portão de confirmação humana, nunca bloqueado por isto -- só rotulado.
    scope_note: Option<String>,
}

// Lord D1: Confirmações aceitas do consumidor único do workspace.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnReportV1 {
    request_id: String,
    status: SpawnStatus,
    terminal_id: Option<String>,
    reason: Option<String>,
}

// Lord D3/D4 (ADR-0013, etapa 3c): a recusa por conjunto de terminal precisa
// aparecer na aba de origem — a resposta HTTP síncrona vai pro processo que
// chamou /spawn (o harness), não pra UI. Este evento é o único jeito da
// aba de origem descobrir que foi ela quem tentou algo fora do próprio
// conjunto. `job_id` sempre existe mesmo em rejeição (SpawnResponseV1::rejected).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnRejectedEventV1 {
    job_id: String,
    request_id: String,
    provider: String,
    origin: String,
    parent_terminal_id: String,
    reason: String,
}

fn init_token() -> &'static str {
    LISTENER_TOKEN.get_or_init(|| nanoid::nanoid!(32))
}

fn check_token(request: &tiny_http::Request) -> bool {
    let expected = init_token();
    request
        .headers()
        .iter()
        .any(|h| h.field.as_str() == "X-Alethe-Token" && h.value.as_str() == expected)
}

fn listener_addr(port: u16) -> String {
    format!("{HOST}:{port}")
}

fn listener_endpoint(port: u16) -> String {
    format!("http://{HOST}:{port}")
}

// Lord D1: Publica transporte e versão; o listener recebe somente trabalho pronto para executar.
fn write_listener_discovery(app: &AppHandle, port: u16) -> Result<(), String> {
    let profile = crate::profiles::active_profile_state(app)?;
    let profile_dir = crate::profiles::profile_data_dir_for_id(app, &profile.id)?;
    let path = profile_dir.join(DISCOVERY_FILE_NAME);
    let discovery = serde_json::json!({
        "endpoint": listener_endpoint(port),
        "token": init_token(),
        "spawn_protocol_version": 1,
    });
    let body = serde_json::to_string_pretty(&discovery).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| error.to_string())?;
    eprintln!("[agent_events] listener discovery written to {}", path.display());
    Ok(())
}

fn current_listener_port() -> Option<u16> {
    let port = LISTENER_PORT.load(Ordering::SeqCst);
    (port != 0).then_some(port)
}

fn wait_for_listener_port() -> Option<u16> {
    let start = Instant::now();
    loop {
        if let Some(port) = current_listener_port() {
            return Some(port);
        }
        if start.elapsed() >= Duration::from_secs(2) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[tauri::command]
pub fn agent_hooks_endpoint() -> Result<String, String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    Ok(listener_endpoint(port))
}

#[tauri::command]
pub fn agent_hooks_token() -> String {
    init_token().to_string()
}

/// Escreve (idempotente) um settings JSON só com os hooks HTTP de subagent e
/// retorna o path. O frontend injeta via `claude --settings <path>` no
/// terminal do canvas — assim os hooks valem só pra ESSA sessão, sem tocar
/// no `.claude/` da pasta que o usuário escolheu.
#[tauri::command]
pub fn agent_hooks_settings_path() -> Result<String, String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    let endpoint = listener_endpoint(port);
    let path = std::env::temp_dir().join("alethe-agent-hooks.json");
    let token = init_token();
    let hook = serde_json::json!([
        { "hooks": [ {
            "type": "http",
            "url": format!("{endpoint}/hook"),
            "timeout": 5,
            "headers": { "X-Alethe-Token": token }
        } ] }
    ]);
    let settings = serde_json::json!({
        // Fase 4: split-pane de teams não existe no Windows — in-process faz o
        // canvas do Alethe ser a visualização do time.
        "teammateMode": "in-process",
        "hooks": {
            "SubagentStart": hook.clone(),
            "SubagentStop": hook.clone(),
            // Fase 2: tool calls em tempo real. PreToolUse dentro de subagent
            // carrega agent_id (sessão principal não) — o store filtra por isso.
            "PreToolUse": hook.clone(),
            "PostToolUse": hook.clone(),
            // Fase 4: eventos de Agent Teams (in-process roda na sessão do
            // lead, então estes hooks via --settings pegam o time inteiro).
            "TeammateIdle": hook.clone(),
            "TaskCreated": hook.clone(),
            "TaskCompleted": hook
        }
    });
    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    eprintln!(
        "[agent_events] hooks settings escrito em {}",
        path.display()
    );
    Ok(path.to_string_lossy().to_string())
}

// Lord D1: A reivindicação atômica impede dois listeners de criarem a mesma aba.
#[tauri::command]
pub fn agent_spawn_claim(
    state: State<'_, SpawnRegistry>,
    request_id: String,
) -> bool {
    state.claim(&request_id)
}

// Lord D1: Estados posteriores só entram após confirmação explícita do frontend/runtime.
#[tauri::command]
pub fn agent_spawn_report(
    state: State<'_, SpawnRegistry>,
    report: SpawnReportV1,
) -> Result<SpawnResponseV1, String> {
    state.report(
        &report.request_id,
        report.status,
        report.terminal_id,
        report.reason,
    )
}

// Lord D1: Validação rejeita antes do evento, mas preserva correlação quando o JSON a fornece.
fn parse_spawn_request(body: &str) -> Result<SpawnRequestV1, SpawnResponseV1> {
    let raw = match serde_json::from_str::<serde_json::Value>(body) {
        Ok(raw) => raw,
        Err(_) => return Err(SpawnResponseV1::rejected("", "", "invalid_json")),
    };
    let request_id = raw
        .get("request_id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let provider = raw
        .get("provider")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let request = match serde_json::from_value::<SpawnRequestV1>(raw) {
        Ok(request) => request,
        Err(_) => {
            return Err(SpawnResponseV1::rejected(
                request_id,
                provider,
                "invalid_request",
            ))
        }
    };

    if request.version != 1 {
        return Err(SpawnResponseV1::rejected(
            request.request_id,
            request.provider,
            "unsupported_version",
        ));
    }
    if request.request_id.trim().is_empty() {
        return Err(SpawnResponseV1::rejected(
            request.request_id,
            request.provider,
            "invalid_request_id",
        ));
    }
    // Lord F1: `cursor` entra aqui e em `SPAWN_PROVIDERS` (frontend); as duas allowlists
    // são independentes e uma sozinha faz o /spawn aceitar e a aba nunca nascer.
    if !matches!(
        request.provider.as_str(),
        "shell" | "claude" | "codex" | "cursor" | "opencode"
    ) {
        return Err(SpawnResponseV1::rejected(
            request.request_id,
            request.provider,
            "invalid_provider",
        ));
    }
    if request.task.trim().is_empty() {
        return Err(SpawnResponseV1::rejected(
            request.request_id,
            request.provider,
            "empty_task",
        ));
    }
    if request.origin.trim().is_empty() {
        return Err(SpawnResponseV1::rejected(
            request.request_id,
            request.provider,
            "invalid_origin",
        ));
    }
    let has_cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_project = request
        .project_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !has_cwd && !has_project {
        return Err(SpawnResponseV1::rejected(
            request.request_id,
            request.provider,
            "missing_target",
        ));
    }
    Ok(request)
}

// Lord D1: O status HTTP acompanha o estado observável, sem `accepted: true` otimista.
fn spawn_http_status(response: &SpawnResponseV1) -> u16 {
    match response.status {
        SpawnStatus::TerminalCreated | SpawnStatus::PtyStarted => 200,
        SpawnStatus::Received => 202,
        SpawnStatus::Rejected if response.reason.as_deref() == Some("no_consumer") => 503,
        SpawnStatus::Rejected if response.reason.as_deref() == Some("no_matching_project") => 422,
        SpawnStatus::Rejected if response.reason.as_deref() == Some("terminal_creation_failed") => 500,
        // Lord D3 camada 2 (ADR-0013): o pedido é bem formado e o alvo existe,
        // mas o terminal de origem não tem esse provider no próprio conjunto —
        // é recusa de autorização, não erro de validação (400).
        SpawnStatus::Rejected if response.reason.as_deref() == Some("provider_nao_permitido") => 403,
        SpawnStatus::Rejected => 400,
    }
}

// Lord D3 camada 2 (ADR-0013): pura — recebe o `projects.json` já lido, sem
// tocar em disco, pra ficar testável sem AppHandle. Percorre o JSON como
// `Value` de propósito: o Rust trata o arquivo como opaque (ver comentário em
// `projects.rs::load_projects`), então o schema de `SubTab` evolui só no TS.
// Casa pelo `ptyId` porque é o identificador que o processo em execução
// conhece de si mesmo (`LORD_TERMINAL_ID`, injetado em `pty.rs` com o mesmo
// valor usado como `id` do PTY).
fn extract_runtimes_permitidos(projects_json: &str, terminal_id: &str) -> Option<Vec<String>> {
    let parsed: Value = serde_json::from_str(projects_json).ok()?;
    let projects = parsed.get("projects")?.as_array()?;
    for project in projects {
        let Some(terminals) = project.get("terminals").and_then(Value::as_array) else {
            continue;
        };
        for terminal in terminals {
            let Some(tabs) = terminal.get("tabs").and_then(Value::as_array) else {
                continue;
            };
            for tab in tabs {
                if tab.get("ptyId").and_then(Value::as_str) != Some(terminal_id) {
                    continue;
                }
                return tab
                    .get("runtimesPermitidos")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|item| item.as_str().map(str::to_string))
                            .collect()
                    });
            }
        }
    }
    None
}

// Lord D3 camada 2 (ADR-0013): lê `projects.json` do perfil ativo e devolve o
// conjunto persistido (D2) da aba cujo `ptyId` é `terminal_id`. `None` cobre
// arquivo ausente, terminal desconhecido e dado anterior à D2 (sem o campo) —
// o chamador decide o default de segurança, ver `provider_allowed`.
fn runtimes_permitidos_for_terminal(app: &AppHandle, terminal_id: &str) -> Option<Vec<String>> {
    let path = projects_file_path(app).ok()?;
    let content = fs::read_to_string(path).ok()?;
    extract_runtimes_permitidos(&content, terminal_id)
}

// Lord D3 camada 2 (ADR-0013): decisão pura e testável. `None` (terminal de
// origem desconhecido, sem `parent_terminal_id`, ou dado pré-D2 sem o campo)
// não bloqueia — o gate fica completo quando toda aba carrega
// `runtimesPermitidos` (backfill da D2). Bloquear nesse caso hoje quebraria
// todo despacho existente, que ainda não declara o campo nem manda o vínculo.
fn provider_allowed(provider: &str, allowed: Option<&[String]>) -> bool {
    match allowed {
        None => true,
        Some(list) => list.iter().any(|item| item == provider),
    }
}

// Lord: honestidade da verificação de escopo (manutenção pós-ADR-0013, item 2).
// `provider_allowed` acima decide CORRETAMENTE não bloquear quando o escopo
// não pôde ser verificado -- bloquear mataria toda ordem externa legítima, já
// contida por token + casamento de cwd + portão de confirmação humana. O que
// faltava era a UI saber DEPOIS que aquele despacho passou sem checagem, em
// vez de aparentar que foi conferido. Este código nunca decide bloquear;
// só rotula, pra `SpawnEventV1.scope_note` carregar a verdade.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ScopeVisibility {
    /// `parent_terminal_id` presente e `runtimesPermitidos` resolvido -- o
    /// provider já passou pela allowlist real do terminal de origem.
    Enforced,
    /// Sem `parent_terminal_id`: ordem externa via HTTP, sem aba pai conhecida.
    NoOrigin,
    /// `parent_terminal_id` presente, mas o terminal é desconhecido ou é
    /// aba anterior à D2 sem o campo `runtimesPermitidos`.
    UnknownOrigin,
}

impl ScopeVisibility {
    /// Código estável (não é texto de UI) que o frontend traduz por i18n.
    /// `None` significa "nada a avisar": o escopo foi de fato verificado.
    fn note_code(self) -> Option<&'static str> {
        match self {
            ScopeVisibility::Enforced => None,
            ScopeVisibility::NoOrigin => Some("sem_terminal_origem"),
            ScopeVisibility::UnknownOrigin => Some("terminal_origem_desconhecido"),
        }
    }
}

fn scope_visibility(parent_terminal_id: Option<&str>, allowed: Option<&[String]>) -> ScopeVisibility {
    match (parent_terminal_id, allowed) {
        (None, _) => ScopeVisibility::NoOrigin,
        (Some(_), None) => ScopeVisibility::UnknownOrigin,
        (Some(_), Some(_)) => ScopeVisibility::Enforced,
    }
}

// Lord D1: Todas as respostas do contrato v1 são JSON e carregam `job_id`.
fn respond_spawn(request: tiny_http::Request, response: SpawnResponseV1) {
    let status = spawn_http_status(&response);
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json")
        .expect("header Content-Type válido");
    let _ = request.respond(
        tiny_http::Response::from_string(
            serde_json::to_string(&response).expect("SpawnResponseV1 serializável"),
        )
        .with_status_code(status)
        .with_header(header),
    );
}

pub fn start_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error: Option<String> = None;
        let mut bound: Option<(tiny_http::Server, u16)> = None;

        for port in DEFAULT_PORT..=MAX_PORT {
            let addr = listener_addr(port);
            match tiny_http::Server::http(&addr) {
                Ok(server) => {
                    bound = Some((server, port));
                    break;
                }
                Err(e) => {
                    last_error = Some(format!("{addr}: {e}"));
                }
            }
        }

        let Some((server, port)) = bound else {
            eprintln!(
                "[agent_events] falha ao subir listener em {HOST}:{DEFAULT_PORT}-{MAX_PORT}: {}",
                last_error.unwrap_or_else(|| "sem erro detalhado".to_string())
            );
            return;
        };

        LISTENER_PORT.store(port, Ordering::SeqCst);
        // Lord B1: Discovery is best-effort so a filesystem error does not disable the listener.
        if let Err(error) = write_listener_discovery(&app, port) {
            eprintln!("[agent_events] failed to write listener discovery: {error}");
        }
        eprintln!("[agent_events] ouvindo em {}", listener_addr(port));

        for mut request in server.incoming_requests() {
            let url = request.url().to_string();

            if !check_token(&request) {
                let _ = request.respond(tiny_http::Response::empty(401));
                continue;
            }

            let mut body = String::new();
            if let Err(e) = request.as_reader().take(BODY_LIMIT).read_to_string(&mut body) {
                eprintln!("[agent_events] erro lendo corpo: {e}");
                let _ = request.respond(tiny_http::Response::empty(400));
                continue;
            }

            // Lord D1: A rota existente muda de contrato; não há `/v1/spawns` nem fallback legado.
            let route = url.split('?').next().unwrap_or(url.as_str());
            if route == "/spawn" {
                if request.method() != &tiny_http::Method::Post {
                    let response = SpawnResponseV1::rejected("", "", "method_not_allowed");
                    respond_spawn(request, response);
                    continue;
                }

                let payload = match parse_spawn_request(&body) {
                    Ok(payload) => payload,
                    Err(response) => {
                        respond_spawn(request, response);
                        continue;
                    }
                };

                // Lord D3 camada 2 (ADR-0013): terceira verificação da rota, depois de
                // token e forma do corpo — o provider precisa estar no conjunto que o
                // usuário liberou para o terminal de origem (`parent_terminal_id`).
                // Fronteira executável: recusa aqui, não só no prompt do agente.
                let allowed = payload
                    .parent_terminal_id
                    .as_deref()
                    .and_then(|terminal_id| runtimes_permitidos_for_terminal(&app, terminal_id));

                if let Some(parent_terminal_id) = payload.parent_terminal_id.as_deref() {
                    if !provider_allowed(&payload.provider, allowed.as_deref()) {
                        let response = SpawnResponseV1::rejected(
                            payload.request_id.clone(),
                            payload.provider.clone(),
                            "provider_nao_permitido",
                        );
                        // Lord D4 (ADR-0013, etapa 3c): a aba de origem só descobre a
                        // recusa por este evento — nunca falha silenciosa.
                        let rejected_event = SpawnRejectedEventV1 {
                            job_id: response.job_id.clone(),
                            request_id: payload.request_id.clone(),
                            provider: payload.provider.clone(),
                            origin: payload.origin.clone(),
                            parent_terminal_id: parent_terminal_id.to_string(),
                            reason: "provider_nao_permitido".to_string(),
                        };
                        if let Err(error) = app.emit("lord-spawn-rejected", &rejected_event) {
                            eprintln!("[agent_events] falha ao emitir lord-spawn-rejected: {error}");
                        }
                        respond_spawn(request, response);
                        continue;
                    }
                }

                // Lord: rótulo honesto de visibilidade (manutenção pós-ADR-0013, item 2).
                // Calculado uma vez e carregado até o evento aceito abaixo -- não muda
                // a decisão de bloquear, só torna visível quando ela não pôde ser tomada.
                let scope_visibility =
                    scope_visibility(payload.parent_terminal_id.as_deref(), allowed.as_deref());

                let registry = app.state::<SpawnRegistry>();
                let (created, received) = registry.begin(&payload.request_id, &payload.provider);

                if created {
                    let event_payload = SpawnEventV1 {
                        version: payload.version,
                        request_id: payload.request_id.clone(),
                        job_id: received.job_id.clone(),
                        provider: payload.provider.clone(),
                        task: payload.task,
                        cwd: payload.cwd,
                        project_id: payload.project_id,
                        origin: payload.origin,
                        name: payload.name,
                        parent_terminal_id: payload.parent_terminal_id,
                        scope_note: scope_visibility.note_code().map(str::to_string),
                    };
                    eprintln!(
                        "[agent_events] /spawn provider={} request_id={} job_id={}",
                        event_payload.provider, event_payload.request_id, event_payload.job_id
                    );
                    if let Err(error) = app.emit("lord-agent-spawn-v1", &event_payload) {
                        eprintln!("[agent_events] falha ao emitir lord-agent-spawn-v1: {error}");
                        let _ = registry.report(
                            &event_payload.request_id,
                            SpawnStatus::Rejected,
                            None,
                            Some("emit_failed".to_string()),
                        );
                    }
                }

                let response = registry.wait_for_outcome(
                    &payload.request_id,
                    SPAWN_CONSUMER_TIMEOUT,
                );
                respond_spawn(request, response);
                continue;
            }

            // Lord D1: O alias `/codex` foi removido junto com o contrato fire-and-forget.
            if route == "/codex" || route.starts_with("/spawn/") {
                let _ = request.respond(tiny_http::Response::empty(404));
                continue;
            }

            // Bridge do plugin OpenCode (opencode_bridge.rs) — reporta
            // working/idle real de sessoes OpenCode. Campos: directory
            // (cwd da sessao, usado pro front correlacionar com o ptyId certo),
            // state ("working" | "idle").
            if url.starts_with("/opencode-status") {
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(payload) => {
                        let _ = app.emit("opencode-bridge-status", &payload);
                    }
                    Err(e) => eprintln!("[agent_events] /opencode-status payload inválido: {e}"),
                }
                let _ = request.respond(tiny_http::Response::empty(200));
                continue;
            }

            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(payload) => {
                    let get = |k: &str| {
                        payload
                            .get(k)
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_owned()
                    };
                    eprintln!(
                        "[agent_events] {} agent_id={} agent_type={}",
                        get("hook_event_name"),
                        get("agent_id"),
                        get("agent_type"),
                    );
                    // Dump truncado pra inspecionar campos reais do payload
                    // durante a POC (Etapa 0 do plano).
                    let preview: String = body.chars().take(600).collect();
                    eprintln!("[agent_events] payload: {preview}");
                    if let Err(e) = app.emit("agent-hook", &payload) {
                        eprintln!("[agent_events] falha ao emitir agent-hook: {e}");
                    }
                }
                Err(e) => eprintln!("[agent_events] POST não-JSON ignorado: {e}"),
            }

            let _ = request.respond(tiny_http::Response::empty(200));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Lord D1: O parser comprova a ruptura intencional com o payload fire-and-forget.
    #[test]
    fn accepts_the_v1_spawn_contract() {
        let request = parse_spawn_request(
            r#"{
                "version": 1,
                "request_id": "request-1",
                "provider": "codex",
                "task": "Implement the slice",
                "cwd": "C:/work/project",
                "origin": "lord"
            }"#,
        )
        .unwrap();

        assert_eq!(request.request_id, "request-1");
        assert_eq!(request.provider, "codex");
    }

    #[test]
    fn rejects_the_legacy_spawn_payload_with_a_traceable_job() {
        let response = parse_spawn_request(
            r#"{"agent":"codex","task":"Implement the slice","mode":"exec"}"#,
        )
        .unwrap_err();

        assert_eq!(response.status, SpawnStatus::Rejected);
        assert_eq!(response.reason.as_deref(), Some("invalid_request"));
        assert!(response.job_id.starts_with("spawn-job-"));
    }

    // Lord F1: o Cursor precisa passar pela mesma allowlist que os demais executores.
    #[test]
    fn accepts_cursor_as_a_v1_provider() {
        let request = parse_spawn_request(
            r#"{
                "version": 1,
                "request_id": "request-cursor",
                "provider": "cursor",
                "task": "Implement the slice",
                "cwd": "C:/work/project",
                "origin": "lord"
            }"#,
        )
        .unwrap();

        assert_eq!(request.request_id, "request-cursor");
        assert_eq!(request.provider, "cursor");
    }

    #[test]
    fn rejects_an_unknown_provider_with_invalid_provider() {
        let response = parse_spawn_request(
            r#"{
                "version": 1,
                "request_id": "request-unknown",
                "provider": "gemini",
                "task": "Implement the slice",
                "cwd": "C:/work/project",
                "origin": "lord"
            }"#,
        )
        .unwrap_err();

        assert_eq!(response.status, SpawnStatus::Rejected);
        assert_eq!(response.reason.as_deref(), Some("invalid_provider"));
        assert_eq!(response.request_id, "request-unknown");
        assert_eq!(response.provider, "gemini");
    }

    // Lord D3 camada 2 (ADR-0013): oráculos da recusa por conjunto de terminal.
    #[test]
    fn rejects_a_provider_outside_the_origin_terminal_allowlist() {
        let allowed = vec!["codex".to_string()];
        assert!(!provider_allowed("claude", Some(&allowed)));
    }

    #[test]
    fn accepts_a_provider_inside_the_origin_terminal_allowlist() {
        let allowed = vec!["codex".to_string(), "claude".to_string()];
        assert!(provider_allowed("claude", Some(&allowed)));
    }

    #[test]
    fn an_empty_allowlist_blocks_every_provider() {
        let allowed: Vec<String> = vec![];
        assert!(!provider_allowed("shell", Some(&allowed)));
    }

    #[test]
    fn unknown_origin_terminal_does_not_block_until_d2_backfills_the_field() {
        assert!(provider_allowed("claude", None));
    }

    // Lord: honestidade da visibilidade de escopo (manutenção pós-ADR-0013, item 2).
    // Estes três oráculos cobrem exatamente os casos que `provider_allowed`
    // deixa passar sem bloquear -- a visibilidade é que muda, não a decisão.
    #[test]
    fn scope_visibility_is_enforced_when_origin_and_allowlist_are_both_known() {
        let allowed = vec!["codex".to_string()];
        assert_eq!(
            scope_visibility(Some("terminal-1"), Some(&allowed)),
            ScopeVisibility::Enforced
        );
    }

    #[test]
    fn scope_visibility_flags_no_origin_for_an_external_order_without_parent_terminal() {
        assert_eq!(scope_visibility(None, None), ScopeVisibility::NoOrigin);
    }

    #[test]
    fn scope_visibility_flags_unknown_origin_when_parent_terminal_has_no_resolved_allowlist() {
        assert_eq!(
            scope_visibility(Some("terminal-ghost"), None),
            ScopeVisibility::UnknownOrigin
        );
    }

    #[test]
    fn only_the_not_enforced_variants_carry_a_note_code() {
        assert_eq!(ScopeVisibility::Enforced.note_code(), None);
        assert_eq!(ScopeVisibility::NoOrigin.note_code(), Some("sem_terminal_origem"));
        assert_eq!(
            ScopeVisibility::UnknownOrigin.note_code(),
            Some("terminal_origem_desconhecido")
        );
    }

    // Lord: o frontend precisa distinguir "null" (verificado) de um código de
    // aviso -- confere a serialização camelCase de `scope_note` nos dois casos.
    #[test]
    fn spawn_event_serializes_scope_note_as_null_when_enforced() {
        let event = SpawnEventV1 {
            version: 1,
            request_id: "request-1".to_string(),
            job_id: "job-1".to_string(),
            provider: "codex".to_string(),
            task: "Implement the slice".to_string(),
            cwd: None,
            project_id: None,
            origin: "lord".to_string(),
            name: None,
            parent_terminal_id: Some("terminal-1".to_string()),
            scope_note: None,
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""scopeNote":null"#));
    }

    #[test]
    fn spawn_event_serializes_scope_note_as_a_code_when_not_enforced() {
        let event = SpawnEventV1 {
            version: 1,
            request_id: "request-1".to_string(),
            job_id: "job-1".to_string(),
            provider: "codex".to_string(),
            task: "Implement the slice".to_string(),
            cwd: None,
            project_id: None,
            origin: "lord".to_string(),
            name: None,
            parent_terminal_id: None,
            scope_note: Some("sem_terminal_origem".to_string()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""scopeNote":"sem_terminal_origem""#));
    }

    #[test]
    fn extracts_the_allowlist_of_the_matching_sub_tab_by_pty_id() {
        let projects_json = r#"{
            "projects": [{
                "terminals": [{
                    "tabs": [
                        { "ptyId": "terminal-other", "runtimesPermitidos": ["shell"] },
                        { "ptyId": "terminal-1", "runtimesPermitidos": ["codex", "claude"] }
                    ]
                }]
            }]
        }"#;

        let allowed = extract_runtimes_permitidos(projects_json, "terminal-1");

        assert_eq!(allowed, Some(vec!["codex".to_string(), "claude".to_string()]));
    }

    #[test]
    fn extract_returns_none_for_an_unknown_terminal_id() {
        let projects_json = r#"{"projects":[{"terminals":[{"tabs":[
            { "ptyId": "terminal-1", "runtimesPermitidos": ["claude"] }
        ]}]}]}"#;

        assert_eq!(extract_runtimes_permitidos(projects_json, "terminal-ghost"), None);
    }

    #[test]
    fn extract_returns_none_for_a_pre_d2_tab_without_the_field() {
        let projects_json = r#"{"projects":[{"terminals":[{"tabs":[
            { "ptyId": "terminal-1" }
        ]}]}]}"#;

        assert_eq!(extract_runtimes_permitidos(projects_json, "terminal-1"), None);
    }

    // Lord D4 (ADR-0013, etapa 3c): o frontend consome isto direto como TS camelCase.
    #[test]
    fn spawn_rejected_event_serializes_in_camel_case_for_the_frontend() {
        let event = SpawnRejectedEventV1 {
            job_id: "spawn-job-1".to_string(),
            request_id: "request-1".to_string(),
            provider: "claude".to_string(),
            origin: "lord".to_string(),
            parent_terminal_id: "terminal-1".to_string(),
            reason: "provider_nao_permitido".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();

        assert!(json.contains(r#""jobId":"spawn-job-1""#));
        assert!(json.contains(r#""parentTerminalId":"terminal-1""#));
        assert!(json.contains(r#""reason":"provider_nao_permitido""#));
    }

    #[test]
    fn provider_not_permitted_maps_to_http_403() {
        let response = SpawnResponseV1::rejected("request-1", "claude", "provider_nao_permitido");
        assert_eq!(spawn_http_status(&response), 403);
    }

    // Lord D3 camada 2 (ADR-0013): decisão de ponta a ponta, ainda pura — composição
    // de `extract_runtimes_permitidos` + `provider_allowed` como o handler faz.
    #[test]
    fn end_to_end_decision_blocks_a_provider_the_origin_terminal_never_declared() {
        let projects_json = r#"{"projects":[{"terminals":[{"tabs":[
            { "ptyId": "terminal-1", "runtimesPermitidos": ["codex"] }
        ]}]}]}"#;

        let allowed = extract_runtimes_permitidos(projects_json, "terminal-1");

        assert!(!provider_allowed("claude", allowed.as_deref()));
        assert!(provider_allowed("codex", allowed.as_deref()));
    }

    #[test]
    fn rejects_empty_tasks_before_emitting_an_event() {
        let response = parse_spawn_request(
            r#"{
                "version": 1,
                "request_id": "request-2",
                "provider": "claude",
                "task": "   ",
                "project_id": "project-a",
                "origin": "lord"
            }"#,
        )
        .unwrap_err();

        assert_eq!(response.status, SpawnStatus::Rejected);
        assert_eq!(response.reason.as_deref(), Some("empty_task"));
        assert_eq!(response.request_id, "request-2");
    }
}
