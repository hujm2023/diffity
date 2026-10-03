"""Read-only Git/file operations, streamed to Python 3 over SSH (no installation)."""

import base64
import hashlib
import json
import os
import stat
import subprocess
import sys
import shutil
from pathlib import Path
import re

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
MAX_TEXT = 2 * 1024 * 1024
MAX_OUTPUT = 32 * 1024 * 1024
MAX_IMAGE = 16 * 1024 * 1024
MAX_ENTRIES = 200_000


class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def text(data):
    return data.decode("utf-8", "replace")


def git(repo, args, optional=False, ok=(0,)):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    for key in ("GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        env.pop(key, None)
    result = subprocess.run(
        ["git", "--literal-pathspecs", "-c", "core.quotepath=false", "-c", "color.ui=false",
         "-c", "core.fsmonitor=false"] + args,
        cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=30,
    )
    if result.returncode not in ok:
        if optional:
            return None
        raise Failure("git_failed", text(result.stderr).strip() or "Git command failed")
    if len(result.stdout) > MAX_OUTPUT:
        raise Failure("too_large", "Remote Git output exceeds 32 MiB; select a smaller comparison")
    return result.stdout


def verify(repo, ref, optional=False):
    if not isinstance(ref, str) or not ref or ref.startswith("-") or "\0" in ref:
        raise Failure("invalid_ref", "Invalid Git reference")
    value = git(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], optional=True)
    if value is None:
        if optional:
            return None
        raise Failure("invalid_ref", "Git reference does not resolve: " + ref)
    return text(value).strip()


def root_for(value):
    if not isinstance(value, str) or not value or "\0" in value:
        raise Failure("invalid", "Enter an absolute remote path or ~/path")
    expanded = os.path.expanduser(value)
    if not os.path.isabs(expanded):
        raise Failure("invalid", "Remote paths must be absolute or start with ~/")
    if not os.path.isdir(expanded):
        raise Failure("not_found", "Remote directory does not exist: " + expanded)
    result = git(expanded, ["rev-parse", "--show-toplevel"], optional=True)
    if result is None:
        raise Failure("not_a_repo", "Remote directory is not a Git working tree")
    return text(result).rstrip("\n")


def repo_info(repo):
    branch = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], optional=True)
    remote = git(repo, ["remote", "get-url", "origin"], optional=True)
    return {"path": repo, "name": os.path.basename(repo), "isGit": True,
            "branch": text(branch).strip() if branch else None,
            "headSha": verify(repo, "HEAD", optional=True),
            "remoteUrl": text(remote).strip() if remote else None}


def plan(repo, ref):
    ref = ref.strip()
    head = verify(repo, "HEAD", optional=True)
    base = head or EMPTY_TREE
    resolved = {"ref": ref, "label": ref, "canRevert": False, "baseSha": head, "headSha": head}
    if ref in ("work", ".", "staged", "unstaged"):
        resolved["label"] = {"work": "Uncommitted changes", ".": "Uncommitted changes",
                             "staged": "Staged changes", "unstaged": "Unstaged changes"}[ref]
        if ref == "staged":
            return resolved, ["--cached", base], base, "index", False
        if ref == "unstaged":
            return resolved, [], "index", "work", True
        return resolved, [base], base, "work", True
    separator = "..." if "..." in ref else ".." if ".." in ref else None
    if separator:
        left, right = ref.split(separator, 1)
        left, right = left or "HEAD", right or "HEAD"
        right_sha = verify(repo, right)
        left_sha = verify(repo, left, optional=True)
        if left_sha is None:
            child = left[:-2] if left.endswith("~1") else left[:-1] if left.endswith("^") else None
            child_sha = verify(repo, child, optional=True) if child else None
            parents = git(repo, ["rev-list", "--parents", "-n1", right_sha])
            if child_sha != right_sha or len(text(parents).split()) != 1:
                raise Failure("invalid_ref", "Git reference does not resolve: " + left)
            base = EMPTY_TREE
        else:
            merged = git(repo, ["merge-base", left_sha, right_sha], optional=True)
            if merged is None:
                raise Failure("invalid_ref", "References have no common ancestor")
            base = text(merged).strip()
        resolved.update(baseSha=None if base == EMPTY_TREE else base, headSha=right_sha)
        return resolved, [base, right_sha], base, right_sha, False
    sha = verify(repo, ref)
    if not head:
        raise Failure("invalid_ref", "Repository has no commits")
    merged = git(repo, ["merge-base", sha, head], optional=True)
    base = text(merged).strip() if merged else sha
    resolved.update(label="Changes from " + ref, baseSha=base)
    return resolved, [base], base, "work", True


