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
pub fn install(notebook: Option<&Path>, port: u16, allow_debug: bool) -> anyhow::Result<()> {
    use anyhow::Context;
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    check_executable(&executable, allow_debug)?;
    let home = dirs::home_dir().context("no home directory for the launch agent")?;
    let path = tessera_service::launch_agent_path(&home);
    let logs = home.join("Library/Logs/tessera");
    let notebook = notebook.map(std::path::absolute).transpose()?;
    let content = plist(
        &executable,
        notebook.as_deref(),
        port,
        &logs.join("serve.log"),
    )?;
    std::fs::create_dir_all(path.parent().context("launch agent path has no parent")?)?;
    std::fs::create_dir_all(&logs)?;
    std::fs::write(&path, content)?;
    let domain = domain()?;
    bootout(&domain)?;
    let output = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", &domain])
        .arg(&path)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "launchctl bootstrap failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    println!("http://127.0.0.1:{port}");
    Ok(())
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
pub fn install(_: Option<&std::path::Path>, _: u16, _: bool) -> anyhow::Result<()> {
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
