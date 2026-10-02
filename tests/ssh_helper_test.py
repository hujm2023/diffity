"""Integration tests against disposable Git repositories; never touch a real SSH project."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / "src-tauri/src/ssh_helper.py"
spec = importlib.util.spec_from_file_location("ssh_helper", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SshHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="diffity-ssh-test-")
        self.repo = Path(self.temp.name) / "repo 中文 '$(noop)"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        (self.repo / ".gitignore").write_text(".worktrees/\nignored.txt\n")
        (self.repo / "tracked.txt").write_text("first\nsecond\n")
        (self.repo / "renamed old.txt").write_text("rename me\n")
        self.git("add", ".")
        self.git("commit", "-m", "Initial fixture")
        self.worktree = self.repo / ".worktrees" / "task-a"
        self.git("worktree", "add", "-b", "task-a", str(self.worktree))

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, repo=None):
        return subprocess.check_output(["git", "-C", str(repo or self.repo), *args], stderr=subprocess.DEVNULL)

    def read(self, operation, repo=None, **args):
        response = helper.respond({"operation": operation, "repo": str(repo or self.repo), "args": args})
        self.assertTrue(response["ok"], response)
        return response["result"]

    def test_ignored_worktree_is_discovered_and_has_its_own_changes(self):
        (self.worktree / "tracked.txt").write_text("worktree changed\n")
        (self.worktree / "new 中文.txt").write_text("new worktree file\n")
        (self.worktree / "ignored.txt").write_text("ignored\n")
        entries = self.read("list_worktrees")
        self.assertEqual({entry["path"] for entry in entries}, {str(self.repo), str(self.worktree)})
        self.assertFalse(self.read("git_status")["dirty"])
        result = self.read("get_diff", repo=self.worktree, ref="work")
        self.assertEqual({entry["path"] for entry in result["files"]}, {"tracked.txt", "new 中文.txt"})
        self.assertIn("worktree changed", result["patch"])
        self.assertFalse(result["resolved"]["canRevert"])
        paths = {entry["path"] for entry in self.read("list_tree", repo=self.worktree)}
        self.assertNotIn("ignored.txt", paths)
        self.assertIn("new 中文.txt", paths)

    def test_staged_unstaged_renamed_and_untracked_changes(self):
        (self.repo / "tracked.txt").write_text("staged\n")
        self.git("add", "tracked.txt")
        (self.repo / "tracked.txt").write_text("unstaged\n")
        self.git("mv", "renamed old.txt", "renamed 新.txt")
        (self.repo / "new '$(noop).txt").write_text("new\n")
        status = self.read("git_status")
        self.assertEqual((status["staged"], status["unstaged"], status["untracked"]), (2, 1, 1))
        staged = self.read("get_diff", ref="staged")
        self.assertIn("+staged", staged["patch"])
        self.assertNotIn("+unstaged", staged["patch"])
        rename = next(entry for entry in staged["files"] if entry["status"] == "renamed")
        self.assertEqual(rename["oldPath"], "renamed old.txt")
        unstaged = self.read("get_diff", ref="unstaged")
        self.assertIn("-staged", unstaged["patch"])
        self.assertIn("+unstaged", unstaged["patch"])
        versions = self.read("get_file_versions", ref="staged", path="tracked.txt")
        self.assertEqual(versions, {"oldContents": "first\nsecond\n", "newContents": "staged\n"})
        before = self.read("diff_fingerprint", ref="work")
        (self.repo / "tracked.txt").write_text("changed again\n")
        self.assertNotEqual(before, self.read("diff_fingerprint", ref="work"))

    def test_reads_do_not_change_git_metadata(self):
        (self.repo / "tracked.txt").write_text("changed\n")
        metadata = self.repo / ".git"
        def snapshot():
            return {str(path.relative_to(metadata)): (path.read_bytes(), path.stat().st_mtime_ns)
                    for path in metadata.rglob("*") if path.is_file()}
        before = snapshot()
        for operation in ["open_repo", "git_status", "repo_overview", "get_diff", "list_tree", "list_worktrees", "list_commits", "list_branches", "diff_fingerprint"]:
            self.read(operation)
        self.assertEqual(before, snapshot())

    def test_binary_deleted_files_root_commit_and_empty_repository(self):
        (self.repo / "binary.bin").write_bytes(b"\0binary")
        (self.repo / "tracked.txt").unlink()
        files = self.read("get_diff")["files"]
        self.assertTrue(next(entry for entry in files if entry["path"] == "binary.bin")["binary"])
        self.assertEqual(next(entry for entry in files if entry["path"] == "tracked.txt")["status"], "deleted")
        root = self.git("rev-parse", "HEAD").decode().strip()
        self.assertEqual(len(self.read("get_diff", ref=root + "~1.." + root)["files"]), 3)
        empty = Path(self.temp.name) / "empty"
        empty.mkdir()
        self.git("init", repo=empty)
        (empty / "new.txt").write_text("new\n")
        self.assertEqual(self.read("get_diff", repo=empty)["files"][0]["status"], "untracked")

    def test_rejects_mutations_traversal_and_escaping_symlinks(self):
        secret = Path(self.temp.name) / "outside.txt"
        secret.write_text("not inside repo\n")
        (self.repo / "escape").symlink_to(secret)
        for operation, args in [("git_push", {}), ("read_file", {"path": "../outside.txt"}), ("read_file", {"path": "escape"}), ("get_file_versions", {"path": "../outside.txt"}), ("read_file", {"path": ".git/config"})]:
            response = helper.respond({"operation": operation, "repo": str(self.repo), "args": args})
            self.assertFalse(response["ok"], response)
        response = helper.respond({"operation": "get_diff", "repo": str(self.repo), "args": {"ref": "--help"}})
        self.assertEqual(response["error"]["code"], "invalid_ref")

    def test_standalone_protocol_and_commit_list(self):
        request = {"operation": "open_repo", "repo": str(self.repo), "args": {}}
        result = subprocess.run(["python3", "-B", str(HELPER)], input=json.dumps(request).encode(), stdout=subprocess.PIPE, check=True)
        self.assertTrue(json.loads(result.stdout)["ok"])
        commits = self.read("list_commits")
        self.assertEqual(commits[0]["subject"], "Initial fixture")
        self.assertEqual(self.read("list_branches")[0]["name"], "main")


if __name__ == "__main__":
    unittest.main()
