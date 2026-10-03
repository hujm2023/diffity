import { selectedAgentId, agentName, reviewOnlyAgent, type ReviewAgentId } from '../agents/selection';
import { getRepoPathOrNull } from '../../lib/api';
import { create } from 'zustand';
import { toast } from 'sonner';
import * as tauri from '../../lib/tauri';
import { queryClient } from '../../lib/query-client';
import { openComments, openSettingsAt } from '../../lib/ui-store';
import type { AgentAction, AgentInfo, AgentMode, PermissionDiff, PermissionOption, RepoThread, RunModel } from '../../lib/types';
import { parseCommitRef, refForSession } from '../../lib/api';
import { TREE_REF } from '../../lib/types';
import { goToThread, viewLabel } from '../../lib/thread-location';
import type { CommentThread } from '../../components/comments/types';
import { getPermissionSetting, runSkipsPrompts, showBypassNotice } from './permission-setting';
import { getModelSetting, readRepoModel, type ModelPurpose } from './model-setting';

export type ClaudeAction = Extract<
  AgentAction,
  { kind: 'review' } | { kind: 'resolve' } | { kind: 'thread' } | { kind: 'reviewFeedback' }
>;

export interface ClaudeRunContext {
  repoPath: string;
  agentId?: ReviewAgentId;
  sessionId: string | null;
  ref?: string | null;
  /** GitHub threads whose new Claude reply should be posted back to GitHub when the run ends. */
  postRepliesToGitHub?: string[];
  /** Model picked for this run; unset uses the repo's last pick, then Settings. */
  model?: RunModel;
}

export interface ClaudeRun {
  id: string;
  action: ClaudeAction;
  context: ClaudeRunContext;
  state: 'queued' | 'running';
  threadIds: string[];
  startedAt: number | null;
  commentsAdded: number;
  chatId: string | null;
  sessionId: string | null;
  /** The view (ref) the run works in; where its comments land. */
  ref: string | null;
  /** Threads Claude started during the run, oldest first. */
  newThreadIds: string[];
  /** The run edits without any permission prompts (Settings → Claude Code → Permissions). */
  skipsPrompts: boolean;
  /** Stop was pressed before the chat started. */
  stopRequested?: boolean;
  /** The user chose "Allow for this run": later edits in this run are approved automatically. */
  editsApproved: boolean;
  /** Model and effort the run uses, once it starts. */
  model: RunModel | null;
}

export interface ClaudePermission {
  runId: string;
  repoPath: string;
  requestId: string;
  title: string;
  options: PermissionOption[];
  diff: PermissionDiff | null;
}

interface ClaudeState {
  runs: ClaudeRun[];
  /** Waiting approvals, oldest first; runs in different projects can ask at the same time. */
  permissions: ClaudePermission[];
}

export const useClaude = create<ClaudeState>(() => ({ runs: [], permissions: [] }));

export type ThreadActivity = 'idle' | 'queued' | 'working';

let counter = 0;
const pumping = new Set<string>();


/** Where Claude may edit files: Claude edits the working tree, so not on an old commit or a range away from HEAD. */
export function canSendToClaude(diffRef: string | null | undefined, current: string | null = getRepoPathOrNull()): boolean {
  if (current && reviewOnlyAgent(current)) return false;
  if (!diffRef) {
    return true;
  }
  if (diffRef === 'work' || diffRef === 'staged' || diffRef === 'unstaged' || diffRef === TREE_REF) {
    return true;
  }
  if (parseCommitRef(diffRef)) {
    return false;
  }
  if (diffRef.includes('..')) {
    const head = diffRef.split(/\.{2,3}/)[1];
    return !head || head === 'HEAD';
  }
  return true;
}

export function modelPurpose(action: ClaudeAction): ModelPurpose {
  return action.kind === 'review' ? 'review' : 'fix';
}

async function runModelFor(run: ClaudeRun): Promise<RunModel> {
  if (reviewOnlyAgent(run.context.repoPath, run.context.agentId)) return {};
  if (run.context.model) {
    return run.context.model;
  }
  const purpose = modelPurpose(run.action);
  return readRepoModel(purpose, run.context.repoPath) ?? (await getModelSetting(purpose));
}

function modeFor(action: ClaudeAction, ref: string | null, readonly = false): AgentMode {
  if (readonly) return 'review';
  if (action.kind === 'review' || (ref && !canSendToClaude(ref, null))) {
    return 'review';
  }
  return 'resolve';
}

