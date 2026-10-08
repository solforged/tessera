//! The service's launch agent, as `tessera install` writes it, and the switch
//! from whatever build it runs to the one inside this app.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Set by release builds and `scripts/ship`, like the service's build.
pub const BUILD: Option<&str> = option_env!("TESSERA_BUILD");
pub const DEFAULT_PORT: u16 = 4318;
const LABEL: &str = "dev.tessera.serve";

/// Version and build in the form `tessera install` compares.
pub fn identity(version: &str, build: Option<&str>) -> String {
    format!("{version} {}", build.unwrap_or("(development)"))
}

/// What the installed launch agent runs.
#[derive(Debug, Default, PartialEq)]
pub struct Agent {
    pub program: Option<PathBuf>,
    pub notebook: Option<PathBuf>,
    pub port: Option<u16>,
}

impl Agent {
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_PORT)
    }

    pub fn read() -> Self {
        let Some(home) = std::env::home_dir() else {
            return Self::default();
        };
        let plist = home.join(format!("Library/LaunchAgents/{LABEL}.plist"));
        let Ok(output) = Command::new("/usr/bin/plutil")
            .args(["-extract", "ProgramArguments", "json", "-o", "-"])
            .arg(&plist)
            .output()
        else {
            return Self::default();
        };
        if !output.status.success() {
            return Self::default();
        }
        let arguments: Vec<String> = serde_json::from_slice(&output.stdout).unwrap_or_default();
        Self::parse(&arguments)
    }

    fn parse(arguments: &[String]) -> Self {
        let mut agent = Self {
            program: arguments.first().map(PathBuf::from),
            ..Self::default()
        };
        let mut rest = arguments.iter().skip(1);
        while let Some(argument) = rest.next() {
            match argument.as_str() {
                "--notebook" => agent.notebook = rest.next().map(PathBuf::from),
                "--port" => agent.port = rest.next().and_then(|port| port.parse().ok()),
                _ => (),
            }
        }
        agent
    }

    /// Whether the agent already runs `executable`, compared after symlinks.
    pub fn runs(&self, executable: &Path) -> bool {
        let canonical = |path: &Path| std::fs::canonicalize(path).ok();
        self.program
            .as_deref()
            .and_then(canonical)
            .is_some_and(|program| Some(program) == canonical(executable))
    }
}

/// The identity of the service answering on `port`, if any.
pub async fn probe(client: &reqwest::Client, port: u16) -> Option<String> {
    let info: serde_json::Value = client
        .get(format!("http://127.0.0.1:{port}/api/service"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    Some(identity(info["version"].as_str()?, info["build"].as_str()))
}

/// Run the bundled `tessera install`, which stops the old service, backs up
/// the notebook, starts this build and rolls back to `rollback` if it fails.
/// Keeps the agent's notebook and port. Returns the command's report on error.
pub fn activate(bundled: &Path, agent: &Agent, rollback: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new(bundled);
    // The agent's own arguments decide the notebook, not this process's environment.
    command.env_remove("TESSERA_NOTEBOOK");
    if let Some(notebook) = &agent.notebook {
        command.arg("--notebook").arg(notebook);
    }
    command
        .arg("install")
        .arg("--port")
        .arg(agent.port().to_string());
    if let Some(rollback) = rollback {
        command.arg("--rollback").arg(rollback);
    }
    let output = command
        .output()
        .map_err(|error| format!("cannot run {}: {error}", bundled.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let mut report = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if report.is_empty() {
        report = format!(
            "{} install exited with {}",
            bundled.display(),
            output.status
        );
    }
    Err(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn keeps_the_agents_notebook_and_port() {
        let agent = Agent::parse(&arguments(&[
            "/Users/a/.local/bin/tessera",
            "--notebook",
            "/notes/work",
            "serve",
            "--port",
            "4397",
        ]));
        assert_eq!(
            agent,
            Agent {
                program: Some("/Users/a/.local/bin/tessera".into()),
                notebook: Some("/notes/work".into()),
                port: Some(4397),
            }
        );
        assert_eq!(agent.port(), 4397);
    }
}