def relative_path(repo, value, follow=True):
    if not isinstance(value, str) or not value or "\0" in value or os.path.isabs(value):
        raise Failure("invalid", "Expected a repository-relative file path")
    parts = value.split("/")
    if ".." in parts or ".git" in parts:
        raise Failure("invalid", "Path escapes the repository or accesses Git metadata")
    joined = os.path.join(repo, value)
    # For symlink diffs, inspect the link itself; file previews may not follow escaping links.
    checked = os.path.realpath(joined if follow else os.path.dirname(joined))
    if os.path.commonpath([os.path.realpath(repo), checked]) != os.path.realpath(repo):
        raise Failure("invalid", "Path escapes the repository")
    return joined


def version(repo, source, path):
    relative_path(repo, path, follow=False)
    if source == EMPTY_TREE:
        return None
    if source != "work":
        spec = (":" if source == "index" else source + ":") + path
        return git(repo, ["show", "--no-textconv", spec], optional=True)
    full = relative_path(repo, path, follow=False)
    try:
        meta = os.lstat(full)
        if stat.S_ISLNK(meta.st_mode):
            return os.readlink(full).encode("utf-8")
        if not stat.S_ISREG(meta.st_mode):
            return None
        if meta.st_size > MAX_TEXT:
            raise Failure("too_large", "Remote text file exceeds 2 MiB")
        with open(full, "rb") as handle:
            data = handle.read(MAX_TEXT + 1)
        if len(data) > MAX_TEXT:
            raise Failure("too_large", "Remote text file exceeds 2 MiB")
        return data
    except FileNotFoundError:
        return None


def untracked(repo):
    return [text(item) for item in git(repo, ["ls-files", "-z", "--others", "--exclude-standard"]).split(b"\0")
            if item and not item.endswith(b"/")]


def diff_args(args, whitespace=False):
    return ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative",
            "--src-prefix=a/", "--dst-prefix=b/", "-M"] + (["-w"] if whitespace else []) + args


def summaries(repo, args):
    records = git(repo, diff_args(["--name-status", "-z"] + args)).split(b"\0")
    files, index = {}, 0
    while index < len(records) and records[index]:
        kind, path = text(records[index]), text(records[index + 1])
        index += 2
        old = None
        if kind[0] in "RC":
            old, path = path, text(records[index])
            index += 1
        files[path] = {"path": path, "oldPath": old,
                       "status": {"A": "added", "D": "deleted", "R": "renamed", "C": "copied"}.get(kind[0], "modified"),
                       "additions": 0, "deletions": 0, "binary": False, "oldLineCount": None,
                       "patchOmitted": False}
    return files


def apply_numstat(files, data):
    records, index = data.split(b"\0"), 0
    while index < len(records) and records[index]:
        additions, deletions, path = records[index].split(b"\t", 2)
        index += 1
        if not path:  # A rename has old and new paths in the next two NUL records.
            path = records[index + 1]
            index += 2
        entry = files.get(text(path))
        if entry is not None:
            entry.update(binary=additions == b"-", additions=0 if additions == b"-" else int(additions),
                         deletions=0 if deletions == b"-" else int(deletions))


def new_patch(repo, path, whitespace=False):
    full = relative_path(repo, path, follow=False)
    if not os.path.lexists(full) or (os.path.isdir(full) and not os.path.islink(full)):
        return b""
    # --no-index does not touch the index or object database. Git supplies quoting and binary handling.
    return git(repo, diff_args(["--no-index", "--", "/dev/null", path], whitespace), ok=(0, 1))


