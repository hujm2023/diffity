// Local transport proxy. Agent code executes exclusively inside the selected SSH host.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const config = JSON.parse(process.env.DIFFITY_REMOTE_AGENT || '{}');
const directory = dirname(fileURLToPath(import.meta.url));
const servers = new Map();
const waiting = [];
let ready = null;
let closing = false;
const emit = (packet) => process.stdout.write(`${JSON.stringify(packet)}\n`);
const runner = readFileSync(join(directory, 'remote-agent.py'), 'utf8');
const source = Buffer.from(runner).toString('base64');
// The command is constant code plus a bundled source blob; host/project data never enters a shell string.
const bootstrap = `python3 -c 'import base64; exec(compile(base64.b64decode("${source}"),"diffity-remote-agent","exec"))'`;
const ssh = spawn('ssh', ['-T', '-x', '-a', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2', config.host, bootstrap], { stdio: ['pipe', 'pipe', 'pipe'] });
const send = (packet) => { if (!ssh.stdin.destroyed) ssh.stdin.write(`${JSON.stringify(packet)}\n`); };
send({ ...config, files: Object.fromEntries(['pi-acp.mjs', 'pi-extension.mjs', 'agent-mcp.py'].map((name) => [name, readFileSync(join(directory, name), 'utf8')])) });
ssh.stderr.on('data', (data) => process.stderr.write(data));
ssh.on('error', (error) => { process.stderr.write(`SSH agent: ${error.message}\n`); cleanup(); process.exitCode = 1; });
ssh.on('exit', (code) => { cleanup(); process.exit(code || (closing ? 0 : 1)); });

function cleanup() { for (const server of servers.values()) server.kill('SIGTERM'); servers.clear(); }
function stop() {
  if (closing) return;
  closing = true; cleanup(); send({ kind: 'close' }); ssh.stdin.end();
  setTimeout(() => ssh.kill('SIGTERM'), 4000).unref();
}
function localServer(server, channel) {
  // Only client-created MCP descriptors are run on the desktop, never descriptors emitted by the remote agent.
  const child = spawn(server.command, server.args || [], {
    env: { ...process.env, ...Object.fromEntries((server.env || []).map(({ name, value }) => [name, value])) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  servers.set(channel, child);
  child.stderr.on('data', (data) => process.stderr.write(data));
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { send({ kind: 'mcp', channel, packet: JSON.parse(line) }); }
    catch { process.stderr.write('Invalid MCP sidecar response\n'); stop(); }
  });
  child.on('error', (error) => { process.stderr.write(`MCP sidecar: ${error.message}\n`); stop(); });
  child.on('exit', () => { servers.delete(channel); send({ kind: 'mcp_closed', channel }); });
}

function forward(packet) {
  if (packet.method === 'initialize') {
    packet.params.clientCapabilities = { ...(packet.params.clientCapabilities || {}), fs: { readTextFile: false, writeTextFile: false }, terminal: false };
  }
  if (packet.method === 'session/new' || packet.method === 'session/load') {
    packet.params.cwd = config.cwd;
    packet.params.mcpServers = (packet.params.mcpServers || []).map((server) => {
      if ((server.type && server.type !== 'stdio') || server.command !== config.mcpCommand) throw new Error('Unexpected remote MCP descriptor');
      const channel = randomUUID();
      localServer(server, channel);
      return { ...server, command: ready.python, args: [join(ready.directory, 'agent-mcp.py'), channel, ready.socket], env: [] };
    });
  }
  send({ kind: 'agent', packet });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  try { const packet = JSON.parse(line); if (ready) forward(packet); else waiting.push(packet); }
  catch (error) { process.stderr.write(`SSH agent protocol: ${error.message}\n`); stop(); }
}).on('close', stop);
createInterface({ input: ssh.stdout }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.kind === 'ready') { ready = message; for (const packet of waiting.splice(0)) forward(packet); }
    else if (message.kind === 'agent') {
      const packet = message.packet;
      if (packet.method?.startsWith('fs/') || packet.method?.startsWith('terminal/')) {
        if (packet.id !== undefined) send({ kind: 'agent', packet: { jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'Desktop file/terminal delegation is disabled for SSH projects; use remote tools' } } });
      } else emit(packet);
    } else if (message.kind === 'mcp') {
      const server = servers.get(message.channel);
      if (!server) throw new Error('Unknown remote MCP channel');
      server.stdin.write(`${JSON.stringify(message.packet)}\n`);
    } else if (message.kind === 'mcp_closed') { servers.get(message.channel)?.kill('SIGTERM'); servers.delete(message.channel); }
    else if (message.kind === 'stderr') process.stderr.write(message.text);
    else if (message.kind === 'error') { process.stderr.write(`Remote agent: ${message.message}\n`); stop(); }
    else if (message.kind === 'exit') stop();
  } catch (error) { process.stderr.write(`SSH agent protocol: ${error.message}\n`); stop(); }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
