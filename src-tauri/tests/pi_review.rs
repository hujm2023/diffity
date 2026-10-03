//! Opt-in real Pi / real SSH / real MCP integration, driven by scripts/test-pi-review.py.
use diffity_desktop_lib::agents::{AgentAction, AgentManager, AgentMode, RunModel, StartChat};
use diffity_desktop_lib::core::store::Store;
use diffity_desktop_lib::core::types::AuthorType;

#[tokio::test]
async fn remote_acp_comments_do_not_delegate_to_desktop_files() {
    let (Ok(repo), Ok(binary)) = (
        std::env::var("DIFFITY_AGENT_TEST_REPO"),
        std::env::var("DIFFITY_AGENT_TEST_CLAUDE_BINARY"),
    ) else {
        return;
    };
    if !diffity_desktop_lib::ssh::is_remote(&repo) {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(temp.path().join("review.db")).unwrap());
    let host = diffity_desktop_lib::ssh::Target::parse(&repo).unwrap().host;
    store
        .set_setting(&format!("agent.claude.path@{host}"), &binary)
        .unwrap();
    let manager = AgentManager::new(
        store.clone(),
        temp.path().to_path_buf(),
        env!("CARGO_BIN_EXE_diffity-mcp").into(),
    );
    let session = store.get_or_create_session(&repo, "work").unwrap();
    let chat = manager
        .start_chat(StartChat {
            repo_path: repo,
            agent_id: "claude".into(),
            mode: AgentMode::Review,
            session_id: session.id.clone(),
            title: None,
        })
        .await
        .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        manager.send_prompt(
            &chat.id,
            "Review this fixture".into(),
            vec![],
            AgentAction::Review {
                r#ref: "work".into(),
                focus: None,
                instructions: None,
                paths: vec![],
            },
            RunModel::default(),
            Box::new(|_| {}),
        ),
    )
    .await
    .unwrap();
    manager.delete_chat(&chat.id).await.unwrap();
    result.unwrap();
    let threads = store.list_threads(&session.id, None).unwrap();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].comments[0].author_name, "Claude Code");
    assert_eq!(
        threads[0].comments[0].body,
        "Fixture finding from remote Claude"
    );
}
use std::sync::Arc;

#[tokio::test]
async fn pi_leaves_scoped_comments_in_an_ssh_worktree() {
    let Ok(repo) = std::env::var("DIFFITY_AGENT_TEST_REPO") else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(temp.path().join("review.db")).unwrap());
    if let Ok(binary) = std::env::var("DIFFITY_AGENT_TEST_PI_BINARY") {
        let key = if let Ok(target) = diffity_desktop_lib::ssh::Target::parse(&repo) {
            format!("agent.pi.path@{}", target.host)
        } else {
            "agent.pi.path".into()
        };
        store.set_setting(&key, &binary).unwrap();
    }
    store
        .set_setting("agent.claude.path", "/missing-fixture-claude")
        .unwrap();
    let manager = AgentManager::new(
        store.clone(),
        temp.path().to_path_buf(),
        env!("CARGO_BIN_EXE_diffity-mcp").into(),
    );
    let session = store.get_or_create_session(&repo, "work").unwrap();
    let agents = manager.list_agents_for(Some(&repo), true).await.unwrap();
    assert!(agents
        .iter()
        .any(|agent| agent.id == "pi" && agent.installed));
    assert!(manager
        .start_chat(StartChat {
            repo_path: repo.clone(),
            agent_id: "pi".into(),
            mode: AgentMode::Edit,
            session_id: session.id.clone(),
            title: None
        })
        .await
        .is_err());
    let chat = manager
        .start_chat(StartChat {
            repo_path: repo.clone(),
            agent_id: "pi".into(),
            mode: AgentMode::Review,
            session_id: session.id.clone(),
            title: None,
        })
        .await
        .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        manager.send_prompt(
            &chat.id,
            "Review tracked.txt and leave the requested fixture comment.".into(),
            vec![],
            AgentAction::Review {
                r#ref: "work".into(),
                focus: None,
                instructions: None,
                paths: vec![],
            },
            RunModel::default(),
            Box::new(|_| {}),
        ),
    )
    .await
    .expect("Pi review timed out");
    manager.delete_chat(&chat.id).await.unwrap();
    result.unwrap();
    let threads = store.list_threads(&session.id, None).unwrap();
    assert_eq!(threads.len(), 1, "Pi did not create one review comment");
    assert_eq!(threads[0].file_path, "tracked.txt");
    assert_eq!(threads[0].comments[0].author_type, AuthorType::Agent);
    assert_eq!(threads[0].comments[0].author_name, "Pi");
    assert_eq!(
        threads[0].comments[0].body,
        "Fixture finding from remote Pi"
    );
    let reply_chat = manager
        .start_chat(StartChat {
            repo_path: repo,
            agent_id: "pi".into(),
            mode: AgentMode::Review,
            session_id: session.id.clone(),
            title: None,
        })
        .await
        .unwrap();
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        manager.send_prompt(
            &reply_chat.id,
            "Reply to this fixture thread without modifying code".into(),
            vec![],
            AgentAction::Thread {
                thread_id: threads[0].id.clone(),
            },
            RunModel::default(),
            Box::new(|_| {}),
        ),
    )
    .await
    .unwrap();
    manager.delete_chat(&reply_chat.id).await.unwrap();
    reply.unwrap();
    let updated = store.get_thread(&threads[0].id).unwrap();
    assert_eq!(updated.comments.len(), 2);
    assert_eq!(updated.comments[1].author_name, "Pi");
    assert_eq!(updated.comments[1].body, "Fixture reply from read-only Pi");
}
