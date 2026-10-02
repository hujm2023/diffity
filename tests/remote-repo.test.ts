import { describe, expect, it, vi } from 'vitest';
import { isRemoteRepo, parseRemoteRepo, remoteRepoPath } from '../src/lib/remote-repo';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import * as api from '../src/lib/tauri';

describe('SSH repository identity', () => {
  it('round trips Unicode and shell metacharacters as data', () => {
    const path = "/home/me/项目 name/'$(whoami)%";
    const locator = remoteRepoPath('me@devbox', path);
    expect(parseRemoteRepo(locator)).toEqual({ host: 'me@devbox', path });
    expect(parseRemoteRepo(remoteRepoPath('devbox', '~/project'))).toEqual({ host: 'devbox', path: '~/project' });
    expect(remoteRepoPath('host-a', path)).not.toEqual(remoteRepoPath('host-b', path));
    expect(isRemoteRepo('/home/me/project')).toBe(false);
  });

  it('rejects SSH options and invalid paths', () => {
    for (const host of ['-oProxyCommand=bad', 'host;touch x', 'host\ncommand', '']) {
      expect(() => remoteRepoPath(host, '/repo')).toThrow();
    }
    expect(() => remoteRepoPath('dev', 'relative')).toThrow();
    expect(() => parseRemoteRepo('ssh://dev/%00')).toThrow();
  });
});

describe('SSH API routing', () => {
  it('routes reads to SSH and keeps local reads on existing commands', async () => {
    invoke.mockReset();
    invoke.mockResolvedValue({});
    const repo = remoteRepoPath('devbox', '/repo');
    await api.getDiff(repo, 'staged', true);
    expect(invoke).toHaveBeenLastCalledWith('ssh_request', { repoPath: repo, operation: 'get_diff', args: { ref: 'staged', ignoreWhitespace: true, showIgnored: false } });
    await api.readFile(repo, 'src/main.rs');
    expect(invoke).toHaveBeenLastCalledWith('ssh_request', { repoPath: repo, operation: 'read_file', args: { path: 'src/main.rs' } });
    await api.gitStatus('/local/repo');
    expect(invoke).toHaveBeenLastCalledWith('git_status', { repoPath: '/local/repo' });
  });

  it('blocks writes and agents without invoking any backend command', async () => {
    invoke.mockReset();
    const repo = remoteRepoPath('devbox', '/repo');
    const operations = [api.gitFetch(repo), api.gitPull(repo), api.gitPush(repo), api.gitCommitAll(repo, 'test'), api.gitCheckout(repo, 'main'), api.gitStashPush(repo, 'test'), api.gitStashRestore(repo, 'abc'), api.revertFile(repo, 'a'), api.revertHunk(repo, 'patch'), api.setDiffIgnoreRules(repo, '*.ts'), api.openInEditor(repo, 'a'), api.startChat({ repoPath: repo, agentId: 'claude', mode: 'review', sessionId: 'fixture' })];
    for (const operation of operations) {
      await expect(operation).rejects.toMatchObject({ code: 'read_only' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('qualifies worktree identities with the same SSH host', async () => {
    invoke.mockReset();
    invoke.mockResolvedValue([{ path: '/repo/.worktrees/task-a', branch: 'task-a', headSha: 'abc', bare: false, prunable: false }]);
    const entries = await api.listWorktrees(remoteRepoPath('devbox', '/repo'));
    expect(entries[0].path).toBe('ssh://devbox/repo/.worktrees/task-a');
  });
});
