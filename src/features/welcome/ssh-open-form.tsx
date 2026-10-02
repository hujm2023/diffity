import { useState, type FormEvent } from 'react';
import { remoteRepoPath } from '../../lib/remote-repo';
import { buttonPrimary, inputField } from '../../components/ui/button-styles';
import { Spinner } from '../../components/icons/spinner';

export function SshOpenForm(props: { onOpen: (path: string) => Promise<unknown> }) {
  const [host, setHost] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const target = remoteRepoPath(host, path);
      setBusy(true);
      await props.onOpen(target);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <label className="block text-xs text-text-secondary">
        SSH host
        <input autoFocus required disabled={busy} value={host} onChange={(event) => setHost(event.target.value)}
          placeholder="devbox or user@hostname" className={`${inputField} mt-1.5`} autoComplete="off" spellCheck={false} />
      </label>
      <label className="block text-xs text-text-secondary">
        Remote repository path
        <input required disabled={busy} value={path} onChange={(event) => setPath(event.target.value)}
          placeholder="/home/user/project or ~/project" className={`${inputField} mt-1.5`} autoComplete="off" spellCheck={false} />
      </label>
      <p className="text-xs leading-5 text-text-secondary">Uses your SSH config and keys. Sign in to this host from a terminal first. The remote needs Git and Python 3.</p>
      {error && <p role="alert" className="text-xs text-deleted">{error}</p>}
      <button type="submit" disabled={busy} className={buttonPrimary}>
        {busy && <Spinner />} {busy ? 'Connecting…' : 'Open via SSH'}
      </button>
    </form>
  );
}
