use crate::core::{types::RepoInfo, AppError};
use crate::ssh::{self, Target};
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

impl From<ssh::SshError> for AppError {
    fn from(error: ssh::SshError) -> Self {
        Self::new(error.code, error.message)
    }
}

pub fn require_local(path: &str) -> Result<(), AppError> {
    if ssh::is_remote(path) {
        return Err(AppError::new(
            "read_only",
            "SSH repositories are read-only; use a terminal for Git writes or agent operations",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_request(
    repo_path: String,
    operation: String,
    args: Value,
) -> Result<Value, AppError> {
    Ok(ssh::request(&repo_path, &operation, args).await?)
}

#[tauri::command]
pub async fn open_ssh_repo(state: State<'_, AppState>, path: String) -> Result<RepoInfo, AppError> {
    let mut target = Target::parse(&path)?;
    let mut info: RepoInfo =
        serde_json::from_value(ssh::request(&path, "open_repo", Value::Null).await?)?;
    target.path = info.path;
    info.path = target.locator();
    info.name = format!("{} · {}", info.name, target.host);
    state.store.touch_repo(&info.path, &info.name)?;
    Ok(info)
}
