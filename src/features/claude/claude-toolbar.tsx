import { agentName, useSelectedAgent } from '../agents/selection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TREE_REF } from '../../lib/types';
import { openRunResult, runLabel, runViewLabel, stopClaude, useActiveRun, useQueuedCount } from './claude-runner';
import { useCurrentViewRef } from '../../hooks/use-current-view';
import { useRepoPath } from '../../hooks/use-repo';
import { buttonClaude } from '../../components/ui/button-styles';
import { AskClaudePopover, useAskClaudeRequest } from './ask-claude-review';
import { cn } from '../../lib/cn';
import { toast } from 'sonner';
import { useReviewState } from '../review/review-state';
import { SparkleIcon, StopIcon } from '../../components/ui/icon';
import { Spinner } from '../../components/icons/spinner';
import { runModelLabel, useModelCatalog } from './model-setting';

interface ClaudeToolbarProps {
  diffRef: string | null;
  sessionId: string | null;
  hasChanges?: boolean;
  focusedFile?: string | null;
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ClaudeStatus() {
  const repoPath = useRepoPath();
  const run = useActiveRun(repoPath);
  const queued = useQueuedCount(repoPath);
  const now = useNow(run !== null);
  const currentRef = useCurrentViewRef();
  const { data: catalog } = useModelCatalog();

  if (!run) {
    return null;
  }

  const elsewhere = !!run.ref && run.ref !== currentRef;
  const where = run.ref ? runViewLabel(run.context.repoPath, run.ref) : null;
  const showCount = run.commentsAdded > 0;
  const countLabel = `${run.commentsAdded} comment${run.commentsAdded === 1 ? '' : 's'}`;
  const canOpen = !!run.ref && (run.commentsAdded > 0 || elsewhere);

  return (
    <div className="flex items-stretch h-7 rounded-md border border-control-border bg-raised overflow-hidden text-xs min-w-0">
      <span
        className="flex items-center gap-2 pl-2.5 pr-2 text-text whitespace-nowrap min-w-0 overflow-hidden"
        title={where ? `Working on ${where}` : undefined}
      >
        <Spinner className="text-claude" />
        <span className="font-medium truncate @max-3xl/titlebar:hidden">{runLabel(run.action).replaceAll('Claude', agentName(run.context.agentId))}</span>
        {run.model && <span className="text-text-muted truncate max-w-[160px] @max-5xl/titlebar:hidden">{runModelLabel(catalog, run.model)}</span>}
        {elsewhere && where && (
          <span className="text-text-secondary truncate max-w-[180px] @max-4xl/titlebar:hidden">on {where}</span>
        )}
        {showCount && (
          canOpen ? (
            <button
              onClick={() => openRunResult(run)}
              className="text-text-secondary @max-2xl/titlebar:hidden underline decoration-text-muted/50 underline-offset-2 hover:text-text cursor-pointer"
              title={where ? `Show Claude's comments on ${where}` : "Show Claude's comments"}
            >
              {countLabel}
            </button>
          ) : (
            <span className="text-text-secondary @max-2xl/titlebar:hidden">{countLabel}</span>
          )
        )}
        {run.startedAt && <span className="text-text-muted tabular-nums">{formatElapsed(now - run.startedAt)}</span>}
        {queued > 0 && <span className="text-text-muted @max-3xl/titlebar:hidden">+{queued} queued</span>}
      </span>
      <button
        onClick={() => void stopClaude(repoPath)}
        className="flex items-center gap-1 px-2 shrink-0 border-l border-control-border text-text-secondary hover:text-text hover:bg-control-hover transition-colors cursor-pointer"
        title="Stop Claude"
      >
        <StopIcon size="xs" />
        Stop
      </button>
    </div>
  );
}

export function ClaudeToolbar(props: ClaudeToolbarProps) {
  const { diffRef, sessionId, hasChanges = true, focusedFile } = props;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const repoPath = useRepoPath();
  const chosen = useSelectedAgent(repoPath);
  const name = agentName(chosen);
  const run = useActiveRun(repoPath);
  const { prMode } = useReviewState();
  const requested = useAskClaudeRequest((state) => state.ref);

  const reviewRef = diffRef && diffRef !== TREE_REF && hasChanges ? diffRef : null;

  useEffect(() => {
    if (!requested || requested !== reviewRef) {
      return;
    }
    useAskClaudeRequest.setState({ ref: null });
    if (run) {
      toast.info('Claude is already working. Wait for it to finish or stop it first.');
      return;
    }
    setOpen(true);
  }, [requested, reviewRef, run]);

  if (run) {
    return <ClaudeStatus />;
  }
  if (!reviewRef) {
    return null;
  }

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen(!open)}
        className={cn(buttonClaude, open && 'bg-claude/16')}
        title={prMode ? 'Claude reviews this pull request and leaves its comments in Diffity only (marked Claude). Use “Add to my review” on any you want to post to GitHub.' : 'Claude reviews these changes and leaves comments on the diff. Tell it what to focus on first.'}
        aria-expanded={open}
      >
        <SparkleIcon size="md" />
        <span className="@max-3xl/titlebar:hidden">Ask {name}</span>
        <span className="hidden @min-[1100px]/titlebar:inline -ml-[3px]">to review</span>
      </button>
      <AskClaudePopover open={open} onClose={close} anchorRef={anchorRef} diffRef={reviewRef} sessionId={sessionId} focusedFile={focusedFile} />
    </>
  );
}
