//! Bundled, dependency-free protocol adapters. Provider configuration stays beside the agent CLI.
use crate::agents::detect::{AgentKind, LaunchSpec};
use crate::core::{AppError, Result};
use serde_json::json;
use std::path::{Path, PathBuf};

const FILES: &[(&str, &str)] = &[
    ("pi-acp.mjs", include_str!("support/pi-acp.mjs")),
    ("pi-extension.mjs", include_str!("support/pi-extension.mjs")),
    ("remote-agent.mjs", include_str!("support/remote-agent.mjs")),
    ("remote-agent.py", include_str!("support/remote-agent.py")),
    ("agent-mcp.py", include_str!("support/agent-mcp.py")),
];

pub fn prepare(directory: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    for (name, source) in FILES {
        let target = directory.join(name);
        if std::fs::read(&target).ok().as_deref() == Some(source.as_bytes()) {
            continue;
        }
        let temporary = directory.join(format!(".{name}-{}", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, source)?;
        std::fs::rename(temporary, target)?;
    }
    Ok(directory.to_path_buf())
}

pub fn local_pi(directory: &Path, binary: &Path) -> Result<LaunchSpec> {
    let node = crate::agents::detect::find_in_path("node").ok_or_else(|| {
        AppError::new(
            "agent_not_installed",
            "Pi review needs Node.js on the desktop",
        )
    })?;
    Ok(LaunchSpec {
        command: node,
        args: vec![directory.join("pi-acp.mjs").to_string_lossy().into_owned()],
        env: vec![(
            "DIFFITY_PI_BINARY".into(),
            binary.to_string_lossy().into_owned(),
        )],
    })
}

pub fn remote(
    directory: &Path,
    repo: &str,
    kind: AgentKind,
    launch: LaunchSpec,
    binary: &Path,
    mcp: &Path,
) -> Result<LaunchSpec> {
    let target = crate::ssh::Target::parse(repo)?;
    let node = crate::agents::detect::find_in_path("node").ok_or_else(|| {
        AppError::new(
            "agent_not_installed",
            "SSH agents need Node.js on the desktop for protocol transport",
        )
    })?;
    let config = json!({ "host": target.host, "cwd": target.path,
        "launch": { "command": launch.command, "args": launch.args, "env": launch.env },
        "piBinary": if kind == AgentKind::Pi { Some(binary) } else { None }, "mcpCommand": mcp });
    Ok(LaunchSpec {
        command: node,
        args: vec![directory
            .join("remote-agent.mjs")
            .to_string_lossy()
            .into_owned()],
        env: vec![("DIFFITY_REMOTE_AGENT".into(), config.to_string())],
    })
}

pub async fn detect_remote(
    repo: &str,
    custom_paths: &std::collections::HashMap<String, String>,
) -> Result<Vec<crate::agents::detect::DetectedAgent>> {
    let result = crate::ssh::request(
        repo,
        "detect_agents",
        json!({ "customPaths": custom_paths }),
    )
    .await?;
    let records = result
        .as_array()
        .ok_or_else(|| AppError::internal("Malformed remote agent detection"))?;
    let mut agents = Vec::new();
    for record in records {
        let info: crate::agents::types::AgentInfo = serde_json::from_value(record["info"].clone())?;
        let Some(kind) = AgentKind::from_id(&info.id).filter(|kind| kind.is_enabled()) else {
            continue;
        };
        let launch = if info.installed {
            Some(LaunchSpec {
                command: PathBuf::from(
                    record["command"]
                        .as_str()
                        .ok_or_else(|| AppError::internal("Missing remote command"))?,
                ),
                args: serde_json::from_value(record["args"].clone())?,
                env: serde_json::from_value(record["env"].clone())?,
            })
        } else {
            None
        };
        agents.push(crate::agents::detect::DetectedAgent { kind, info, launch });
    }
    Ok(agents)
}
