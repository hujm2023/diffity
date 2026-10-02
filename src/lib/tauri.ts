import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isRemoteRepo, parseRemoteRepo, remoteRepoPath, readOnlyError, type RemoteWorktree } from './remote-repo';
import type {
  AgentAction,
  AgentEvent,
  AgentInfo,
  AppError,
  AuthorType,
  Branch,
  Chat,
  ChatMessage,
  Commit,
  ContextChip,
  ModelCatalog,
  ProjectData,
  RunModel,
  DeviceCode,
  DiffResult,
  FileContent,
  FileVersions,
  GitOpResult,
  GitStatus,
  GithubAuthStatus,
  NewThread,
  OpenRequest,
  OverviewFile,
  PullRequest,
  PullResult,
  PushResult,
  ReviewCandidates,
  GithubPendingAction,
  RecentRepo,
  RepoChangedPayload,
  RepoInfo,
  RepoThread,
  ResolvedRef,
  Review,
  ReviewEvent,
  ReviewSession,
  StashResult,
  ReviewVerdict,
  StartChat,
  Thread,
  ThreadStatus,
  ThreadsChangedPayload,
  TreeEntry,
  ViewedFile,
} from './types';

export type CommitRecord = Commit;

export function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

export function errorMessage(error: unknown): string {
  if (isAppError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// repo
function repoRead<T>(operation: string, repoPath: string, args: Record<string, unknown> = {}): Promise<T> {
  return isRemoteRepo(repoPath)
    ? invoke<T>('ssh_request', { repoPath, operation, args })
    : invoke<T>(operation, { repoPath, ...args });
}

function localOperation<T>(operation: string, repoPath: string, args: Record<string, unknown> = {}): Promise<T> {
  return isRemoteRepo(repoPath) ? Promise.reject(readOnlyError()) : invoke<T>(operation, { repoPath, ...args });
}

export const openRepo = (path: string) => invoke<RepoInfo>(isRemoteRepo(path) ? 'open_ssh_repo' : 'open_repo', { path });
export const repoRemoteUrl = (path: string) => isRemoteRepo(path)
  ? repoRead<string | null>('repo_remote_url', path) : invoke<string | null>('repo_remote_url', { path });
export async function listWorktrees(repoPath: string): Promise<RemoteWorktree[]> {
  const target = parseRemoteRepo(repoPath);
  if (!target) return [];
  const entries = await repoRead<RemoteWorktree[]>('list_worktrees', repoPath);
  return entries.map((entry) => ({ ...entry, path: remoteRepoPath(target.host, entry.path) }));
}
export const recentRepos = () => invoke<RecentRepo[]>('recent_repos');
export const watchRepo = (repoPath: string) => isRemoteRepo(repoPath) ? Promise.resolve() : invoke<void>('watch_repo', { repoPath });
export const unwatchRepo = (repoPath: string) => isRemoteRepo(repoPath) ? Promise.resolve() : invoke<void>('unwatch_repo', { repoPath });
export const listCommits = (repoPath: string, count: number, skip: number, search?: string | null) =>
  repoRead<Commit[]>('list_commits', repoPath, { count, skip, search: search ?? null });
export const listBranches = (repoPath: string) => repoRead<Branch[]>('list_branches', repoPath);
export const gitStatus = (repoPath: string) => repoRead<GitStatus>('git_status', repoPath);
export const repoOverview = (repoPath: string) => repoRead<OverviewFile[]>('repo_overview', repoPath);
export const openInEditor = (repoPath: string, path: string, line?: number | null, editor?: string | null) =>
  localOperation<void>('open_in_editor', repoPath, { path, line: line ?? null, editor: editor ?? null });
export const reportIssue = () => invoke<void>('report_issue');
export const takeOpenRequests = () => invoke<OpenRequest[]>('take_open_requests');
export const projectData = () => invoke<ProjectData[]>('project_data');
export const clearProjectData = (repoPath: string) => invoke<void>('clear_project_data', { repoPath });
export const resetAllData = () => invoke<void>('reset_all_data');
export const getSetting = (key: string) => invoke<string | null>('get_setting', { key });
export const setSetting = (key: string, value: string) => invoke<void>('set_setting', { key, value });

// diff
export const resolveRef = (repoPath: string, ref: string) => repoRead<ResolvedRef>('resolve_ref', repoPath, { ref });
export const getDiff = (repoPath: string, ref: string, ignoreWhitespace: boolean, showIgnored = false) =>
  repoRead<DiffResult>('get_diff', repoPath, { ref, ignoreWhitespace, showIgnored });
export const getDiffIgnoreRules = (repoPath: string) => isRemoteRepo(repoPath) ? Promise.resolve('') : invoke<string>('get_diff_ignore_rules', { repoPath });
export const setDiffIgnoreRules = (repoPath: string, rules: string) => localOperation<void>('set_diff_ignore_rules', repoPath, { rules });
export const getFilePatch = (repoPath: string, ref: string, path: string, oldPath: string | null, ignoreWhitespace: boolean) =>
  repoRead<string>('get_file_patch', repoPath, { ref, path, oldPath, ignoreWhitespace });
export const getFileVersions = (repoPath: string, ref: string, path: string, oldPath?: string | null) =>
  repoRead<FileVersions>('get_file_versions', repoPath, { ref, path, oldPath: oldPath ?? null });
export const diffFingerprint = (repoPath: string, ref: string, showIgnored = false) =>
  repoRead<string>('diff_fingerprint', repoPath, { ref, showIgnored });
export const revertFile = (repoPath: string, path: string) => localOperation<void>('revert_file', repoPath, { path });
export const revertHunk = (repoPath: string, patch: string) => localOperation<void>('revert_hunk', repoPath, { patch });

// files
export const listTree = (repoPath: string) => repoRead<TreeEntry[]>('list_tree', repoPath);
export const readFile = (repoPath: string, path: string) => repoRead<FileContent>('read_file', repoPath, { path });
export const readFileBase64 = (repoPath: string, path: string) =>
  repoRead<string>('read_file_base64', repoPath, { path });

// comments
export const getSession = (repoPath: string, ref: string) => invoke<ReviewSession>('get_session', { repoPath, ref });
export const listThreads = (sessionId: string) => invoke<Thread[]>('list_threads', { sessionId });
export const listRepoThreads = (repoPath: string) => isRemoteRepo(repoPath) ? Promise.resolve([] as RepoThread[]) : invoke<RepoThread[]>('list_repo_threads', { repoPath });
export const createThread = (input: NewThread) => invoke<Thread>('create_thread', { input });
export const addReply = (
  threadId: string,
  body: string,
  authorType?: AuthorType | null,
  authorName?: string | null,
  pending?: boolean,
) =>
  invoke<Thread>('add_reply', {
    threadId,
    body,
    authorType: authorType ?? null,
    authorName: authorName ?? null,
    pending: pending ?? null,
  });
export const editComment = (commentId: string, body: string) => invoke<void>('edit_comment', { commentId, body });
export const deleteComment = (commentId: string) => invoke<void>('delete_comment', { commentId });
export const deleteThread = (threadId: string) => invoke<void>('delete_thread', { threadId });
export const deleteAllThreads = (sessionId: string) => invoke<void>('delete_all_threads', { sessionId });
export const setThreadStatus = (threadId: string, status: ThreadStatus, summary?: string | null) =>
  invoke<Thread>('set_thread_status', { threadId, status, summary: summary ?? null });
export const getPendingReview = (sessionId: string) => invoke<Review | null>('get_pending_review', { sessionId });
export const startReview = (sessionId: string) => invoke<Review>('start_review', { sessionId });
export const getReview = (reviewId: string) => invoke<Review>('get_review', { reviewId });
export const listReviews = (sessionId: string) => invoke<Review[]>('list_reviews', { sessionId });
/** Publishes all pending comments. Use the returned `mentionedThreadIds` / `threadIds` to trigger the agent. */
export const submitReview = (sessionId: string, body?: string | null, verdict?: ReviewVerdict | null) =>
  invoke<Review>('submit_review', { sessionId, body: body ?? null, verdict: verdict ?? null });
export const discardReview = (sessionId: string) => invoke<void>('discard_review', { sessionId });
export const listViewed = (sessionId: string) => invoke<ViewedFile[]>('list_viewed', { sessionId });
export const setViewed = (sessionId: string, filePath: string, contentHash: string, viewed: boolean) =>
  invoke<void>('set_viewed', { sessionId, filePath, contentHash, viewed });
export const viewedChanges = (sessionId: string, filePath: string) => invoke<string>('viewed_changes', { sessionId, filePath });

// agents
export const listAgents = (refresh?: boolean) => invoke<AgentInfo[]>('list_agents', { refresh: refresh ?? null });
export const agentModels = (refresh = false) => invoke<ModelCatalog | null>('agent_models', { refresh });
export const startChat = (input: StartChat) => isRemoteRepo(input.repoPath) ? Promise.reject(readOnlyError()) : invoke<Chat>('start_chat', { input });
export const listChats = (repoPath: string, ref?: string) => invoke<Chat[]>('list_chats', { repoPath, ref: ref ?? null });
export const getChatMessages = (chatId: string) => invoke<ChatMessage[]>('get_chat_messages', { chatId });
export function sendPrompt(
  chatId: string,
  text: string,
  context: ContextChip[],
  action: AgentAction,
  model: RunModel,
  onEvent: (event: AgentEvent) => void,
) {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<void>('send_prompt', { chatId, text, context, action, model, onEvent: channel });
}
export const cancelPrompt = (chatId: string) => invoke<void>('cancel_prompt', { chatId });
export const respondPermission = (requestId: string, optionId: string | null, forRun = false) =>
  invoke<void>('respond_permission', { requestId, optionId, forRun });
export const deleteChat = (chatId: string) => invoke<void>('delete_chat', { chatId });

// github
export const githubAuthStatus = () => invoke<GithubAuthStatus>('github_auth_status');
export const githubImportGhToken = () => invoke<GithubAuthStatus>('github_import_gh_token');
export const githubSetToken = (token: string) => invoke<GithubAuthStatus>('github_set_token', { token });
export const githubDeviceStart = () => invoke<DeviceCode>('github_device_start');
export const githubDevicePoll = (deviceCode: string) =>
  invoke<GithubAuthStatus>('github_device_poll', { deviceCode });
export const githubLogout = () => invoke<void>('github_logout');
export const gitFetch = (repoPath: string) => localOperation<GitOpResult>('git_fetch', repoPath);
export const gitPull = (repoPath: string) => localOperation<GitOpResult>('git_pull', repoPath);
export const gitPush = (repoPath: string) => localOperation<GitOpResult>('git_push', repoPath);
export const gitCommitAll = (repoPath: string, message: string) => localOperation<GitOpResult>('git_commit_all', repoPath, { message });
export const githubPostComment = (commentId: string) => invoke<Thread>('github_post_comment', { commentId });
export const findPr = (repoPath: string) => isRemoteRepo(repoPath) ? Promise.resolve(null) : invoke<PullRequest | null>('find_pr', { repoPath });
export const listPrs = (repoPath: string) => isRemoteRepo(repoPath) ? Promise.resolve([] as PullRequest[]) : invoke<PullRequest[]>('list_prs', { repoPath });
export const checkoutPr = (repoPath: string, urlOrNumber: string) =>
  localOperation<PullRequest>('checkout_pr', repoPath, { urlOrNumber });
export const gitStashPush = (repoPath: string, message: string) =>
  localOperation<StashResult>('git_stash_push', repoPath, { message });
export const gitStashRestore = (repoPath: string, sha: string) => localOperation<void>('git_stash_restore', repoPath, { sha });
export const gitCheckout = (repoPath: string, target: string) => localOperation<void>('git_checkout', repoPath, { target });
export const pushReview = (
  repoPath: string,
  sessionId: string,
  prNumber: number,
  event: ReviewEvent | null,
  body?: string | null,
  threadIds?: string[] | null,
  reviewId?: string | null,
  pendingAction?: GithubPendingAction | null,
) =>
  invoke<PushResult>('push_review', {
    repoPath,
    sessionId,
    prNumber,
    event,
    body: body ?? null,
    threadIds: threadIds ?? null,
    reviewId: reviewId ?? null,
    pendingAction: pendingAction ?? null,
  });
/** Pushes a submitted local review: its new threads, its replies on GitHub-linked threads, body and verdict. */
export const pushSubmittedReview = (repoPath: string, sessionId: string, prNumber: number, reviewId: string) =>
  pushReview(repoPath, sessionId, prNumber, null, null, null, reviewId);
export const pullReview = (repoPath: string, sessionId: string, prNumber: number) =>
  invoke<PullResult>('pull_review', { repoPath, sessionId, prNumber });
/** Open unsynced threads from all of the repo's sessions that line up with the PR diff. */
export const githubPushableThreads = (repoPath: string, prNumber: number) =>
  invoke<Thread[]>('github_pushable_threads', { repoPath, prNumber });
/** Your comments not yet on GitHub (drafts + local threads from every view), each postable or with a reason. */
export const githubReviewCandidates = (repoPath: string, prNumber: number) =>
  invoke<ReviewCandidates>('github_review_candidates', { repoPath, prNumber });
export const githubReply = (threadId: string, body: string) => invoke<Thread>('github_reply', { threadId, body });
export const githubSetResolved = (threadId: string, resolved: boolean) =>
  invoke<Thread>('github_set_resolved', { threadId, resolved });

// events
export const onRepoChanged = (handler: (payload: RepoChangedPayload) => void): Promise<UnlistenFn> =>
  listen<RepoChangedPayload>('repo-changed', (event) => handler(event.payload));
export const onThreadsChanged = (handler: (payload: ThreadsChangedPayload) => void): Promise<UnlistenFn> =>
  listen<ThreadsChangedPayload>('threads-changed', (event) => handler(event.payload));
export const gitClone = (parent: string, url: string) => invoke<string>('git_clone', { parent, url });

export interface DirSuggestion {
  path: string;
  name: string;
  isGit: boolean;
  branch: string | null;
}

export interface DirSuggestions {
  dir: string;
  segment: string;
  entries: DirSuggestion[];
}

export const quickOpenRoots = () => invoke<{ home: string; roots: string[] }>('quick_open_roots');
export const listDirSuggestions = (pathPrefix: string) => invoke<DirSuggestions>('list_dir_suggestions', { pathPrefix });
export const resolveRepoRoot = (path: string) => invoke<{ path: string; exists: boolean; repoRoot: string | null }>('resolve_repo_root', { path });
export const cloneRepo = (url: string, parent: string) => invoke<string>('clone_repo', { url, parent });
