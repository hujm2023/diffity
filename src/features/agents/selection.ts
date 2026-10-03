import { create } from 'zustand';
import { isRemoteRepo } from '../../lib/remote-repo';

export type ReviewAgentId = 'claude' | 'pi';
const KEY = 'diffity-review-agent:';
const useSelection = create<{ values: Record<string, ReviewAgentId> }>(() => ({ values: {} }));

export function selectedAgentId(repoPath: string): ReviewAgentId {
  const current = useSelection.getState().values[repoPath];
  if (current) return current;
  try {
    const saved = localStorage.getItem(KEY + repoPath);
    if (saved === 'pi' || saved === 'claude') return saved;
  } catch { /* Preferences are optional. */ }
  return isRemoteRepo(repoPath) ? 'pi' : 'claude';
}

export function useSelectedAgent(repoPath: string): ReviewAgentId {
  return useSelection((state) => state.values[repoPath] ?? selectedAgentId(repoPath));
}

export function setSelectedAgent(repoPath: string, agent: ReviewAgentId) {
  try { localStorage.setItem(KEY + repoPath, agent); } catch { /* Preferences are optional. */ }
  useSelection.setState((state) => ({ values: { ...state.values, [repoPath]: agent } }));
}

export function agentName(agent: string | undefined): string { return agent === 'pi' ? 'Pi' : 'Claude'; }
export function reviewOnlyAgent(repoPath: string, agent: string = selectedAgentId(repoPath)): boolean {
  return agent === 'pi' || isRemoteRepo(repoPath);
}
