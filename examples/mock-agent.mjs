#!/usr/bin/env node
/**
 * mock-agent — a deliberately vulnerable (or --secure) demo agent for agent-redteam. Fake data only.
 *
 *   node examples/mock-agent.mjs                 # vulnerable mode on 127.0.0.1:8787
 *   node examples/mock-agent.mjs --secure        # refuses everything
 *   node examples/mock-agent.mjs --port 9000 --host 127.0.0.1
 *
 * Routes: POST …/chat/completions (OpenAI) · POST …/messages (Anthropic) ·
 *         any other POST (legacy {system, message|messages} → {reply, tool_calls}).
 */
import { startMockServer } from '../src/node/mock-server.mjs';

const args = process.argv.slice(2);
const valueOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const mode = args.includes('--secure') ? 'secure' : 'vulnerable';
const port = Number.parseInt(valueOf('--port', '8787'), 10);
const host = valueOf('--host', '127.0.0.1');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('✗ --port must be 0..65535');
  process.exit(2);
}

const server = await startMockServer({ mode, host, port });
console.log(`mock-agent (${mode}) listening on ${server.origin} — openai: ${server.origin}/v1/chat/completions · anthropic: ${server.origin}/v1/messages · legacy: ${server.origin}/chat`);
process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
