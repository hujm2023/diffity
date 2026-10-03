#!/usr/bin/env node
// Deterministic ACP fixture: proves remote stdio MCP routing and denial of desktop delegation.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const emit = (packet) => process.stdout.write(`${JSON.stringify(packet)}\n`);
let server;
let mcp;
let sequence = 0;
const responses = new Map();
const calls = new Map();
const request = (method, params) => {
  const id = `client-${++sequence}`;
  return new Promise((resolve) => { responses.set(id, resolve); emit({ jsonrpc: '2.0', id, method, params }); });
};
async function mcpCall(method, params = {}) {
  const id = ++sequence;
  const pending = new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return pending;
}
createInterface({ input: process.stdin }).on('line', async (line) => {
  const packet = JSON.parse(line);
  if (!packet.method) { responses.get(packet.id)?.(packet); responses.delete(packet.id); return; }
  try {
    let result = {};
    if (packet.method === 'initialize') {
      if (packet.params.clientCapabilities.fs.readTextFile || packet.params.clientCapabilities.fs.writeTextFile) throw new Error('Desktop filesystem was advertised to a remote agent');
      result = { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: 'fixture-acp', version: '1' }, authMethods: [] };
    } else if (packet.method === 'session/new') {
      server = packet.params.mcpServers[0];
      if (!server.args[0].endsWith('/agent-mcp.py') || server.args.includes('--token')) throw new Error('Desktop MCP descriptor leaked to the remote agent');
      if (process.cwd() !== packet.params.cwd) throw new Error('Agent process used the wrong cwd');
      mcp = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      createInterface({ input: mcp.stdout }).on('line', (line) => {
        const response = JSON.parse(line);
        const pending = calls.get(response.id);
        if (pending) { calls.delete(response.id); if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result); }
      });
      mcp.stderr.on('data', (data) => process.stderr.write(data));
      await mcpCall('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      result = { sessionId: 'fixture', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Read-only review' }] } };
    } else if (packet.method === 'session/prompt') {
      const denied = await request('fs/read_text_file', { sessionId: 'fixture', path: '/a-desktop-file-that-must-not-be-read' });
      if (!denied.error) throw new Error('Remote agent accessed the desktop filesystem');
      const comment = await mcpCall('tools/call', { name: 'add_comment', arguments: { file: 'tracked.txt', startLine: 1, body: 'Fixture finding from remote Claude' } });
      if (comment.isError) throw new Error('Scoped MCP comment failed');
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'desktop-delegation-denied' } } } });
      result = { stopReason: 'end_turn' };
    }
    if (packet.id !== undefined) emit({ jsonrpc: '2.0', id: packet.id, result });
  } catch (error) { emit({ jsonrpc: '2.0', id: packet.id, error: { code: -32603, message: error.message } }); }
}).on('close', () => { mcp?.stdin.end(); mcp?.kill('SIGTERM'); });
