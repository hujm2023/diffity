export interface RemoteTarget {
  host: string;
  path: string;
}

export interface RemoteWorktree {
  path: string;
  branch: string | null;
  headSha: string | null;
  bare: boolean;
  prunable: boolean;
}

export function isRemoteRepo(path: string): boolean {
  return path.startsWith('ssh://');
}

export function remoteRepoPath(hostInput: string, pathInput: string): string {
  const host = hostInput.trim();
  const path = pathInput.trim();
  if (!host || host.startsWith('-') || host.length > 255 || !/^[a-zA-Z0-9._@:-]+$/.test(host)) {
    throw new Error('Enter an SSH host alias or user@hostname');
  }
  if ((!path.startsWith('/') && !path.startsWith('~/')) || path.includes('\0')) {
    throw new Error('Enter an absolute remote path or ~/path');
  }
  const encoded = path.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `ssh://${host}/${encoded.replace(/^\/+/, '')}`;
}

export function parseRemoteRepo(value: string): RemoteTarget | null {
  if (!isRemoteRepo(value)) {
    return null;
  }
  const match = /^ssh:\/\/([^/]+)\/(.*)$/.exec(value);
  if (!match) {
    throw new Error('Expected ssh://host/absolute/path');
  }
  const decoded = decodeURIComponent(match[2]);
  const path = decoded.startsWith('~/') ? decoded : `/${decoded}`;
  remoteRepoPath(match[1], path); // Validate before passing a target to SSH.
  return { host: match[1], path };
}

export function readOnlyError() {
  return { code: 'read_only', message: 'SSH repositories are read-only in this version' };
}