export function runLabel(action: ClaudeAction): string {
  switch (action.kind) {
    case 'review':
      return 'Claude is reviewing';
    case 'resolve':
      if (action.threadIds && action.threadIds.length > 0) {
        return `Claude is working on ${action.threadIds.length} comment${action.threadIds.length === 1 ? '' : 's'}`;
      }
      return action.threadId ? 'Claude is working on a comment' : 'Claude is resolving';
    case 'thread':
      return 'Claude is replying';
    case 'reviewFeedback':
      return 'Claude is working through your review';
  }
}

function chatTitle(action: ClaudeAction): string {
  switch (action.kind) {
    case 'review':
      return action.focus ? `Review (${action.focus}) · ${action.ref}` : `Review · ${action.ref}`;
    case 'resolve':
      return action.threadId ? `Resolve thread ${action.threadId.slice(0, 8)}` : 'Resolve all comments';
    case 'thread':
      return 'Reply to thread';
    case 'reviewFeedback':
      return 'Address review';
  }
}

function cachedThreads(): CommentThread[] {
  const result: CommentThread[] = [];
  for (const [, threads] of queryClient.getQueriesData<CommentThread[]>({ queryKey: ['threads'] })) {
    if (threads) {
      result.push(...threads);
    }
  }
  return result;
}

function patchRun(runId: string, patch: Partial<ClaudeRun>) {
  useClaude.setState((state) => ({
    runs: state.runs.map((run) => (run.id === runId ? { ...run, ...patch } : run)),
  }));
}

function removeRun(runId: string) {
  useClaude.setState((state) => ({
    runs: state.runs.filter((run) => run.id !== runId),
    permissions: state.permissions.filter((permission) => permission.runId !== runId),
  }));
}

function initialThreadIds(action: ClaudeAction, sessionId: string | null): string[] {
  if (action.kind === 'thread') {
    return [action.threadId];
  }
  if (action.kind === 'resolve') {
    if (action.threadIds && action.threadIds.length > 0) {
      return action.threadIds;
    }
    if (action.threadId) {
      return [action.threadId];
    }
    return cachedThreads()
      .filter((thread) => thread.sessionId === sessionId && thread.status === 'open' && !thread.pending)
      .map((thread) => thread.id);
  }
  return [];
}

export function enqueueClaude(action: ClaudeAction, context: ClaudeRunContext) {
  context = { ...context, agentId: context.agentId ?? selectedAgentId(context.repoPath) };
  if (reviewOnlyAgent(context.repoPath, context.agentId) && (action.kind === 'resolve' || action.kind === 'reviewFeedback')) {
    toast.error('This agent supports read-only review and comment replies');
    return;
  }
  const run: ClaudeRun = {
    id: `run-${Date.now()}-${++counter}`,
    action,
    context,
    state: 'queued',
    threadIds: initialThreadIds(action, context.sessionId),
    startedAt: null,
    commentsAdded: 0,
    chatId: null,
    sessionId: null,
    ref: action.kind === 'review' ? action.ref : context.ref ?? refForSession(context.sessionId),
    newThreadIds: [],
    skipsPrompts: false,
    editsApproved: false,
    model: null,
  };
  useClaude.setState((state) => ({ runs: [...state.runs, run] }));
  void pump(context.repoPath);
}

/** Stops the project's running run and drops the ones queued behind it. */
export async function stopClaude(repoPath: string) {
  const { runs, permissions } = useClaude.getState();
  const running = runs.find((run) => run.state === 'running' && run.context.repoPath === repoPath);
  useClaude.setState((state) => ({
    runs: state.runs.filter((run) => run.context.repoPath !== repoPath || run.state === 'running'),
  }));
  if (!running) {
    return;
  }
  if (!running.chatId) {
    patchRun(running.id, { stopRequested: true });
    return;
  }
  const waiting = permissions.filter((permission) => permission.runId === running.id);
  for (const permission of waiting) {
    await answerClaudePermission(permission.requestId, null);
  }
  await tauri.cancelPrompt(running.chatId).catch(() => undefined);
}

export async function answerClaudePermission(requestId: string, optionId: string | null, forRun = false) {
  const permission = useClaude.getState().permissions.find((item) => item.requestId === requestId);
  if (!permission) {
    return;
  }
  useClaude.setState((state) => ({ permissions: state.permissions.filter((item) => item.requestId !== requestId) }));
  if (optionId && forRun && permission.diff) {
    patchRun(permission.runId, { editsApproved: true });
  }
  await tauri.respondPermission(permission.requestId, optionId, forRun).catch((error) => {
    toast.error(tauri.errorMessage(error));
  });
}

