import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as tauri from '../../lib/tauri';
import { parseRemoteRepo } from '../../lib/remote-repo';
import { useRepoPath } from '../../hooks/use-repo';
import { Popover, useMenu } from '../../components/ui/popover';
import { buttonOutline, inputField } from '../../components/ui/button-styles';
import { ChevronDownIcon } from '../../components/ui/icon';
import { agentName, setSelectedAgent, useSelectedAgent, type ReviewAgentId } from './selection';

export function AgentPicker() {
  const repoPath = useRepoPath();
  const selected = useSelectedAgent(repoPath);
  const target = parseRemoteRepo(repoPath);
  const location = target ? target.host : 'this computer';
  const menu = useMenu();
  const client = useQueryClient();
  const agents = useQuery({ queryKey: ['agents', repoPath], queryFn: () => tauri.listAgents(false, repoPath), staleTime: 30_000 });
  const key = `agent.${selected}.path${target ? `@${target.host}` : ''}`;
  const saved = useQuery({ queryKey: ['setting', key], queryFn: () => tauri.getSetting(key) });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved.data ?? ''), [saved.data, key]);
  const redetect = async (save = false) => {
    setBusy(true);
    try {
      if (save) { await tauri.setSetting(key, draft.trim()); await client.invalidateQueries({ queryKey: ['setting', key] }); }
      const data = await tauri.listAgents(true, repoPath);
      client.setQueryData(['agents', repoPath], data);
    } catch (error) { toast.error(`Could not detect agents on ${location}`, { description: tauri.errorMessage(error) }); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button ref={menu.anchorRef} onClick={menu.toggle} className={buttonOutline} aria-label="Choose review agent" aria-expanded={menu.open} title={`Review agent runs on ${location}`}>
        {agentName(selected)} <ChevronDownIcon size="xs" />
      </button>
      <Popover open={menu.open} onClose={menu.close} anchorRef={menu.anchorRef} align="end" width={320}>
        <div className="p-3 space-y-3">
          <p className="text-xs font-medium text-text">Runs on {location}</p>
          <label className="block text-xs text-text-secondary">Review agent
            <select aria-label="Review agent" value={selected} onChange={(event) => setSelectedAgent(repoPath, event.target.value as ReviewAgentId)} className={`${inputField} mt-1`}>
              <option value="claude">Claude Code</option><option value="pi">Pi</option>
            </select>
          </label>
          <p className="text-xs text-text-secondary" role={agents.error ? 'alert' : undefined}>
            {agents.error ? tauri.errorMessage(agents.error) : agents.isPending ? 'Detecting…' : agents.data?.find((agent) => agent.id === selected)?.note ?? `${agentName(selected)} uses its existing login and model configuration on ${location}.`}
          </p>
          <label className="block text-xs text-text-secondary">{target ? 'Remote' : 'Local'} binary path (optional)
            <input aria-label="Agent binary path" className={`${inputField} mt-1 font-mono text-xs`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Leave empty to detect automatically" spellCheck={false} />
          </label>
          <div className="flex gap-2"><button disabled={busy} className={buttonOutline} onClick={() => void redetect(true)}>Save and detect</button><button disabled={busy} className={buttonOutline} onClick={() => void redetect()}>Re-detect</button></div>
          {(selected === 'pi' || target) && <p className="text-xs text-text-muted">Read-only code review and comment replies.</p>}
        </div>
      </Popover>
    </>
  );
}
