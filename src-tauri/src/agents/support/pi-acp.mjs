// ACP v1 review adapter over Pi's documented JSONL RPC, using Pi's own MCP registration.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sessions = new Map();
const extension = join(dirname(fileURLToPath(import.meta.url)), 'pi-extension.mjs');
const emit = (packet) => process.stdout.write(`${JSON.stringify(packet)}\n`);
const fail = (message, code = -32603) => Object.assign(new Error(message), { code });
const rpcError = (error) => ({ code: error.code || (/api.?key|authenticat|not logged in|\/login|unauthorized/i.test(error.message) ? -32000 : -32603), message: error.message });

class PiSession {
  constructor(cwd, mcpServers) {
    this.id = randomUUID();
    this.pending = new Map();
    this.counter = 0;
    this.turn = null;
    this.closed = false;
    const servers = mcpServers.map((server, index) => {
      if (!server.command || server.url) throw fail('Pi review requires stdio MCP servers');
      return { ...server, name: `diffity_${this.id.replaceAll('-', '')}_${index}` };
    });
    const commentTools = ['get_diff', 'list_threads', 'add_comment', 'add_general_comment', 'reply'];
    const tools = ['read', 'grep', 'find', 'ls', ...servers.flatMap((server) => commentTools.map((tool) => `mcp__${server.name}__${tool}`))];
    this.child = spawn(process.env.DIFFITY_PI_BINARY || 'pi', [
      '--mode', 'rpc', '--no-session', '--no-approve', '--no-extensions',
      '--extension', 'builtin:mcp', '--extension', extension,
      '--no-prompt-templates', '--tools', tools.join(','),
    ], { cwd, env: { ...process.env, DIFFITY_PI_MCP_SERVERS: JSON.stringify(servers) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (data) => process.stderr.write(data));
    this.child.on('error', (error) => this.died(error));
    this.child.on('exit', (code) => this.died(fail(`Pi exited${code === null ? '' : ` with status ${code}`}`)));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try { this.event(JSON.parse(line)); } catch (error) { this.died(fail(`Invalid Pi RPC output: ${error.message}`)); }
    });
  }

  request(type, fields = {}) {
    if (this.closed) return Promise.reject(fail('Pi is not running'));
    const id = `diffity-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail(`Pi ${type} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  update(update) { emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.id, update } }); }

  event(event) {
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(event.id);
        if (event.success) pending.resolve(event.data);
        else pending.reject(fail(event.error || 'Pi RPC request failed'));
      }
      return;
    }
    if (event.type === 'extension_ui_request') {
      // Reviews are unattended and read-only; never silently approve extension dialogs.
      if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true })}\n`);
      }
      return;
    }
    if (!this.turn) return;
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent || {};
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        this.update({ sessionUpdate: update.type === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk', content: { type: 'text', text: update.delta || '' } });
      }
    } else if (event.type === 'tool_execution_start') {
      this.update({ sessionUpdate: 'tool_call', toolCallId: event.toolCallId, title: event.toolName,
        kind: 'read', status: 'in_progress', rawInput: event.args });
    } else if (event.type === 'tool_execution_end') {
      this.update({ sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId,
        status: event.isError ? 'failed' : 'completed', rawOutput: event.result });
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.stopReason === 'error') this.turn.error = fail(event.message.errorMessage || 'Pi model request failed');
      if (event.message.stopReason === 'aborted') this.turn.cancelled = true;
    } else if (event.type === 'agent_settled') {
      const turn = this.turn; this.turn = null;
      if (turn.error) turn.reject(turn.error);
      else turn.resolve({ stopReason: turn.cancelled ? 'cancelled' : 'end_turn' });
    }
  }

  async prompt(content) {
    if (this.turn) throw fail('Pi is already reviewing');
    const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    if (!text.trim()) throw fail('Pi review requires a text prompt', -32602);
    let turn;
    const settled = new Promise((resolve, reject) => { turn = { resolve, reject, cancelled: false, error: null }; });
    // Attach a rejection handler while waiting for the prompt acceptance response.
    settled.catch(() => {});
    this.turn = turn;
    try {
      const accepted = await this.request('prompt', { message: text });
      if (accepted?.disposition === 'handled') { if (this.turn === turn) this.turn = null; turn.resolve({ stopReason: 'end_turn' }); }
    } catch (error) { if (this.turn === turn) this.turn = null; turn.reject(error); }
    return settled;
  }

  died(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.turn) { this.turn.reject(error); this.turn = null; }
  }

  close() { this.died(fail('Pi session closed')); this.child.stdin.end(); this.child.kill('SIGTERM'); }
}

async function dispatch(method, params = {}) {
  if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: { http: false, sse: false } }, agentInfo: { name: 'diffity-pi', version: '1' }, authMethods: [] };
  if (method === 'session/new') {
    const session = new PiSession(params.cwd, params.mcpServers || []);
    sessions.set(session.id, session);
    try {
      const state = await session.request('get_state');
      return { sessionId: session.id, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Read-only review' }] },
        ...(state?.model ? { models: { currentModelId: `${state.model.provider}/${state.model.id}`, availableModels: [{ modelId: `${state.model.provider}/${state.model.id}`, name: state.model.name || state.model.id }] } } : {}) };
    } catch (error) { session.close(); sessions.delete(session.id); throw error; }
  }
  const session = sessions.get(params.sessionId);
  if (!session) throw fail('Pi session not found', -32602);
  if (method === 'session/prompt') return session.prompt(params.prompt || []);
  if (method === 'session/cancel') { if (session.turn) session.turn.cancelled = true; await session.request('abort'); return {}; }
  if (method === 'session/set_mode') {
    if (params.modeId !== 'default') throw fail('Pi supports read-only review only', -32602);
    return {};
  }
  if (method === 'session/set_model') {
    const slash = params.modelId?.indexOf('/');
    if (!(slash > 0)) throw fail('Pi model IDs must include provider/model', -32602);
    await session.request('set_model', { provider: params.modelId.slice(0, slash), modelId: params.modelId.slice(slash + 1) });
    return {};
  }
  throw fail(`Unsupported Pi ACP method: ${method}`, -32601);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let packet;
  try {
    packet = JSON.parse(line);
    if (!packet.method) return;
    const result = await dispatch(packet.method, packet.params);
    if (packet.id !== undefined) emit({ jsonrpc: '2.0', id: packet.id, result });
  } catch (error) {
    if (packet?.id !== undefined) emit({ jsonrpc: '2.0', id: packet.id, error: rpcError(error) });
    else process.stderr.write(`Pi adapter: ${error.message}\n`);
  }
}).on('close', () => { for (const session of sessions.values()) session.close(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const session of sessions.values()) session.close(); process.exit(0); });
