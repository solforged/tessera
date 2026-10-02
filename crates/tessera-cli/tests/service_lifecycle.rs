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
        .arg("--notebook")
        .arg(notebook)
        .arg("serve")
        .arg("--port")
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
        let mut process = ChildGuard(command(notebook).spawn().unwrap());
        let mut stderr = BufReader::new(process.0.stderr.take().unwrap());
        let mut line = String::new();
        assert_ne!(
            stderr.read_line(&mut line).unwrap(),
            0,
            "service exited before listening"
        );
        let host = line
            .trim()
            .strip_prefix("tessera: http://")
            .unwrap()
            .to_string();
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
        .arg("--notebook")
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
