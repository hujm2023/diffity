use std::path::Path;

use crate::core::{diff, diffignore};
use crate::core::types::{DiffResult, FileVersions, ResolvedRef};
use crate::core::AppError;

use super::repo::blocking;

#[tauri::command]
pub async fn resolve_ref(repo_path: String, r#ref: String) -> Result<ResolvedRef, AppError> {
    blocking(move || diff::resolve_ref(Path::new(&repo_path), &r#ref)).await
}

#[tauri::command]
pub async fn get_diff(
    repo_path: String,
    r#ref: String,
    ignore_whitespace: bool,
    show_ignored: Option<bool>,
) -> Result<DiffResult, AppError> {
    let opts = diff::DiffOptions {
        show_ignored: show_ignored.unwrap_or(false),
        ..diff::DiffOptions::new(ignore_whitespace)
    };
    blocking(move || diff::get_diff_with(Path::new(&repo_path), &r#ref, &opts)).await
}

/// The repo's local "hide from diffs" list (gitignore syntax), kept in the git dir.
#[tauri::command]
pub async fn get_diff_ignore_rules(repo_path: String) -> Result<String, AppError> {
    blocking(move || diffignore::read_local_rules(Path::new(&repo_path))).await
}

#[tauri::command]
pub async fn set_diff_ignore_rules(repo_path: String, rules: String) -> Result<(), AppError> {
    super::ssh::require_local(&repo_path)?;
    blocking(move || diffignore::write_local_rules(Path::new(&repo_path), &rules)).await
}

#[tauri::command]
pub async fn get_file_patch(
    repo_path: String,
    r#ref: String,
    path: String,
    old_path: Option<String>,
    ignore_whitespace: bool,
) -> Result<String, AppError> {
    blocking(move || diff::get_file_patch(Path::new(&repo_path), &r#ref, &path, old_path.as_deref(), ignore_whitespace)).await
}

#[tauri::command]
pub async fn get_file_versions(
    repo_path: String,
    r#ref: String,
    path: String,
    old_path: Option<String>,
) -> Result<FileVersions, AppError> {
    blocking(move || diff::get_file_versions(Path::new(&repo_path), &r#ref, &path, old_path.as_deref())).await
}

#[tauri::command]
pub async fn diff_fingerprint(
    repo_path: String,
    r#ref: String,
    show_ignored: Option<bool>,
) -> Result<String, AppError> {
    blocking(move || diff::diff_fingerprint(Path::new(&repo_path), &r#ref, show_ignored.unwrap_or(false))).await
}

#[tauri::command]
pub async fn revert_file(repo_path: String, path: String) -> Result<(), AppError> {
    super::ssh::require_local(&repo_path)?;
    blocking(move || diff::revert_file(Path::new(&repo_path), &path)).await
}

#[tauri::command]
pub async fn revert_hunk(repo_path: String, patch: String) -> Result<(), AppError> {
    super::ssh::require_local(&repo_path)?;
    blocking(move || diff::revert_hunk(Path::new(&repo_path), &patch)).await
}
