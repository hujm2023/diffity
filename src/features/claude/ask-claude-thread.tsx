import { agentName, reviewOnlyAgent, useSelectedAgent } from '../agents/selection';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { getRepoPath } from '../../lib/api';
import type { RunModel } from '../../lib/types';
import { MenuItem, MenuLabel, MenuSeparator, Popover, useMenu } from '../../components/ui/popover';
import { ChevronDownIcon, SparkleIcon } from '../../components/ui/icon';
import { enqueueClaude } from './claude-runner';
import { ModelMenu } from './model-picker';
import { readRepoModel, useModelSetting } from './model-setting';

const itemClass = 'inline-flex items-center h-6 rounded-md text-xs text-text-secondary hover:text-text hover:bg-hover transition-colors cursor-pointer';

/** "Ask Claude" on one thread; the chevron picks a model for just this run. */
export function AskClaudeThreadButton(props: { threadId: string; sessionId: string | null }) {
  const { threadId, sessionId } = props;
  const repoPath = getRepoPath();
  const chosen = useSelectedAgent(repoPath);
  const name = agentName(chosen);
  const readonly = reviewOnlyAgent(repoPath, chosen);
  const { open, close, toggle, anchorRef } = useMenu();
  const fallbackModel = useModelSetting('fix');
  const [picked, setPicked] = useState<RunModel | null>(null);
  const model = picked ?? readRepoModel('fix', getRepoPath()) ?? fallbackModel;

  const ask = (runModel?: RunModel) => {
    close();
    enqueueClaude({ kind: 'thread', threadId }, { repoPath: getRepoPath(), sessionId, model: readonly ? {} : runModel, agentId: chosen });
  };

  return (
    <span className="inline-flex items-center">
      <button onClick={() => ask()} className={cn(itemClass, 'gap-1 px-2')} title={readonly ? `${name} replies to this comment without changing code` : `${name} answers or makes the change for this comment`}>
        <SparkleIcon className="w-3 h-3 text-claude" />
        Ask {name}
      </button>
      {!readonly && <button
        ref={anchorRef}
        onClick={toggle}
        aria-expanded={open}
        aria-label="Pick a model for this run"
        title="Pick a model for this run"
        className={cn(itemClass, '-ml-1 px-1 text-text-muted', open && 'bg-hover text-text')}
      >
        <ChevronDownIcon size="xs" />
      </button>}
      <Popover open={open} onClose={close} anchorRef={anchorRef} align="end" width={260}>
        <MenuLabel>This run only</MenuLabel>
        <ModelMenu value={model} onChange={setPicked} />
        <MenuSeparator />
        <MenuItem icon={<SparkleIcon size="sm" className="text-claude" />} label={`Ask ${name}`} onSelect={() => ask(model)} />
      </Popover>
    </span>
  );
}
