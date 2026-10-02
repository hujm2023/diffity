import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import * as tauri from '../../lib/tauri';
import { isRemoteRepo, parseRemoteRepo } from '../../lib/remote-repo';
import { useRepoPath } from '../../hooks/use-repo';
import { openRepoAt } from '../welcome/recent-repos';
import { RefreshIcon } from '../../components/ui/icon';
import { Spinner } from '../../components/icons/spinner';

export function RemoteControls() {
  const repoPath = useRepoPath();
  const remote = isRemoteRepo(repoPath);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const worktrees = useQuery({ queryKey: ['remote-worktrees', repoPath], queryFn: () => tauri.listWorktrees(repoPath), enabled: remote, staleTime: Infinity });
  if (!remote) return null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await client.invalidateQueries();
    } finally {
      setRefreshing(false);
    }
  };
  const switchTo = async (path: string) => {
    if (path === repoPath) return;
    setSwitching(true);
    try {
      await openRepoAt(path, navigate, { page: 'diff' });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="shrink-0 rounded bg-fill px-1.5 py-0.5 text-[10px] font-medium" title="SSH read-only review; refresh to read the latest remote changes">SSH · read-only</span>
      <select aria-label="Remote worktree" value={repoPath} disabled={switching || worktrees.isPending}
        onChange={(event) => void switchTo(event.target.value)}
        className="max-w-[260px] min-w-20 rounded border border-control-border bg-raised px-1.5 h-6 text-[11px] text-text"
        title={worktrees.error ? tauri.errorMessage(worktrees.error) : 'Select a remote Git worktree'}>
        {!worktrees.data?.some((entry) => entry.path === repoPath) && <option value={repoPath}>{parseRemoteRepo(repoPath)?.path}</option>}
        {worktrees.data?.map((entry) => (
          <option key={entry.path} value={entry.path} disabled={entry.bare || entry.prunable}>
            {entry.branch ?? (entry.bare ? 'bare' : 'detached')} · {parseRemoteRepo(entry.path)?.path}
          </option>
        ))}
      </select>
      <button disabled={refreshing} onClick={() => void refresh()} className="flex items-center gap-1 h-6 px-1.5 rounded hover:bg-hover cursor-pointer disabled:opacity-50" title="Refresh remote data (⌘R / Ctrl+R)" aria-label="Refresh remote data">
        {refreshing ? <Spinner /> : <RefreshIcon size="sm" />} Refresh
      </button>
      {worktrees.isError && <button onClick={() => void worktrees.refetch().then((result) => { if (result.error) toast.error('Could not list worktrees', { description: tauri.errorMessage(result.error) }); })} className="text-deleted text-[11px] cursor-pointer">Retry worktrees</button>}
    </div>
  );
}
