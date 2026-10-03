use std::path::Path;

use crate::core::types::{
    AuthorType, NewThread, RepoThread, Review, ReviewSession, ReviewVerdict, Thread, ThreadStatus, ViewedFile, TREE_REF,
};
use crate::core::{diff, repo_threads};
use crate::core::AppError;
use tauri::{AppHandle, State};

use super::repo::{blocking, emit_threads_changed};
use crate::state::AppState;

#[tauri::command]
pub async fn get_session(
    state: State<'_, AppState>,
    repo_path: String,
    r#ref: String,
) -> Result<ReviewSession, AppError> {
    crate::agents::core_backend::session_for(state.store.clone(), repo_path, r#ref).await
}

#[tauri::command]
pub async fn list_threads(state: State<'_, AppState>, session_id: String) -> Result<Vec<Thread>, AppError> {
    state.store.list_threads(&session_id, None)
}

/// Every thread of the repo across its views (uncommitted, commits, ranges, file browser), with a label for
/// the view and whether the thread is still anchored in that view's current diff.
#[tauri::command]
pub async fn list_repo_threads(state: State<'_, AppState>, repo_path: String) -> Result<Vec<RepoThread>, AppError> {
    let store = state.store.clone();
    if crate::ssh::is_remote(&repo_path) {
        return remote_threads(store, repo_path).await;
    }
    blocking(move || repo_threads::list_repo_threads(&store, &repo_path)).await
}

async fn remote_threads(
    store: std::sync::Arc<crate::core::store::Store>,
    repo: String,
) -> Result<Vec<RepoThread>, AppError> {
    use crate::core::types::{DiffResult, ThreadAnchor};
    use serde_json::json;
    let key = repo.clone();
    let rows = blocking(move || store.list_repo_threads(&key)).await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let scope = crate::agents::core_backend::remote_scope(&repo, "HEAD").await?;
    let tree_paths = if rows.iter().any(|(session, _)| session.r#ref == TREE_REF) {
        Some(
            crate::ssh::request(&repo, "list_tree", serde_json::Value::Null)
                .await?
                .as_array()
                .ok_or_else(|| AppError::internal("Invalid remote file tree"))?
                .iter()
                .filter_map(|entry| entry["path"].as_str().map(String::from))
                .collect::<std::collections::HashSet<_>>(),
        )
    } else {
        None
    };
    let mut views = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (session, thread) in rows {
        let other = !session.scope.is_empty() && session.scope != scope;
        let label = match session.r#ref.as_str() {
            "work" | "." => "Uncommitted changes",
            "staged" => "Staged changes",
            "unstaged" => "Unstaged changes",
            TREE_REF => "Files",
            other => other,
        }
        .to_string();
        let anchor = if other {
            ThreadAnchor::Unknown
        } else if session.r#ref == TREE_REF {
            if thread.file_path == crate::core::types::GENERAL_FILE_PATH
                || thread.file_path == "__path__:__root__"
            {
                ThreadAnchor::Current
            } else {
                let path = thread
                    .file_path
                    .strip_prefix("__path__:")
                    .unwrap_or(&thread.file_path);
                if tree_paths
                    .as_ref()
                    .is_some_and(|paths| paths.contains(path))
                {
                    ThreadAnchor::Current
                } else {
                    ThreadAnchor::FileGone
                }
            }
        } else {
            if !views.contains_key(&session.r#ref) {
                let index = crate::ssh::request(&repo, "get_diff", json!({"ref": session.r#ref}))
                    .await
                    .ok()
                    .and_then(|value| serde_json::from_value::<DiffResult>(value).ok())
                    .map(|diff| repo_threads::ViewIndex::from_diff(&diff));
                views.insert(session.r#ref.clone(), index);
            }
            views
                .get(&session.r#ref)
                .and_then(Option::as_ref)
                .map(|index| index.anchor(&thread))
                .unwrap_or(ThreadAnchor::Unknown)
        };
        let mut item = repo_threads::to_repo_thread(&session, label, thread, anchor, None);
        if other {
            item.other_branch = Some(session.scope);
        }
        out.push(item);
    }
    Ok(out)
}

#[tauri::command]
pub async fn create_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    input: NewThread,
) -> Result<Thread, AppError> {
    let thread = state.store.create_thread(&input)?;
    emit_threads_changed(&app, &thread.session_id);
    Ok(thread)
}

#[tauri::command]
pub async fn add_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    body: String,
    author_type: Option<AuthorType>,
    author_name: Option<String>,
    pending: Option<bool>,
) -> Result<Thread, AppError> {
    let thread = state.store.add_reply_with(
        &thread_id,
        &body,
        author_type.unwrap_or(AuthorType::User),
        author_name.as_deref(),
        pending.unwrap_or(false),
    )?;
    emit_threads_changed(&app, &thread.session_id);
    Ok(thread)
}

#[tauri::command]
pub async fn edit_comment(
    app: AppHandle,
    state: State<'_, AppState>,
    comment_id: String,
    body: String,
) -> Result<(), AppError> {
    let session_id = state.store.edit_comment(&comment_id, &body)?;
    emit_threads_changed(&app, &session_id);
    Ok(())
}

#[tauri::command]
pub async fn delete_comment(app: AppHandle, state: State<'_, AppState>, comment_id: String) -> Result<(), AppError> {
    let session_id = state.store.delete_comment(&comment_id)?;
    emit_threads_changed(&app, &session_id);
    Ok(())
}

#[tauri::command]
pub async fn delete_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), AppError> {
    let session_id = state.store.delete_thread(&thread_id)?;
    emit_threads_changed(&app, &session_id);
    Ok(())
}

#[tauri::command]
pub async fn delete_all_threads(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    state.store.delete_all_threads(&session_id)?;
    emit_threads_changed(&app, &session_id);
    Ok(())
}

#[tauri::command]
pub async fn set_thread_status(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    status: ThreadStatus,
    summary: Option<String>,
) -> Result<Thread, AppError> {
    let thread = state.store.set_thread_status(&thread_id, status, summary.as_deref())?;
    emit_threads_changed(&app, &thread.session_id);
    Ok(thread)
}

#[tauri::command]
pub async fn list_viewed(state: State<'_, AppState>, session_id: String) -> Result<Vec<ViewedFile>, AppError> {
    state.store.list_viewed(&session_id)
}

#[tauri::command]
pub async fn set_viewed(
    state: State<'_, AppState>,
    session_id: String,
    file_path: String,
    content_hash: String,
    viewed: bool,
) -> Result<(), AppError> {
    if !viewed {
        return state.store.set_viewed(&session_id, &file_path, &content_hash, None, false);
    }
    let session = state.store.get_session_by_id(&session_id)?;
    let path = file_path.clone();
    let blob = blocking(move || {
        if session.r#ref == TREE_REF || crate::ssh::is_remote(&session.repo_path) {
            return Ok(None);
        }
        Ok(diff::snapshot_blob(Path::new(&session.repo_path), &session.r#ref, &path).unwrap_or(None))
    })
    .await?;
    state.store.set_viewed(&session_id, &file_path, &content_hash, blob.as_deref(), true)
}

/// Patch from the version of `file_path` last marked viewed to its current contents (empty when unchanged).
#[tauri::command]
pub async fn viewed_changes(state: State<'_, AppState>, session_id: String, file_path: String) -> Result<String, AppError> {
    let session = state.store.get_session_by_id(&session_id)?;
    let blob = state
        .store
        .get_viewed(&session_id, &file_path)?
        .and_then(|v| v.blob_id)
        .ok_or_else(|| AppError::not_found("no viewed snapshot for this file"))?;
    blocking(move || diff::changes_since_blob(Path::new(&session.repo_path), &session.r#ref, &file_path, &blob)).await
}

#[tauri::command]
pub async fn get_pending_review(state: State<'_, AppState>, session_id: String) -> Result<Option<Review>, AppError> {
    state.store.get_pending_review(&session_id)
}

#[tauri::command]
pub async fn start_review(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<Review, AppError> {
    let review = state.store.start_review(&session_id)?;
    emit_threads_changed(&app, &session_id);
    Ok(review)
}

#[tauri::command]
pub async fn get_review(state: State<'_, AppState>, review_id: String) -> Result<Review, AppError> {
    state.store.get_review(&review_id)
}

#[tauri::command]
pub async fn list_reviews(state: State<'_, AppState>, session_id: String) -> Result<Vec<Review>, AppError> {
    state.store.list_reviews(&session_id)
}

#[tauri::command]
pub async fn submit_review(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    body: Option<String>,
    verdict: Option<ReviewVerdict>,
) -> Result<Review, AppError> {
    let review = state.store.submit_review(
        &session_id,
        body.as_deref().unwrap_or(""),
        verdict,
    )?;
    emit_threads_changed(&app, &session_id);
    Ok(review)
}

#[tauri::command]
pub async fn discard_review(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    if state.store.discard_review(&session_id)? {
        emit_threads_changed(&app, &session_id);
    }
    Ok(())
}
