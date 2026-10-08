#[cfg(any(target_os = "macos", test))]
use std::path::Path;

#[cfg(any(target_os = "macos", test))]
use tessera_service::LAUNCH_AGENT_LABEL as LABEL;

#[cfg(any(target_os = "macos", test))]
fn check_executable(executable: &Path, allow_debug: bool) -> anyhow::Result<()> {
    let mut previous = None;
    for component in executable.components() {
        let name = component.as_os_str();
        if previous == Some(std::ffi::OsStr::new("target")) && name == "debug" && !allow_debug {
            anyhow::bail!(
                "refusing to install a target/debug executable; build a release binary or pass --allow-debug"
            );
        }
        previous = Some(name);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn plist(
    executable: &Path,
    notebook: Option<&Path>,
    port: u16,
    log: &Path,
) -> anyhow::Result<String> {
    use anyhow::Context;
    use std::fmt::Write;

    fn xml(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }
    fn path(path: &Path) -> anyhow::Result<String> {
        Ok(xml(path
            .to_str()
            .context("launch agent paths must be valid UTF-8")?))
    }
    let mut arguments = format!("    <string>{}</string>\n", path(executable)?);
    if let Some(notebook) = notebook {
        writeln!(
            arguments,
            "    <string>--notebook</string>\n    <string>{}</string>",
            path(notebook)?
        )?;
    }
    arguments.push_str("    <string>serve</string>\n");
    if port != tessera_service::DEFAULT_PORT {
        writeln!(
            arguments,
            "    <string>--port</string>\n    <string>{port}</string>"
        )?;
    }
    let log = path(log)?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
  <key>EnvironmentVariables</key>
  <dict><key>RUST_LOG</key><string>info</string></dict>
</dict>
</plist>
"#
    ))
}

#[cfg(target_os = "macos")]
fn domain() -> anyhow::Result<String> {
    use anyhow::Context;
    let output = std::process::Command::new("/usr/bin/id")
        .arg("-u")
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "cannot determine the launch agent user"
    );
    let uid: u32 = std::str::from_utf8(&output.stdout)?
        .trim()
        .parse()
        .context("invalid user ID")?;
    Ok(format!("gui/{uid}"))
}