def get_diff(repo, options):
    resolved, args, old, new, include = plan(repo, options.get("ref", "work"))
    whitespace = options.get("ignoreWhitespace", False)
    files = summaries(repo, args)
    apply_numstat(files, git(repo, diff_args(["--numstat", "-z"] + args, whitespace)))
    patches = [git(repo, diff_args(["--patch", "--unified=3"] + args, whitespace))]
    if include:
        for path in untracked(repo):
            patch = new_patch(repo, path, whitespace)
            if not patch:
                continue
            binary = b"Binary files " in patch
            files[path] = {"path": path, "oldPath": None, "status": "untracked", "binary": binary,
                           "additions": 0 if binary else sum(line.startswith(b"+") and not line.startswith(b"+++") for line in patch.splitlines()),
                           "deletions": 0, "oldLineCount": None, "patchOmitted": False}
            patches.append(patch)
    patch = b"".join(patches)
    if len(patch) > MAX_OUTPUT:
        raise Failure("too_large", "Remote diff exceeds 32 MiB; select a smaller comparison")
    for entry in files.values():
        if entry["status"] in ("added", "untracked") or entry["binary"]:
            continue
        contents = version(repo, old, entry["oldPath"] or entry["path"])
        if contents is not None and b"\0" not in contents[:8192]:
            entry["oldLineCount"] = len(contents.splitlines())
    return {"resolved": resolved, "files": list(files.values()), "patch": text(patch),
            "fingerprint": hashlib.sha256(patch).hexdigest(), "hiddenFiles": []}


def status(repo):
    records = git(repo, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).split(b"\0")
    result = {"branch": None, "upstream": None, "ahead": 0, "behind": 0,
              "staged": 0, "unstaged": 0, "untracked": 0, "dirty": False}
    overview, index = [], 0
    while index < len(records):
        record = text(records[index])
        index += 1
        if record.startswith("# branch.head "):
            branch = record[len("# branch.head "):]
            result["branch"] = None if branch == "(detached)" else branch
        elif record.startswith("# branch.upstream "):
            result["upstream"] = record[len("# branch.upstream "):]
        elif record.startswith("# branch.ab "):
            ahead, behind = record[len("# branch.ab "):].split()
            result.update(ahead=int(ahead[1:]), behind=int(behind[1:]))
        elif record.startswith(("1 ", "2 ", "u ")):
            fields = record.split(" ", 9 if record.startswith(("2 ", "u ")) else 8)
            xy, path = fields[1], fields[-1]
            staged, unstaged = xy[0] != ".", xy[1] != "."
            result["staged"] += int(staged)
            result["unstaged"] += int(unstaged or record.startswith("u "))
            overview.append({"path": path, "status": "modified" if unstaged else "staged"})
            if record.startswith("2 "):
                index += 1
        elif record.startswith("? "):
            result["untracked"] += 1
            overview.append({"path": record[2:], "status": "added"})
    result["dirty"] = bool(result["staged"] + result["unstaged"] + result["untracked"])
    return result, overview


def list_tree(repo):
    listed = git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split(b"\0")
    deleted = set(git(repo, ["ls-files", "-z", "--deleted"]).split(b"\0"))
    entries = {}
    for item in listed:
        if not item or item in deleted or item.endswith(b"/"):
            continue
        path = text(item)
        parts = path.split("/")
        for index in range(1, len(parts)):
            entries["/".join(parts[:index])] = "dir"
        entries[path] = "file"
        if len(entries) > MAX_ENTRIES:
            raise Failure("too_large", "Remote file tree exceeds 200,000 entries")
    return [{"path": path, "kind": kind} for path, kind in sorted(entries.items())]


