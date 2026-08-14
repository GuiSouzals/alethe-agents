// Lord D1: Estado correlacionado e idempotente do contrato incompatível de `/spawn` v1.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpawnStatus {
    Received,
    TerminalCreated,
    PtyStarted,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpawnResponseV1 {
    pub version: u8,
    pub request_id: String,
    pub job_id: String,
    pub provider: String,
    pub status: SpawnStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SpawnResponseV1 {
    // Lord D1: Rejeições de validação também carregam um `job_id` rastreável.
    pub fn rejected(
        request_id: impl Into<String>,
        provider: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            version: 1,
            request_id: request_id.into(),
            job_id: format!("spawn-job-{}", nanoid::nanoid!(10)),
            provider: provider.into(),
            status: SpawnStatus::Rejected,
            terminal_id: None,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Clone, Debug)]
struct SpawnEntry {
    response: SpawnResponseV1,
    claimed: bool,
}

#[derive(Default)]
pub struct SpawnRegistry {
    entries: Mutex<HashMap<String, SpawnEntry>>,
    changed: Condvar,
}

impl SpawnRegistry {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, SpawnEntry>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // Lord D1: A primeira inserção emite trabalho; repetições reutilizam o mesmo registro.
    pub fn begin(&self, request_id: &str, provider: &str) -> (bool, SpawnResponseV1) {
        let mut entries = self.entries();
        if let Some(entry) = entries.get(request_id) {
            return (false, entry.response.clone());
        }

        let response = SpawnResponseV1 {
            version: 1,
            request_id: request_id.to_string(),
            job_id: format!("spawn-job-{}", nanoid::nanoid!(10)),
            provider: provider.to_string(),
            status: SpawnStatus::Received,
            terminal_id: None,
            reason: None,
        };
        entries.insert(
            request_id.to_string(),
            SpawnEntry {
                response: response.clone(),
                claimed: false,
            },
        );
        (true, response)
    }

    // Lord D1: Só um listener pode reivindicar a criação da aba para cada `request_id`.
    pub fn claim(&self, request_id: &str) -> bool {
        let mut entries = self.entries();
        let claimed = match entries.get_mut(request_id) {
            Some(entry) if entry.response.status == SpawnStatus::Received && !entry.claimed => {
                entry.claimed = true;
                true
            }
            _ => false,
        };
        if claimed {
            self.changed.notify_all();
        }
        claimed
    }

    // Lord D1: O frontend só confirma estados que observou; transições terminais não regridem.
    pub fn report(
        &self,
        request_id: &str,
        status: SpawnStatus,
        terminal_id: Option<String>,
        reason: Option<String>,
    ) -> Result<SpawnResponseV1, String> {
        let mut entries = self.entries();
        let entry = entries
            .get_mut(request_id)
            .ok_or_else(|| "request_id desconhecido".to_string())?;

        match entry.response.status {
            SpawnStatus::Rejected | SpawnStatus::PtyStarted => return Ok(entry.response.clone()),
            SpawnStatus::TerminalCreated if status == SpawnStatus::PtyStarted => {
                let reported_terminal = terminal_id
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| "pty_started exige terminal_id".to_string())?;
                if entry.response.terminal_id.as_deref() != Some(reported_terminal.as_str()) {
                    return Err("terminal_id diverge do terminal já confirmado".to_string());
                }
                entry.response.status = SpawnStatus::PtyStarted;
            }
            SpawnStatus::TerminalCreated => return Ok(entry.response.clone()),
            SpawnStatus::Received => match status {
                SpawnStatus::TerminalCreated => {
                    let terminal_id = terminal_id
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| "terminal_created exige terminal_id".to_string())?;
                    entry.response.status = SpawnStatus::TerminalCreated;
                    entry.response.terminal_id = Some(terminal_id);
                    entry.response.reason = None;
                }
                SpawnStatus::Rejected => {
                    let reason = reason
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "rejected exige reason".to_string())?;
                    entry.response.status = SpawnStatus::Rejected;
                    entry.response.reason = Some(reason);
                }
                SpawnStatus::Received => return Ok(entry.response.clone()),
                SpawnStatus::PtyStarted => {
                    return Err("pty_started exige terminal_created anterior".to_string())
                }
            },
        }

        let response = entry.response.clone();
        self.changed.notify_all();
        Ok(response)
    }

    // Lord D1: Sem reivindicação até o prazo, o estado termina explicitamente em rejeição.
    pub fn wait_for_outcome(&self, request_id: &str, timeout: Duration) -> SpawnResponseV1 {
        let entries = self.entries();
        let (mut entries, _) = self
            .changed
            .wait_timeout_while(entries, timeout, |entries| {
                entries
                    .get(request_id)
                    .map(|entry| entry.response.status == SpawnStatus::Received)
                    .unwrap_or(false)
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let entry = entries
            .get_mut(request_id)
            .expect("registro de spawn removido durante espera");
        if entry.response.status == SpawnStatus::Received && !entry.claimed {
            entry.response.status = SpawnStatus::Rejected;
            entry.response.reason = Some("no_consumer".to_string());
        }
        entry.response.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Lord D1: Oráculos de correlação, consumidor único e ausência de falso `queued`.
    #[test]
    fn repeated_request_returns_the_same_terminal() {
        let registry = SpawnRegistry::default();
        let (_, first) = registry.begin("request-1", "codex");
        assert!(registry.claim("request-1"));
        let completed = registry
            .report(
                "request-1",
                SpawnStatus::TerminalCreated,
                Some("terminal-1".to_string()),
                None,
            )
            .unwrap();
        let (created, repeated) = registry.begin("request-1", "codex");

        assert!(!created);
        assert_eq!(repeated.job_id, first.job_id);
        assert_eq!(repeated, completed);
        assert_eq!(repeated.terminal_id.as_deref(), Some("terminal-1"));
    }

    #[test]
    fn only_one_consumer_can_claim_a_request() {
        let registry = SpawnRegistry::default();
        registry.begin("request-2", "claude");

        assert!(registry.claim("request-2"));
        assert!(!registry.claim("request-2"));
    }

    #[test]
    fn event_without_consumer_is_rejected_instead_of_queued() {
        let registry = SpawnRegistry::default();
        registry.begin("request-3", "opencode");

        let response = registry.wait_for_outcome("request-3", Duration::ZERO);

        assert_eq!(response.status, SpawnStatus::Rejected);
        assert_eq!(response.reason.as_deref(), Some("no_consumer"));
        assert!(!serde_json::to_string(&response).unwrap().contains("queued"));
    }

    #[test]
    fn claimed_request_can_remain_received_until_terminal_confirmation() {
        let registry = SpawnRegistry::default();
        registry.begin("request-4", "codex");
        assert!(registry.claim("request-4"));

        let response = registry.wait_for_outcome("request-4", Duration::ZERO);

        assert_eq!(response.status, SpawnStatus::Received);
        assert_eq!(response.reason, None);
    }
}