function agentProblem(agent: AgentInfo | undefined): string | null {
  if (!agent) {
    return 'The selected agent was not found on the project host.';
  }
  if (!agent.installed) {
    return agent.note ?? `${agent.name} is not installed on the project host.`;
  }
  if (agent.authenticated === false) {
    return agent.note ?? `${agent.name} is not logged in on the project host.`;
  }
  return null;
}

async function resolveSession(run: ClaudeRun): Promise<string> {
  const { action, context } = run;
  if (action.kind === 'review') {
    const session = await tauri.getSession(context.repoPath, action.ref);
    return session.id;
  }
  if (action.kind === 'reviewFeedback') {
    const review = await tauri.getReview(action.reviewId);
    patchRun(run.id, { threadIds: review.threadIds });
    return review.sessionId;
  }
  if (action.kind === 'thread' || (action.kind === 'resolve' && action.threadId)) {
    const threadId = action.kind === 'thread' ? action.threadId : action.threadId;
    const thread = cachedThreads().find((item) => item.id === threadId);
    if (thread?.sessionId) {
      return thread.sessionId;
    }
  }
  if (!context.sessionId) {
    throw new Error('There are no changes here for Claude to work on. Open a diff and try again.');
  }
  return context.sessionId;
}

interface ClaudeFailure {
  code: string;
  message: string;
}

function toFailure(error: unknown): ClaudeFailure {
  if (tauri.isAppError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: '', message: tauri.errorMessage(error) };
}