def read_file(repo, path, binary=False):
    full = relative_path(repo, path)
    if not os.path.isfile(full):
        raise Failure("not_found", "Remote file does not exist: " + path)
    limit = MAX_IMAGE if binary else MAX_TEXT
    size = os.path.getsize(full)
    if size > limit:
        raise Failure("too_large", "Remote file exceeds %d MiB" % (limit // 1024 // 1024))
    with open(full, "rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Failure("too_large", "Remote file grew beyond the preview limit")
    if binary:
        return base64.b64encode(data).decode("ascii")
    is_binary = b"\0" in data[:8192]
    return {"path": path, "contents": None if is_binary else text(data), "binary": is_binary, "size": len(data)}


def worktrees(repo):
    result, entry = [], {}
    for field in git(repo, ["worktree", "list", "--porcelain", "-z"]).split(b"\0"):
        if not field:
            if entry:
                result.append(entry)
                entry = {}
            continue
        key, _, value = text(field).partition(" ")
        if key == "worktree":
            entry = {"path": value, "branch": None, "headSha": None, "bare": False, "prunable": False}
        elif key == "branch":
            entry["branch"] = value.removeprefix("refs/heads/") if hasattr(value, "removeprefix") else value.replace("refs/heads/", "", 1)
        elif key == "HEAD":
            entry["headSha"] = value
        elif key in ("bare", "prunable"):
            entry[key] = True
    if entry:
        result.append(entry)
    return result


def list_commits(repo, options):
    if not verify(repo, "HEAD", optional=True):
        return []
    count, skip = max(1, min(int(options.get("count", 50)), 200)), max(0, int(options.get("skip", 0)))
    args = ["log", "-z", "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI", "-n" + str(count), "--skip=" + str(skip)]
    if options.get("search"):
        args += ["--fixed-strings", "--regexp-ignore-case", "--grep=" + options["search"]]
    fields = git(repo, args + ["--"]).split(b"\0")
    result = []
    for index in range(0, len(fields) - 5, 6):
        sha, short, subject, author, email, date = map(text, fields[index:index + 6])
        if sha:
            stats = git(repo, ["diff-tree", "--root", "--no-commit-id", "--numstat", "-z", "-r", sha]).split(b"\0")
            files_changed, additions, deletions = 0, 0, 0
            pos = 0
            while pos < len(stats) and stats[pos]:
                added, removed, path = stats[pos].split(b"\t", 2)
                pos += 1 if path else 3
                files_changed += 1
                additions += 0 if added == b"-" else int(added)
                deletions += 0 if removed == b"-" else int(removed)
            result.append({"sha": sha, "shortSha": short, "subject": subject, "author": author,
                           "authorEmail": email, "date": date, "filesChanged": files_changed, "additions": additions, "deletions": deletions})
    return result


def list_branches(repo):
    output = git(repo, ["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(symref)",
                        "--sort=-committerdate", "refs/heads", "refs/remotes"])
    result = []
    for line in output.splitlines():
        full, short, current, upstream, track, symref = map(text, line.split(b"\0"))
        if symref:
            continue
        ahead, behind = 0, 0
        for item in track.split(", "):
            if item.startswith("ahead "):
                ahead = int(item[6:])
            elif item.startswith("behind "):
                behind = int(item[7:])
        result.append({"name": short, "isRemote": full.startswith("refs/remotes/"), "isCurrent": current == "*",
                       "upstream": upstream or None, "ahead": ahead, "behind": behind})
    return sorted(result, key=lambda entry: (not entry["isCurrent"], entry["isRemote"]))


def agent_binary(name, custom=None):
    if custom:
        candidate = os.path.expanduser(custom)
        return candidate if os.path.isfile(candidate) and os.access(candidate, os.X_OK) else None
    found = shutil.which(name)
    if found:
        return found
    home = Path(os.path.expanduser("~"))
    candidates = [home / ".local/bin", home / ".npm-global/bin", Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    nvm = home / ".nvm/versions/node"
    if nvm.is_dir():
        candidates += sorted((item / "bin" for item in nvm.iterdir()), reverse=True)
    return next((str(folder / name) for folder in candidates if (folder / name).is_file() and os.access(folder / name, os.X_OK)), None)


def detect_agents(options):
    custom = options.get("customPaths") or {}
    node = agent_binary("node")
    results = []
    for name, display in [("claude", "Claude Code"), ("pi", "Pi")]:
        binary = agent_binary(name, custom.get(name))
        info = {"id": name, "name": display, "installed": bool(binary and node), "binaryPath": binary,
                "authenticated": None, "note": None}
        command, args, env = node, [], []
        if not binary:
            info["note"] = "Install %s on this SSH host or set its remote binary path" % display
        elif not node:
            info["note"] = "Node.js was not found on this SSH host"
        elif name == "pi":
            probe_env = dict(os.environ)
            probe_env["PATH"] = os.pathsep.join([str(Path(node).parent), str(Path(binary).parent), probe_env.get("PATH", "")])
            probe = subprocess.run([binary, "--version"], env=probe_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
            match = re.search(rb"(\d+)\.(\d+)\.(\d+)", probe.stdout[:1024])
            if probe.returncode != 0 or not match or tuple(map(int, match.groups())) < (0, 99, 2):
                info.update(installed=False, note="Diffity review needs Pi 0.99.2 or newer with native MCP registration")
        else:
            custom_adapter = custom.get(name) and Path(binary).name.startswith("claude-agent-acp")
            adapter = binary if custom_adapter else agent_binary("claude-agent-acp")
            npx = agent_binary("npx")
            if adapter:
                command = adapter
            elif npx:
                command, args = npx, ["-y", "@agentclientprotocol/claude-agent-acp@0.84.0"]
            else:
                info.update(installed=False, note="Install claude-agent-acp or Node.js/npx on this SSH host")
            env = [("PATH", os.pathsep.join([str(Path(node).parent), str(Path(binary).parent), os.environ.get("PATH", "")]))]
            if not custom_adapter:
                env.append(("CLAUDE_CODE_EXECUTABLE", binary))
        results.append({"info": info, "command": command, "args": args, "env": env})
    return results


OPERATIONS = {"open_repo", "repo_remote_url", "git_status", "repo_overview", "list_worktrees",
              "list_tree", "read_file", "read_file_base64", "resolve_ref", "get_diff", "get_file_patch",
              "get_file_versions", "diff_fingerprint", "list_commits", "list_branches", "detect_agents"}


def handle(request):
    operation = request.get("operation")
    if operation not in OPERATIONS:
        raise Failure("read_only", "SSH repositories support read-only operations only")
    repo = root_for(request.get("repo"))
    options = request.get("args") or {}
    if operation == "detect_agents":
        return detect_agents(options)
    if operation == "open_repo":
        return repo_info(repo)
    if operation == "repo_remote_url":
        return repo_info(repo)["remoteUrl"]
    if operation in ("git_status", "repo_overview"):
        return status(repo)[0 if operation == "git_status" else 1]
    if operation == "list_worktrees":
        return worktrees(repo)
    if operation == "list_tree":
        return list_tree(repo)
    if operation in ("read_file", "read_file_base64"):
        return read_file(repo, options["path"], operation == "read_file_base64")
    if operation == "list_commits":
        return list_commits(repo, options)
    if operation == "list_branches":
        return list_branches(repo)
    resolved, args, old, new, include = plan(repo, options.get("ref", "work"))
    if operation == "resolve_ref":
        return resolved
    if operation == "get_file_versions":
        old_path = options.get("oldPath") or options["path"]
        before, after = version(repo, old, old_path), version(repo, new, options["path"])
        return {"oldContents": None if before is None or b"\0" in before[:8192] else text(before),
                "newContents": None if after is None or b"\0" in after[:8192] else text(after)}
    if operation == "get_file_patch":
        path = options["path"]
        relative_path(repo, path, follow=False)
        if include and path in untracked(repo):
            return text(new_patch(repo, path, options.get("ignoreWhitespace", False)))
        paths = [path]
        if options.get("oldPath"):
            relative_path(repo, options["oldPath"], follow=False)
            paths.append(options["oldPath"])
        return text(git(repo, diff_args(["--patch"] + args + ["--"] + paths, options.get("ignoreWhitespace", False))))
    result = get_diff(repo, options)
    return result["fingerprint"] if operation == "diff_fingerprint" else result


def respond(request):
    try:
        return {"ok": True, "result": handle(request)}
    except Failure as error:
        return {"ok": False, "error": {"code": error.code, "message": error.message}}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": {"code": "timeout", "message": "Remote Git command timed out"}}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {"ok": False, "error": {"code": "remote", "message": str(error)}}


if __name__ == "__main__":
    print(json.dumps(respond(globals().get("request") or json.load(sys.stdin)), ensure_ascii=True))
