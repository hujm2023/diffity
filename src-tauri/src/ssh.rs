//! SSH transport. The remote endpoint exposes a fixed set of reads, never shell commands from the UI.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const HELPER: &str = include_str!("ssh_helper.py");
const BOOTSTRAP: &str = "python3 -c 'import json,sys; p=json.load(sys.stdin); s=p.pop(\"source\"); exec(compile(s,\"diffity-ssh\",\"exec\"),{\"__name__\":\"__main__\",\"request\":p})'";
const MAX_RESPONSE: u64 = 96 * 1024 * 1024;
const READS: &[&str] = &[
    "open_repo",
    "repo_remote_url",
    "git_status",
    "repo_overview",
    "list_worktrees",
    "list_tree",
    "read_file",
    "read_file_base64",
    "resolve_ref",
    "get_diff",
    "get_file_patch",
    "get_file_versions",
    "diff_fingerprint",
    "list_commits",
    "list_branches",
    "detect_agents",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshError {
    pub code: String,
    pub message: String,
}

impl SshError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for SshError {
    fn from(error: std::io::Error) -> Self {
        Self::new("ssh", error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub path: String,
}

pub fn is_remote(path: &str) -> bool {
    path.starts_with("ssh://")
}

fn decode(value: &str) -> Result<String, SshError> {
    let mut output = Vec::new();
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            output.push(byte);
            continue;
        }
        let a = bytes.next().and_then(|b| (b as char).to_digit(16));
        let b = bytes.next().and_then(|b| (b as char).to_digit(16));
        match (a, b) {
            (Some(a), Some(b)) => output.push((a * 16 + b) as u8),
            _ => return Err(SshError::new("invalid", "Invalid SSH path encoding")),
        }
    }
    String::from_utf8(output).map_err(|_| SshError::new("invalid", "SSH path must be UTF-8"))
}

impl Target {
    pub fn parse(locator: &str) -> Result<Self, SshError> {
        let (host, path) = locator
            .strip_prefix("ssh://")
            .and_then(|value| value.split_once('/'))
            .ok_or_else(|| SshError::new("invalid", "Expected ssh://host/absolute/path"))?;
        if host.is_empty()
            || host.starts_with('-')
            || host.len() > 255
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-@:".contains(&b))
        {
            return Err(SshError::new(
                "invalid",
                "Enter an SSH host alias or user@hostname",
            ));
        }
        let path = decode(path)?;
        let path = if path.starts_with("~/") {
            path
        } else {
            format!("/{path}")
        };
        if path.contains('\0') {
            return Err(SshError::new(
                "invalid",
                "SSH paths may not contain NUL bytes",
            ));
        }
        Ok(Self {
            host: host.to_string(),
            path,
        })
    }

    pub fn locator(&self) -> String {
        let mut path = String::new();
        for byte in self.path.bytes() {
            if byte.is_ascii_alphanumeric() || b"/._-~".contains(&byte) {
                path.push(byte as char);
            } else {
                path.push_str(&format!("%{byte:02X}"));
            }
        }
        format!("ssh://{}/{}", self.host, path.trim_start_matches('/'))
    }
}

async fn bounded_read(reader: impl AsyncRead + Unpin, limit: u64) -> Result<Vec<u8>, SshError> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > limit {
        return Err(SshError::new(
            "too_large",
            "SSH response exceeds the size limit",
        ));
    }
    Ok(bytes)
}

pub async fn request(locator: &str, operation: &str, args: Value) -> Result<Value, SshError> {
    if !READS.contains(&operation) {
        return Err(SshError::new(
            "read_only",
            "SSH repositories support read-only operations only",
        ));
    }
    let target = Target::parse(locator)?;
    let payload = serde_json::to_vec(&json!({
        "source": HELPER, "repo": target.path, "operation": operation, "args": args,
    }))
    .map_err(|error| SshError::new("json", error.to_string()))?;
    let mut child = Command::new("ssh")
        .args([
            "-T",
            "-x",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            &target.host,
            BOOTSTRAP,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| SshError::new("ssh", format!("Could not start system SSH: {error}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| SshError::new("ssh", "Missing SSH stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SshError::new("ssh", "Missing SSH stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SshError::new("ssh", "Missing SSH stderr"))?;
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        let send = async {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, SshError>(())
        };
        let (_, stdout, stderr, status) = tokio::try_join!(
            send, bounded_read(stdout, MAX_RESPONSE), bounded_read(stderr, 64 * 1024),
            async { Ok::<_, SshError>(child.wait().await?) },
        )?;
        if !status.success() {
            return Err(SshError::new("ssh", format!(
                "SSH connection failed: {}. Verify this host with SSH in a terminal first; the remote needs Git and Python 3.",
                String::from_utf8_lossy(&stderr).trim(),
            )));
        }
        let response: Value = serde_json::from_slice(&stdout)
            .map_err(|_| SshError::new("ssh_protocol", "Invalid SSH response; check for shell startup output and Python 3 availability"))?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(serde_json::from_value(response["error"].clone())
                .unwrap_or_else(|_| SshError::new("ssh_protocol", "Malformed remote error")));
        }
        Ok(response["result"].clone())
    }).await;
    match result {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            Err(SshError::new(
                "timeout",
                "SSH request timed out; reconnect or retry the read",
            ))
        }
    }
}
