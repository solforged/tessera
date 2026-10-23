#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, ChildStderr, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use tessera_core::{Actor, Batch, Committed, DATABASE_FILE, Operation};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn command(notebook: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tessera"));
    command
        .arg("--workshop")
        .arg(notebook)
        .arg("serve")
        .arg("--port")
        .arg("0")
        .arg("--sync-port")
        .arg("0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}
fn wait_for_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
struct Service {
    process: ChildGuard,
    _stderr: BufReader<ChildStderr>,
    host: String,
    port: u16,
}
impl Service {
    fn start(notebook: &Path) -> Self {
        Self::spawn(command(notebook))
    }
    fn spawn(mut command: Command) -> Self {
        let mut process = ChildGuard(command.spawn().unwrap());
        let mut stderr = BufReader::new(process.0.stderr.take().unwrap());
        let mut line = String::new();
        let host = loop {
            line.clear();
            assert_ne!(
                stderr.read_line(&mut line).unwrap(),
                0,
                "service exited before listening"
            );
            if line.contains("service listening") {
                break line.split_once("http://").unwrap().1.trim().to_string();
            }
        };
        let port = host.rsplit(':').next().unwrap().parse().unwrap();
        Self {
            process,
            _stderr: stderr,
            host,
            port,
        }
    }
    fn signal(&self, signal: &str) {
        assert!(
            Command::new("kill")
                .arg(format!("-{signal}"))
                .arg(self.process.0.id().to_string())
                .status()
                .unwrap()
                .success()
        );
    }
    fn stop(&mut self) {
        self.signal("INT");
        let status = wait_for_exit(&mut self.process.0, Duration::from_secs(5))
            .expect("service did not drain");
        assert!(status.success(), "{status}");
    }
}

#[tokio::test]
async fn notebook_has_one_service_owner_until_that_process_exits() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = Service::start(dir.path());
    let info: serde_json::Value = reqwest::get(format!("http://{}/api/notebook", first.host))
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let reader = Command::new(env!("CARGO_BIN_EXE_tessera"))
        .arg("--workshop")
        .arg(dir.path())
        .arg("info")
        .output()
        .unwrap();
    assert!(
        reader.status.success(),
        "info must remain usable while a service owns the notebook"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&reader.stdout).unwrap()["id"],
        info["id"]
    );
    let mut second = ChildGuard(command(dir.path()).spawn().unwrap());
    let status = wait_for_exit(&mut second.0, Duration::from_secs(2))
        .expect("a second service must fail fast, not accept another port for the same notebook");
    assert!(!status.success());
    let mut error = String::new();
    second
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut error)
        .unwrap();
    assert!(
        error.contains(&first.process.0.id().to_string()),
        "missing holder PID: {error}"
    );
    assert!(
        error.contains(&first.port.to_string()),
        "missing holder port: {error}"
    );
    first.stop();
    let mut restarted = Service::start(dir.path());
    let after: serde_json::Value = reqwest::get(format!("http://{}/api/notebook", restarted.host))
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["id"], info["id"]);
    restarted.stop();
}

fn headers(reader: &mut BufReader<TcpStream>) -> (String, Vec<(String, String)>) {
    let mut status = String::new();
    assert_ne!(
        reader.read_line(&mut status).unwrap(),
        0,
        "accepted request closed without a response"
    );
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        let (name, value) = line.trim().split_once(':').unwrap();
        headers.push((name.to_ascii_lowercase(), value.trim().to_string()));
    }
    (status, headers)
}

#[test]
fn sigterm_and_ctrl_c_drain_an_accepted_batch_before_exiting() {
    for signal in ["TERM", "INT"] {
        let dir = tempfile::tempdir().unwrap();
        let mut service = Service::start(dir.path());
        let conn = rusqlite::Connection::open(dir.path().join(DATABASE_FILE)).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        let body = serde_json::to_vec(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: vec![Operation::CreatePage {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
                title: "Drained".into(),
            }],
        })
        .unwrap();
        let socket = TcpStream::connect(&service.host).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        write!(reader.get_mut(), "POST /api/batches HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n", service.host, body.len()).unwrap();
        let (interim, _) = headers(&mut reader);
        // Hyper emits this only after the accepted route polls its request body.
        assert!(interim.starts_with("HTTP/1.1 100"), "{interim}");
        reader.get_mut().write_all(&body).unwrap();
        service.signal(signal);
        conn.execute_batch("COMMIT").unwrap();
        let (response, response_headers) = headers(&mut reader);
        assert!(response.starts_with("HTTP/1.1 200"), "{signal}: {response}");
        let length: usize = response_headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .unwrap()
            .1
            .parse()
            .unwrap();
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).unwrap();
        let committed: Committed = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(committed.seq, 1);
        assert_eq!(committed.revisions[0].id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        let status = wait_for_exit(&mut service.process.0, Duration::from_secs(5))
            .expect("shutdown did not finish");
        assert!(status.success(), "{signal}: {status}");
        let page: String = conn
            .query_row(
                "SELECT text FROM blocks WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(page, "Drained");
    }
}