#[cfg(target_os = "macos")]
fn bootout(domain: &str) -> anyhow::Result<()> {
    let target = format!("{domain}/{LABEL}");
    let output = std::process::Command::new("/bin/launchctl")
        .args(["bootout", &target])
        .output()?;
    anyhow::ensure!(
        output.status.success() || output.status.code() == Some(3),
        "launchctl bootout failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    // bootout returns while a running service is still draining, and
    // bootstrapping the label meanwhile fails with EIO. launchd kills the
    // service after its 20-second exit timeout, which bounds this wait.
    for _ in 0..250 {
        let loaded = std::process::Command::new("/bin/launchctl")
            .args(["print", &target])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?
            .success();
        if !loaded {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    anyhow::bail!("the previous launch agent did not stop within 25 seconds")
}

#[cfg(target_os = "macos")]
fn bootstrap(domain: &str, plist: &Path) -> anyhow::Result<()> {
    let output = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", domain])
        .arg(plist)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "launchctl bootstrap failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

/// Wait until the service on `url` reports this executable's version and build.
#[cfg(target_os = "macos")]
fn wait_for_build(url: &str) -> anyhow::Result<()> {
    use std::time::{Duration, Instant};
    let expected = format!(
        "{} {}",
        tessera_service::VERSION,
        tessera_service::BUILD.unwrap_or("(development)")
    );
    tokio::runtime::Runtime::new()?.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut last = "nothing answered".to_string();
        while Instant::now() < deadline {
            if let Ok(response) = client.get(format!("{url}/api/service")).send().await
                && let Ok(info) = response.json::<serde_json::Value>().await
            {
                let found = format!(
                    "{} {}",
                    info["version"].as_str().unwrap_or("?"),
                    info["build"].as_str().unwrap_or("(development)")
                );
                if found == expected {
                    return Ok(());
                }
                last = format!("{found} answered");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        anyhow::bail!("Tessera {expected} did not answer at {url} within 60 seconds; {last}")
    })
}

#[cfg(target_os = "macos")]
fn log_tail(log: &Path) -> String {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(20)..].join("\n")
}

/// Make this executable the launch agent's service. Stops the old service,
/// backs up the notebook, starts this build and waits for it to answer. If it
/// does not, and `rollback` names the previous executable, restores the backup
/// with that executable and puts it back as the service.
#[cfg(target_os = "macos")]
pub fn install(
    notebook: &Path,
    explicit_notebook: bool,
    port: u16,
    allow_debug: bool,
    rollback: Option<&Path>,
) -> anyhow::Result<()> {
    use anyhow::Context;
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    check_executable(&executable, allow_debug)?;
    let rollback = rollback
        .map(|path| {
            std::fs::canonicalize(path)
                .with_context(|| format!("no rollback executable at {}", path.display()))
        })
        .transpose()?;
    let home = dirs::home_dir().context("no home directory for the launch agent")?;
    let path = tessera_service::launch_agent_path(&home);
    let logs = home.join("Library/Logs/tessera");
    let log = logs.join("serve.log");
    let notebook = std::path::absolute(notebook)?;
    let pinned = explicit_notebook.then_some(notebook.as_path());
    let content = plist(&executable, pinned, port, &log)?;
    std::fs::create_dir_all(path.parent().context("launch agent path has no parent")?)?;
    std::fs::create_dir_all(&logs)?;
    let domain = domain()?;
    // Stop first, so the backup holds every edit the old service acknowledged.
    bootout(&domain)?;
    let backup = if notebook.join(tessera_core::DATABASE_FILE).exists() {
        match tessera_core::backup_beside(&notebook) {
            Ok((backup, _)) => {
                eprintln!("tessera: backed up the notebook to {}", backup.display());
                Some(backup)
            }
            Err(error) => {
                // The old plist is untouched; bring its service back.
                if path.exists() {
                    bootstrap(&domain, &path)?;
                }
                return Err(anyhow::Error::from(error)
                    .context("cannot back up the notebook; the previous service is unchanged"));
            }
        }
    } else {
        None
    };
    std::fs::write(&path, content)?;
    bootstrap(&domain, &path)?;
    let url = format!("http://127.0.0.1:{port}");
    let error = match wait_for_build(&url) {
        Ok(()) => {
            println!("{url}");
            return Ok(());
        }
        Err(error) => error,
    };
    let tail = log_tail(&log);
    let backup_note = backup.as_ref().map_or(String::new(), |backup| {
        format!("; the pre-install backup is {}", backup.display())
    });
    let Some(previous) = rollback else {
        anyhow::bail!("{error}{backup_note}\n{tail}");
    };
    bootout(&domain)?;
    if let Some(backup) = &backup {
        // The previous build restores, so the notebook keeps a schema it can open.
        let status = std::process::Command::new(&previous)
            .arg("--notebook")
            .arg(&notebook)
            .arg("restore")
            .arg(backup)
            .arg("--force")
            .stdout(std::process::Stdio::null())
            .status()?;
        anyhow::ensure!(
            status.success(),
            "{error}; restoring {} with {} also failed",
            backup.display(),
            previous.display()
        );
    }
    std::fs::write(&path, plist(&previous, pinned, port, &log)?)?;
    bootstrap(&domain, &path)?;
    anyhow::bail!(
        "{error}; rolled back to {}{backup_note}\n{tail}",
        previous.display()
    )
}

#[cfg(target_os = "macos")]
pub fn uninstall() -> anyhow::Result<()> {
    use anyhow::Context;
    let home = dirs::home_dir().context("no home directory for the launch agent")?;
    bootout(&domain()?)?;
    match std::fs::remove_file(tessera_service::launch_agent_path(&home)) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(
    _: &std::path::Path,
    _: bool,
    _: u16,
    _: bool,
    _: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    anyhow::bail!("tessera install is only supported on macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn uninstall() -> anyhow::Result<()> {
    anyhow::bail!("tessera uninstall is only supported on macOS")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_launch_agent_defaults() {
        let rendered = plist(
            Path::new("/opt/tessera"),
            None,
            tessera_service::DEFAULT_PORT,
            Path::new("/home/user/Library/Logs/tessera/serve.log"),
        )
        .unwrap();
        assert!(rendered.contains("<key>Label</key><string>dev.tessera.serve</string>"));
        assert!(rendered.contains("<string>/opt/tessera</string>\n    <string>serve</string>"));
        assert!(!rendered.contains("--notebook"));
        assert!(!rendered.contains("--port"));
        assert!(rendered.contains("<key>RunAtLoad</key><true/>"));
        assert!(rendered.contains("<key>KeepAlive</key><true/>"));
        assert!(rendered.contains("<key>RUST_LOG</key><string>info</string>"));
        assert_eq!(
            rendered
                .matches("<string>/home/user/Library/Logs/tessera/serve.log</string>")
                .count(),
            2
        );
        println!("{rendered}");
    }

    #[test]
    fn renders_explicit_notebook_port_and_xml_escaping() {
        let rendered = plist(
            Path::new("/Applications/A & B/tessera"),
            Some(Path::new("/notes/<work>\"'")),
            4397,
            Path::new("/logs/a&b.log"),
        )
        .unwrap();
        assert!(rendered.contains("<string>/Applications/A &amp; B/tessera</string>"));
        assert!(rendered.contains(
            "<string>--notebook</string>\n    <string>/notes/&lt;work&gt;&quot;&apos;</string>"
        ));
        assert!(rendered.contains("<string>--port</string>\n    <string>4397</string>"));
        assert_eq!(
            rendered
                .matches("<string>/logs/a&amp;b.log</string>")
                .count(),
            2
        );
    }

    #[test]
    fn refuses_debug_executable_without_opt_in() {
        assert!(check_executable(Path::new("/src/target/debug/tessera"), false).is_err());
        assert!(check_executable(Path::new("/src/target/debug/deps/tessera"), false).is_err());
        assert!(check_executable(Path::new("/src/target/debug/tessera"), true).is_ok());
        assert!(check_executable(Path::new("/src/target/release/tessera"), false).is_ok());
        assert!(check_executable(Path::new("/src/not-target/debug/tessera"), false).is_ok());
    }
}
