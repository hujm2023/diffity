<img src="./.github/logo.png" width="80" />

# diffity

[![Latest release](https://img.shields.io/github/v/release/nilbuild/diffity?display_name=tag&sort=semver&cacheSeconds=3600)](https://github.com/nilbuild/diffity/releases/latest)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/nilbuild/diffity/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Diffity is a Mac app for reviewing code changes, yours or your agent's, GitHub-style, with Claude Code in the loop.

<img src="./.github/screenshots/hero.png" alt="Diffity showing uncommitted changes with a comment thread answered by Claude" />

[![Download for macOS](https://img.shields.io/badge/Download_for_macOS-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/nilbuild/diffity/releases/latest)
[![Report an issue](https://img.shields.io/badge/Report_an_issue-ffffff?style=for-the-badge&logo=github&logoColor=black)](https://github.com/nilbuild/diffity/issues/new/choose)

macOS 13.3 or later, Apple Silicon and Intel. The AI features need [Claude Code](https://docs.claude.com/en/docs/claude-code) (logged in) and Node.js.

| What can you do? | Description |
|---|---|
| [Comment on your diff](#comment-on-your-diff) | Leave comments on lines, files or the whole diff, then send them to Claude to fix |
| [Let Claude fix your comments](#let-claude-fix-your-comments) | Claude works through your comments, edits the code and replies in each thread |
| [Ask @claude](#ask-claude) | Mention @claude in any thread and Claude replies right there |
| [Get a Claude review](#get-a-claude-review) | Claude reads the diff and leaves comments on the lines it cares about |
| [Review over SSH](#review-over-ssh) | Open a remote working tree, switch worktrees and browse changes without cloning locally |
| [Review any commit or range](#review-any-commit-or-range) | Uncommitted changes, a commit, a range or a whole branch |
| [Review pull requests](#review-pull-requests) | Check out a GitHub PR, review it locally, post the review back |
| [Post reviews to GitHub](#post-reviews-to-github) | Submit as Comment, Approve or Request changes, with GitHub threads synced into the diff |
| [Browse and comment on any file](#browse-and-comment-on-any-file) | Comment on code outside the diff from the Files tab |
| [Jump anywhere](#jump-anywhere) | ⌘P for files, ⌘K for commits, comments, PRs and every action |
| [Switch projects](#switch-projects) | Keep your repos in a rail and switch with ⌘1–9 |
| [Open from the terminal or your agent](#open-from-the-terminal-or-your-agent) | `diffity` opens a repo, a diff or a pull request URL in the app |

### Comment on your diff

> Drag across line numbers or click the `+` in the gutter, write a comment, then hit **Send to Claude** to have it fix them.

<img src="./.github/screenshots/comment.gif" alt="Selecting lines in a diff and leaving a comment" />

### Let Claude fix your comments

> Hit **Send N to Claude**; it works through each comment, edits the code and replies in the thread, and you review its changes like any other diff.

<img src="./.github/screenshots/claude-fix.gif" alt="Sending two comments to Claude and its edits and replies landing on the diff" />

### Ask @claude

> Type `@claude` in any comment or reply and Claude answers in the same thread.

<img src="./.github/screenshots/claude-reply.gif" alt="Mentioning @claude in a comment and Claude replying in the thread" />

### Get a Claude review

> Click **Ask Claude to review**, optionally add what to focus on, and its comments land on the diff as it works.

<img src="./.github/screenshots/claude-review.gif" alt="Asking Claude to review and its comments appearing on the diff" />

### Review over SSH

This fork adds read-only SSH review. Build and run this branch from source with the usual Rust/Tauri development prerequisites:

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

Choose **Open via SSH** on the start screen, enter an SSH host alias (or `user@hostname`) and an absolute repository path (or `~/project`). You can also enter `ssh://devbox/home/user/project` in the **⌘O / Ctrl+O** picker.

The app uses your system OpenSSH, SSH config and agent/keys. Establish a working terminal connection first, including accepting the host key and unlocking your key. Custom ports and jump hosts can be configured in `~/.ssh/config`. The remote must be a POSIX host with Git and Python 3 available in its noninteractive shell; no server installation or forwarded port is needed.

The status bar provides a **Remote worktree** selector and **Refresh** button. Worktrees are discovered through `git worktree list --porcelain -z`, so `.worktree/` or `.worktrees/` being ignored by the parent repository does not hide registered worktrees. Each selected worktree has its own status, diff and file tree. Refresh (or **⌘R / Ctrl+R**) reads the latest remote state.

<img src="./.github/screenshots/ssh-remote.png" alt="SSH read-only review of changes in an ignored nested Git worktree" />

SSH review includes staged/unstaged/untracked changes, commit and branch comparisons, text/file previews and images. File browsing and untracked files respect Git's ignore rules. This first version shows all Git changes without applying `.diffityignore`; remote ignore settings, comments, Viewed tracking, Claude and Git mutations are disabled. Local repository features continue to use the existing backend.

Remote text previews are limited to 2 MiB, image reads to 16 MiB, and Git output/diffs to 32 MiB. Reads time out explicitly instead of displaying a failed connection as an empty diff. A comparison reads several Git/file sources and is not an atomic snapshot if another process edits the worktree during the read; refresh once the edits finish.

For development, the remote helper tests use only disposable repositories:

```sh
pnpm typecheck
pnpm exec vitest run tests/remote-repo.test.ts
python3 -B -m unittest discover -s tests -p ssh_helper_test.py -v
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --test ssh_transport
```

The Rust transport test also supports an opt-in SSH fixture via `DIFFITY_SSH_TEST_REPO=ssh://host/path`; use a disposable repository with two worktrees, a modified `tracked.txt` containing `changed`, and an untracked file. Unconfigured runs skip that real-network test. Desktop release builds still use the upstream update feed; fork release signing/update distribution is outside this branch's scope.

### Review any commit or range

> Open the picker next to the project name to switch between uncommitted changes, a commit, a range or a branch.

<img src="./.github/screenshots/refs.gif" alt="Searching commits in the ref picker and opening one" />

### Review pull requests

> Pick a PR from the branch switcher to check it out, comment as you read, then **Submit review** to post it to GitHub.

<img src="./.github/screenshots/pull-request.gif" alt="Checking out a pull request from the branch switcher and opening the review panel" />

### Post reviews to GitHub

> Comment as you read, then **Submit review** as Comment, Approve or Request changes; GitHub comments sync back into the diff so you can reply or resolve from the app.

<img src="./.github/screenshots/post-review.gif" alt="Drafting a review comment on a pull request next to synced GitHub threads and approving it" />

### Browse and comment on any file

> Open the **Files** tab, pick any file in the repo and comment on its lines, even code the diff doesn't touch.

<img src="./.github/screenshots/files.gif" alt="Opening a file from the Files tab and commenting on two of its lines" />

### Jump anywhere

> Press `⌘P` to open any file, or `⌘K` to search commits, comments, PRs and every action.

<img src="./.github/screenshots/palette.gif" alt="Opening a file with ⌘P and switching to dark theme with ⌘K" />

### Switch projects

> Open a repo with `⌘O`; it stays in the left rail, so `⌘1`–`⌘9` takes you back to it.

<img src="./.github/screenshots/projects.gif" alt="Switching between projects in the rail" />

### Open from the terminal or your agent

> Run `diffity` in any repository to open it in the app, or pass a pull request URL to review it.

Install the command once from the app menu: **Diffity → Install ‘diffity’ Command…**. It links the command into `/usr/local/bin` and asks for your password if that folder needs it.

<img src="./.github/screenshots/install-command.png" width="320" alt="The Diffity menu with Install ‘diffity’ Command…" />

```sh
diffity                                        # uncommitted changes in the current repository
diffity ~/code/app                             # another repository
diffity --ref main                             # everything on this branch since it left main
diffity --ref HEAD~1..HEAD                     # the last commit
diffity https://github.com/owner/repo/pull/42  # check out and review a pull request
diffity src/app.ts                             # a file in the Files tab
diffity -n                                     # in a new window
```

`--ref` takes anything the ref picker does: `work`, `staged`, `unstaged`, a branch or commit, `<a>..<b>` or `<a>...<b>`. A pull request opens in the current repository if it is a clone of that repo, else in a clone Diffity already knows; with neither, Diffity offers to clone it. Run `diffity --help` for everything.

Coding agents can run it too, so you can ask Claude Code to “open your changes in Diffity” before it opens a PR.

### More

- **Find in the whole diff.** `⌘F` searches every file in the diff, including collapsed ones, and `⌘G` jumps to the next match.
- **Changed since you viewed it.** Files you marked Viewed get a badge when they change again, and one click shows just what changed.
- **Hide generated files.** Add a `.diffityignore` to your repo (same syntax as `.gitignore`), or a list in Settings, and those files stay out of your diffs:

  ```gitignore
  dist/
  *.generated.ts
  !dist/keep-me.js
  ```
- **Colour-blind friendly colours.** Settings → General → Appearance switches the diff to blue and orange, in light and dark.
- **Split or unified, light or dark.** Toggle the diff layout anytime; the theme follows your Mac unless you pick one in Settings.
- **Updates itself.** New versions install in place, and What's New in the Help menu shows what changed.

Found a bug or have an idea? [Open an issue](https://github.com/nilbuild/diffity/issues/new/choose).

## License

[MIT](./LICENSE) © [Kamran Ahmed](https://x.com/kamrify)