#[test]
fn cli_backup_and_restore_round_trip_while_service_runs() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let backup = root.path().join("backup");
    let restored = root.path().join("restored");
    let mut service = Service::start(&source);
    let run = |notebook: &Path, args: &[&std::ffi::OsStr]| {
        Command::new(env!("CARGO_BIN_EXE_tessera"))
            .arg("--workshop")
            .arg(notebook)
            .args(args)
            .output()
            .unwrap()
    };
    let saved = run(&source, &["backup".as_ref(), backup.as_os_str()]);
    assert!(
        saved.status.success(),
        "{}",
        String::from_utf8_lossy(&saved.stderr)
    );
    let manifest: serde_json::Value = serde_json::from_slice(&saved.stdout).unwrap();
    let copied = run(&backup, &["info".as_ref()]);
    assert!(copied.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&copied.stdout).unwrap()["id"],
        manifest["notebook_id"]
    );
    let refused = run(
        &source,
        &["restore".as_ref(), backup.as_os_str(), "--force".as_ref()],
    );
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("already served"));
    let output = run(&restored, &["restore".as_ref(), backup.as_os_str()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["id"],
        manifest["notebook_id"]
    );
    service.stop();
}

#[tokio::test]
async fn app_restore_reopens_the_workshop_and_recovers_a_pending_restore() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join(".local/share/tessera/workshops/main");
    let mut service = Service::spawn(isolated(root.path(), None));
    let before = serving(&service.host, &source).await;
    let client = reqwest::Client::new();
    let base = format!("http://{}", service.host);
    let first_page = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let second_page = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    for (id, title) in [(first_page, "Before backup"), (second_page, "After backup")] {
        client
            .post(format!("{base}/api/batches"))
            .json(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![Operation::CreatePage {
                    id: id.into(),
                    title: title.into(),
                }],
            })
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        if id == first_page {
            client
                .post(format!("{base}/api/backups"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
    }
    let backups: serde_json::Value = client
        .get(format!("{base}/api/backups"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let first = backups["backups"][0].clone();
    let name = first["name"].as_str().unwrap();
    let response = client
        .post(format!("{base}/api/backups/{name}/restore"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let restored: serde_json::Value = response.json().await.unwrap();
    assert_eq!(restored["restoring"], true);
    assert_eq!(restored["backup"], first);
    assert!(restored["safety"].is_object());
    let after = serving(&service.host, &source).await;
    assert_eq!(after["id"], before["id"]);
    assert_eq!(after["path"], before["path"]);
    assert!(!source.join("restore.pending").exists());
    assert_eq!(
        client
            .get(format!("{base}/api/blocks/{first_page}"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{base}/api/blocks/{second_page}"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let backups: serde_json::Value = client
        .get(format!("{base}/api/backups"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        backups["backups"]
            .as_array()
            .unwrap()
            .contains(&restored["safety"])
    );
    let safety_path = Path::new(restored["safety"]["path"].as_str().unwrap());
    assert!(safety_path.join("manifest.json").is_file());
    assert!(!safety_path.join("restore.pending").exists());

    // Even the newest backup is a valid restore point.
    let newest = backups["backups"][0]["name"].as_str().unwrap();
    let response = client
        .post(format!("{base}/api/backups/{newest}/restore"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    serving(&service.host, &source).await;
    assert_eq!(
        client
            .get(format!("{base}/api/blocks/{second_page}"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    service.stop();

    // A crash after publishing the marker must finish the restore on next launch.
    let marker = source.join("restore.pending");
    std::fs::write(
        &marker,
        serde_json::to_vec(&serde_json::json!({
            "source": first["path"],
            "requested_at": tessera_core::now_ms(),
        }))
        .unwrap(),
    )
    .unwrap();
    for action in ["info", "check"] {
        let output = Command::new(env!("CARGO_BIN_EXE_tessera"))
            .arg("--workshop")
            .arg(&source)
            .arg(action)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut restarted = Service::spawn(isolated(root.path(), None));
    assert_eq!(serving(&restarted.host, &source).await["id"], before["id"]);
    assert!(!marker.exists());
    assert_eq!(
        reqwest::get(format!("http://{}/api/blocks/{first_page}", restarted.host))
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        reqwest::get(format!(
            "http://{}/api/blocks/{second_page}",
            restarted.host
        ))
        .await
        .unwrap()
        .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    assert!(safety_path.join("manifest.json").is_file());
    restarted.stop();

    std::fs::write(
        &marker,
        serde_json::to_vec(&serde_json::json!({
            "source": root.path().join("missing-backup"),
            "requested_at": tessera_core::now_ms(),
        }))
        .unwrap(),
    )
    .unwrap();
    let mut recovered = Service::spawn(isolated(root.path(), None));
    assert_eq!(serving(&recovered.host, &source).await["id"], before["id"]);
    assert!(!marker.exists());
    recovered.stop();
}

/// A service whose platform data directory, and so its notebook list, lives under `home`.
fn isolated(home: &Path, notebook: Option<&Path>) -> Command {
    let home = std::fs::canonicalize(home).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_tessera"));
    command
        .env("HOME", &home)
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_STATE_HOME", home.join(".local/state"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env_remove("TESSERA_WORKSHOP");
    if let Some(notebook) = notebook {
        command.arg("--workshop").arg(notebook);
    }
    command
        .args(["serve", "--port", "0", "--sync-port", "0"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

async fn open_notebook(host: &str, path: &Path, create: bool) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{host}/api/notebooks/open"))
        .json(&serde_json::json!({ "path": path, "create": create }))
        .send()
        .await
        .unwrap()
}

/// Wait for the service at `host` to answer with the notebook at `path`.
async fn serving(host: &str, path: &Path) -> serde_json::Value {
    let path = std::fs::canonicalize(path).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(response) = reqwest::get(format!("http://{host}/api/notebook")).await
            && let Ok(info) = response.json::<serde_json::Value>().await
            && info["path"].as_str() == path.to_str()
        {
            return info;
        }
        assert!(
            Instant::now() < deadline,
            "service never reopened on {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn switching_reopens_the_same_process_and_port_and_refuses_old_windows() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let mut service = Service::spawn(isolated(root.path(), Some(&first)));
    let pid = service.process.0.id();
    let before = serving(&service.host, &first).await;
    let response = open_notebook(&service.host, &second, false).await;
    assert_eq!(
        response.status(),
        reqwest::StatusCode::NOT_FOUND,
        "opening must not create a notebook unless asked"
    );
    assert!(!second.exists());
    let response = open_notebook(&service.host, &second, true).await;
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let after = serving(&service.host, &second).await;
    assert_ne!(after["id"], before["id"]);
    assert!(
        service.process.0.try_wait().unwrap().is_none(),
        "the service process must survive the switch"
    );
    assert_eq!(service.process.0.id(), pid);
    // A window that opened the first notebook must not read or write the second.
    let stale = reqwest::Client::new()
        .get(format!("http://{}/api/roots", service.host))
        .header("X-Tessera-Notebook", before["id"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), reqwest::StatusCode::CONFLICT);
    let error: serde_json::Value = stale.json().await.unwrap();
    assert_eq!(error["error"]["code"], "notebook_changed");
    let current = reqwest::Client::new()
        .get(format!("http://{}/api/roots", service.host))
        .header("X-Tessera-Notebook", after["id"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), reqwest::StatusCode::OK);
    // The notebook left behind stays on the list and opens again.
    let list: serde_json::Value = reqwest::get(format!("http://{}/api/notebooks", service.host))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let first_path = std::fs::canonicalize(&first).unwrap();
    assert!(
        list["notebooks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"].as_str() == first_path.to_str()
                && entry["current"] == false)
    );
    let response = open_notebook(&service.host, &first, false).await;
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    assert_eq!(serving(&service.host, &first).await["id"], before["id"]);
    service.stop();
}

#[tokio::test]
async fn a_switch_without_notebook_argument_becomes_the_startup_notebook() {
    let root = tempfile::tempdir().unwrap();
    let other = root.path().join("other");
    let mut service = Service::spawn(isolated(root.path(), None));
    let response = open_notebook(&service.host, &other, true).await;
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let opened = serving(&service.host, &other).await;
    service.stop();
    let mut restarted = Service::spawn(isolated(root.path(), None));
    assert_eq!(serving(&restarted.host, &other).await["id"], opened["id"]);
    restarted.stop();
    // An explicit notebook still wins over the remembered one.
    let pinned = root.path().join("pinned");
    let mut explicit = Service::spawn(isolated(root.path(), Some(&pinned)));
    serving(&explicit.host, &pinned).await;
    explicit.stop();
}

#[tokio::test]
async fn bare_names_open_in_the_xdg_workshops_directory_and_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut service = Service::spawn(isolated(root.path(), None));
    let target = root.path().join(".local/share/tessera/workshops/reading");
    let response = open_notebook(&service.host, Path::new("reading"), true).await;
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let opened = serving(&service.host, &target).await;
    let list: serde_json::Value = reqwest::get(format!("http://{}/api/notebooks", service.host))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entry = list["notebooks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["current"] == true)
        .unwrap();
    assert_eq!(entry["named"], true);
    assert_eq!(entry["available"], true);
    assert_eq!(
        entry["display_path"],
        "~/.local/share/tessera/workshops/reading"
    );
    service.stop();
    let mut restarted = Service::spawn(isolated(root.path(), None));
    assert_eq!(serving(&restarted.host, &target).await["id"], opened["id"]);
    restarted.stop();
}