function summarize(message: string): string {
  const first = message.trim().split('\n')[0] ?? '';
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** Plain message for known failures; raw output stays behind "Copy details". */
function showFailure(title: string, failure: ClaudeFailure) {
  if (failure.code === 'agent_auth_required') {
    toast.error(title, {
      description: 'Claude Code is not logged in. Run `claude` in a terminal to log in.',
      action: { label: 'Claude settings', onClick: () => openSettingsAt('claude') },
    });
    return;
  }
  if (failure.code === 'agent_not_installed') {
    toast.error(title, {
      description: 'Claude Code is not installed. Install the `claude` CLI and try again.',
      action: { label: 'Claude settings', onClick: () => openSettingsAt('claude') },
    });
    return;
  }
  const multiline = failure.message.trim().includes('\n');
  toast.error(title, {
    description: summarize(failure.message) || undefined,
    action: multiline
      ? { label: 'Copy details', onClick: () => void navigator.clipboard.writeText(failure.message).catch(() => undefined) }
      : undefined,
  });
}

function cachedRepoThreads(repoPath: string): RepoThread[] {
  return queryClient.getQueryData<RepoThread[]>(['repo-threads', repoPath]) ?? [];
}

/** Label for a run's view, preferring the backend label (it knows commit subjects). */
export function runViewLabel(repoPath: string, ref: string): string {
  return cachedRepoThreads(repoPath).find((thread) => thread.ref === ref)?.refLabel ?? viewLabel(ref);
}

function refForThread(repoPath: string, threadId: string): string | null {
  const thread = cachedRepoThreads(repoPath).find((item) => item.id === threadId);
  if (thread) {
    return thread.ref;
  }
  return refForSession(cachedThreads().find((item) => item.id === threadId)?.sessionId);
}

/** Opens the run's view, scrolled to its first new thread (or the thread it worked on). */
export function openRunResult(run: Pick<ClaudeRun, 'context' | 'ref' | 'newThreadIds' | 'threadIds'>) {
  if (!run.ref) {
    return;
  }
  const threadId = run.newThreadIds[0] ?? run.threadIds[0] ?? null;
  const anchor = threadId ? cachedRepoThreads(run.context.repoPath).find((thread) => thread.id === threadId)?.anchor : undefined;
  if (anchor && anchor !== 'current') {
    openComments();
    return;
  }
  goToThread(run.context.repoPath, { ref: run.ref, threadId });
}

function finishedMessage(run: ClaudeRun, added: number): string {
  const where = run.ref ? ` on ${runViewLabel(run.context.repoPath, run.ref)}` : '';
  if (run.action.kind === 'review') {
    if (added === 0) {
      return `Claude finished reviewing${where} — no comments`;
    }
    return `Claude left ${added} comment${added === 1 ? '' : 's'}${where}`;
  }
  if (run.action.kind === 'thread') {
    return `Claude replied${where}`;
  }
  return `Claude finished${where}`;
}

async function postRepliesToGitHub(sessionId: string, threadIds: string[]): Promise<number> {
  if (threadIds.length === 0) {
    return 0;
  }
  const threads = await tauri.listThreads(sessionId).catch(() => []);
  let posted = 0;
  for (const thread of threads.filter((item) => threadIds.includes(item.id))) {
    const last = thread.comments[thread.comments.length - 1];
    if (!last || last.authorType !== 'agent' || last.githubCommentId) {
      continue;
    }
    try {
      await tauri.githubPostComment(last.id);
      posted += 1;
    } catch (error) {
      toast.error('Could not post Claude’s reply to GitHub', { description: tauri.errorMessage(error) });
    }
  }
  if (posted > 0) {
    queryClient.invalidateQueries({ queryKey: ['threads', sessionId] });
  }
  return posted;
}

async function batchOutcome(sessionId: string, threadIds: string[]): Promise<{ title: string; detail: string | null } | null> {
  if (threadIds.length === 0) {
    return null;
  }
  const threads = await tauri.listThreads(sessionId).catch(() => []);
  const worked = threads.filter((thread) => threadIds.includes(thread.id));
  const resolved = worked.filter((thread) => thread.status !== 'open').length;
  const replied = worked.filter((thread) => thread.status === 'open' && thread.comments[thread.comments.length - 1]?.authorType === 'agent').length;
  const untouched = worked.length - resolved - replied;
  const plural = (count: number) => `${count} comment${count === 1 ? '' : 's'}`;
  if (resolved + replied === 0) {
    return worked.length > 0 ? { title: `Claude skipped ${plural(worked.length)}`, detail: null } : null;
  }
  if (untouched === 0 && resolved === 0) {
    return { title: `Claude replied to ${plural(replied)}`, detail: null };
  }
  if (untouched === 0 && replied === 0) {
    return { title: `Claude resolved ${plural(resolved)}`, detail: null };
  }
  const parts = [
    resolved > 0 ? `${resolved} resolved` : null,
    replied > 0 ? `${replied} replied` : null,
    untouched > 0 ? `${untouched} skipped` : null,
  ].filter(Boolean);
  return { title: `Claude handled ${resolved + replied} of ${plural(worked.length)}`, detail: parts.join(' · ') };
}

async function execute(run: ClaudeRun) {
  const id = run.context.agentId ?? selectedAgentId(run.context.repoPath);
  const name = agentName(id);
  const readonly = reviewOnlyAgent(run.context.repoPath, id);
  const agents = await tauri.listAgents(false, run.context.repoPath);
  const agent = agents.find((item) => item.id === id);
  const problem = agentProblem(agent);
  if (problem || !agent) {
    toast.error(`Could not start ${name}`, {
      description: problem ?? undefined,
      ...(id === 'claude' && !readonly ? { action: { label: 'Claude settings', onClick: () => openSettingsAt('claude') } } : {}),
    });
    return;
  }
  const sessionId = await resolveSession(run);
  const ref = run.ref ?? refForSession(sessionId) ?? threadRef(run);
  run = { ...run, ref };
  const chat = await tauri.startChat({
    repoPath: run.context.repoPath,
    agentId: agent.id,
    mode: modeFor(run.action, ref, readonly),
    sessionId,
    title: chatTitle(run.action),
  });
  const skipsPrompts = runSkipsPrompts(modeFor(run.action, ref, readonly), run.action, await getPermissionSetting());
  const model = await runModelFor(run);
  patchRun(run.id, { chatId: chat.id, sessionId, startedAt: Date.now(), ref, skipsPrompts, model });
  if (useClaude.getState().runs.find((item) => item.id === run.id)?.stopRequested) {
    toast.info(`${name} was stopped`);
    return;
  }
  if (skipsPrompts) {
    showBypassNotice(() => openSettingsAt('claude'));
  }

  const before = await tauri.listThreads(sessionId).catch(() => []);
  const baseline = new Set(before.map((thread) => thread.id));
  let added = 0;
  let newThreadIds: string[] = [];
  const unlisten = await tauri
    .onThreadsChanged(async (payload) => {
      if (payload.sessionId !== sessionId) {
        return;
      }
      const threads = await tauri.listThreads(sessionId).catch(() => null);
      if (!threads) {
        return;
      }
      newThreadIds = threads
        .filter((thread) => !baseline.has(thread.id) && thread.comments[0]?.authorType === 'agent')
        .map((thread) => thread.id);
      added = newThreadIds.length;
      patchRun(run.id, { commentsAdded: added, newThreadIds });
    })
    .catch(() => null);

  let failed: ClaudeFailure | null = null;
  let cancelled = false;
  try {
    await tauri.sendPrompt(chat.id, '', [], run.action, model, (event) => {
      if (event.type === 'permissionRequest') {
        const permission: ClaudePermission = {
          runId: run.id,
          repoPath: run.context.repoPath,
          requestId: event.requestId,
          title: event.title,
          options: event.options,
          diff: event.diff ?? null,
        };
        useClaude.setState((state) => ({ permissions: [...state.permissions, permission] }));
        return;
      }
      if (event.type === 'error') {
        failed = { code: event.code ?? '', message: event.message };
        return;
      }
      if (event.type === 'done' && event.stopReason === 'cancelled') {
        cancelled = true;
      }
    });
  } catch (error) {
    failed = toFailure(error);
  } finally {
    unlisten?.();
    queryClient.invalidateQueries({ queryKey: ['threads', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['reviews'] });
  }
  if (failed) {
    if (readonly) toast.error(`${name} stopped with an error`, { description: failed.message });
    else showFailure('Claude stopped with an error', failed);
    return;
  }
  if (cancelled) {
    toast.info(`${name} was stopped`);
    return;
  }
  const latest = useClaude.getState().runs.find((item) => item.id === run.id) ?? run;
  const finished = { ...latest, ref, newThreadIds };
  const hasTarget = !!ref && (added > 0 || finished.threadIds.length > 0);
  const batch = run.action.kind === 'resolve' ? await batchOutcome(sessionId, finished.threadIds) : null;
  const posted = await postRepliesToGitHub(sessionId, run.context.postRepliesToGitHub ?? []);
  const postedNote = posted > 0 ? `Posted ${posted} repl${posted === 1 ? 'y' : 'ies'} to GitHub` : null;
  const description = batch ? [batch.detail, postedNote].filter(Boolean).join(' · ') : postedNote ?? undefined;
  toast.success((batch?.title ?? finishedMessage(finished, added)).replaceAll('Claude', name), {
    description,
    duration: hasTarget ? 12_000 : undefined,
    action: hasTarget ? { label: batch || added > 0 ? 'Show comments' : 'Show thread', onClick: () => openRunResult(finished) } : undefined,
  });
}

function threadRef(run: ClaudeRun): string | null {
  const threadId = run.action.kind === 'thread' || run.action.kind === 'resolve' ? run.action.threadId : undefined;
  if (!threadId) {
    return null;
  }
  return refForThread(run.context.repoPath, threadId);
}

/** Runs one at a time per project, since they edit the same working tree; projects run side by side. */
async function pump(repoPath: string) {
  if (pumping.has(repoPath)) {
    return;
  }
  pumping.add(repoPath);
  try {
    for (;;) {
      const next = useClaude.getState().runs.find((run) => run.state === 'queued' && run.context.repoPath === repoPath);
      if (!next) {
        return;
      }
      patchRun(next.id, { state: 'running' });
      try {
        await execute(next);
      } catch (error) {
        showFailure(`Could not start ${agentName(next.context.agentId)}`, toFailure(error));
      } finally {
        removeRun(next.id);
      }
    }
  } finally {
    pumping.delete(repoPath);
  }
}

export function useThreadActivity(threadId: string): ThreadActivity {
  return useClaude((state) => {
    let activity: ThreadActivity = 'idle';
    for (const run of state.runs) {
      if (!run.threadIds.includes(threadId)) {
        continue;
      }
      if (run.state === 'running') {
        return 'working';
      }
      activity = 'queued';
    }
    return activity;
  });
}

/** Threads that are queued or being worked on by any Claude run. */
export function useBusyThreadIds(): Set<string> {
  const runs = useClaude((state) => state.runs);
  return new Set(runs.flatMap((run) => run.threadIds));
}

export function useActiveRun(repoPath: string): ClaudeRun | null {
  return useClaude((state) => state.runs.find((run) => run.state === 'running' && run.context.repoPath === repoPath) ?? null);
}

export function useQueuedCount(repoPath: string): number {
  return useClaude((state) => state.runs.filter((run) => run.state === 'queued' && run.context.repoPath === repoPath).length);
}

/** Projects with a Claude run going. */
export function useBusyRepoPaths(): Set<string> {
  const runs = useClaude((state) => state.runs);
  return new Set(runs.filter((run) => run.state === 'running').map((run) => run.context.repoPath));
}
