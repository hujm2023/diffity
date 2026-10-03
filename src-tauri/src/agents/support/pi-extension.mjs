// Loaded explicitly by the bundled adapter. No user/project extensions run in a review session.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export default function diffityReview(pi) {
  if (typeof pi.registerMcpServer !== 'function') {
    throw new Error('Diffity needs Pi 0.99.2 or newer with native MCP registration');
  }
  const servers = JSON.parse(process.env.DIFFITY_PI_MCP_SERVERS || '[]');
  const prefixes = servers.map((server) => `mcp__${server.name}__`);
  const readTools = new Set(['read', 'grep', 'find', 'ls']);
  const commentTools = new Set(['get_diff', 'list_threads', 'add_comment', 'add_general_comment', 'reply']);
  const allowed = (name) => readTools.has(name) || prefixes.some((prefix) => name.startsWith(prefix) && commentTools.has(name.slice(prefix.length)));
  for (const server of servers) {
    pi.registerMcpServer(server.name, {
      command: server.command, args: server.args || [],
      env: Object.fromEntries((server.env || []).map(({ name, value }) => [name, value])),
      exposure: 'direct', timeout: 60,
    });
  }
  pi.on('tool_call', async (event, ctx) => {
    if (!allowed(event.toolName)) {
      return { block: true, reason: 'Diffity review allows only code reads and scoped review comments' };
    }
    if (readTools.has(event.toolName)) {
      try {
        const root = realpathSync(ctx.cwd);
        const target = realpathSync(resolve(root, event.input.path || '.'));
        const path = relative(root, target);
        if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) || path.split(sep).some((part) => part === '.git' || part === '.secrets' || part === '.env')) {
          return { block: true, reason: 'Diffity review reads must stay inside the selected project and exclude credentials/Git metadata' };
        }
      } catch { return { block: true, reason: 'The requested review path does not exist or cannot be read' }; }
    }
  });
  pi.on('user_bash', async () => ({ handled: true, result: { output: 'Shell commands are disabled in Diffity review', exitCode: 1 } }));
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: `${event.systemPrompt}\nYou are reviewing code in Diffity. This session is read-only. Never modify files or run shell commands. Use the supplied get_diff and comment tools to leave findings and reply to threads. Do not claim code was changed.`,
  }));
}
