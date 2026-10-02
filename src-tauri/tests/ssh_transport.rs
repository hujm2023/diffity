// This transport can be tested without a GUI/GTK or the app feature.
#[path = "../src/ssh.rs"]
mod ssh;

#[test]
fn remote_targets_keep_host_and_path_separate() {
    let target =
        ssh::Target::parse("ssh://user@devbox/home/me/%E9%A1%B9%E7%9B%AE%20%27%24%28cmd%29%25")
            .unwrap();
    assert_eq!(target.host, "user@devbox");
    assert_eq!(target.path, "/home/me/项目 '$(cmd)%");
    assert_eq!(ssh::Target::parse(&target.locator()).unwrap(), target);
    assert_eq!(
        ssh::Target::parse("ssh://devbox/~/repo").unwrap().path,
        "~/repo"
    );
    for value in [
        "ssh://-oProxyCommand=bad/repo",
        "ssh://host;bad/repo",
        "ssh://dev/%00",
        "ssh://dev/%QX",
        "/local/repo",
    ] {
        assert!(ssh::Target::parse(value).is_err());
    }
    assert!(ssh::is_remote("ssh://dev/repo"));
}

#[tokio::test]
async fn mutation_is_rejected_before_starting_ssh() {
    let error = ssh::request("ssh://unused/repo", "git_push", serde_json::Value::Null)
        .await
        .unwrap_err();
    assert_eq!(error.code, "read_only");
}

// Opt-in real transport test; the SSH target is an isolated fixture, never a user's repository.
#[tokio::test]
async fn transport_reads_fixture_when_configured() {
    let Ok(locator) = std::env::var("DIFFITY_SSH_TEST_REPO") else {
        return;
    };
    let info = ssh::request(&locator, "open_repo", serde_json::Value::Null)
        .await
        .unwrap();
    assert_eq!(info["isGit"], true);
    let diff = ssh::request(&locator, "get_diff", serde_json::json!({"ref":"work"}))
        .await
        .unwrap();
    assert!(diff["files"].as_array().unwrap().len() >= 2);
    let worktrees = ssh::request(&locator, "list_worktrees", serde_json::Value::Null)
        .await
        .unwrap();
    assert!(worktrees.as_array().unwrap().len() >= 2);
    let file = ssh::request(
        &locator,
        "read_file",
        serde_json::json!({"path":"tracked.txt"}),
    )
    .await
    .unwrap();
    assert!(file["contents"].as_str().unwrap().contains("changed"));
}
