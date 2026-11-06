// Runs agent tools, for both MCP (/mcp) and the agent API (/api/agent). Tools call the normal API
// endpoints in-process through `callApi`, so they get the same validation as the app itself.
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { APP_VERSION } from '../config.js';
import { TOOLS, toolByName, describeTool } from './tools.js';

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
// Newest first; we answer in the version the client asks for when we know it
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Brisk Budget is a personal finance tracker. Start with get_overview.',
  'Amounts are in pounds; money out of an account is negative and money in is positive.',
  'Credit cards, loans and mortgages hold a negative balance for money owed.',
  'Money moving between two of the user\'s own accounts is a transfer: use create_transfer, or make_transfer to link two imported transactions, so it is not counted as spending.',
  'Bank statements go in with import_transactions (dryRun first); rows already in the account are skipped.',
  'Take a backup with create_backup before large changes.'
].join(' ');

// Paths only a person signed in to the app may use: signing in, the password, and AI access itself
// What only a person can do: signing in, the password, AI agent access, and deleting backups (so
// whatever an agent does, the backups to undo it are still there)
export const personOnly = (path, method = 'GET') =>
  path.startsWith('/api/auth/') || path === '/api/agents' || path.startsWith('/api/agents/')
  || (method === 'DELETE' && (path === '/api/backups' || path.startsWith('/api/backups/')));
export const PERSON_ONLY_MESSAGE = 'Signing in, the password, AI agent access and deleting backups are for a person in the app only.';
// The most messages one MCP request can carry
const MAX_BATCH = 20;

export function createGateway(app, { routes, today }) {
  const allowedFor = (agent) => TOOLS.filter(t => agent?.access !== 'read' || t.readOnly);

  // Run one API endpoint in-process. Returns the response data, or throws an HttpError.
  async function callApi(method, path, { query, body } = {}, agent) {
    const verb = String(method || '').toUpperCase();
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw badRequest('path must start with /api/');
    const url = new URL(path, 'http://brisk.local');
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    if (personOnly(url.pathname, verb)) throw forbidden(PERSON_ONLY_MESSAGE);
    if (url.pathname === '/api/agent' || url.pathname.startsWith('/api/agent/')) throw badRequest('Call tools directly rather than through api_request');
    if (agent?.access === 'read' && MUTATING.has(verb)) throw forbidden('This access key is read-only, so it can\'t change anything.');
    const match = routes.match(verb, url.pathname);
    if (!match) throw notFound('No such API endpoint');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    if (match.route.options.raw) throw badRequest('That endpoint takes a file upload, which agents can\'t send');
    const req = { method: verb, url: url.pathname, headers: {}, socket: { remoteAddress: 'agent' }, agent };
    const result = await match.route.handler({ req, res: null, params: match.params, query: url.searchParams, body: MUTATING.has(verb) ? (body ?? {}) : {}, raw: null });
    if (result?.__file) return { file: true, bytes: result.buffer.length, note: 'This endpoint returns a file, which is not passed to agents.' };
    if (result?.__reply) {
      if (result.status >= 400) throw new HttpError(result.status, result.data?.error || 'Request failed');
      return result.data;
    }
    return result ?? { success: true };
  }

  const endpoints = () => routes.list()
    .filter(r => !personOnly(r.pattern, r.method) && !r.pattern.startsWith('/api/agent'))
    .map(r => `${r.method} ${r.pattern}`);

  // Check a tool's arguments enough to give a clear message; the endpoint checks the rest
  function checkArgs(tool, args) {
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) throw badRequest('Arguments must be an object');
    const missing = (tool.input.required || []).filter(k => args[k] === undefined);
    if (missing.length) throw badRequest(`Missing ${missing.join(', ')}`);
    const known = Object.keys(tool.input.properties || {});
    const unknown = Object.keys(args).filter(k => !known.includes(k));
    if (unknown.length) throw badRequest(`Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ${tool.name} takes: ${known.join(', ') || 'nothing'}`);
    // Arguments with a fixed set of choices must be one of them (any case for words)
    for (const [key, value] of Object.entries(args)) {
      const choices = tool.input.properties[key]?.enum;
      if (!choices || value === undefined) continue;
      const same = (c) => c === value || (typeof c === 'string' && typeof value === 'string' && c.toLowerCase() === value.toLowerCase());
      if (!choices.some(same)) throw badRequest(`${key} must be one of: ${choices.join(', ')}`);
    }
    return args;
  }

  async function runTool(name, args, agent, via) {
    const tool = toolByName.get(name);
    if (!tool) throw notFound(`There's no tool called ${name}`);
    if (agent?.access === 'read' && !tool.readOnly) throw forbidden('This access key is read-only, so it can\'t use tools that change things.');
    const clean = checkArgs(tool, args);
    const api = (method, path, opts) => callApi(method, path, opts, agent);
    // Only calls that can change something go in the activity log
    const changes = agent && !tool.readOnly && clean.dryRun !== true
      && !(tool.name === 'api_request' && String(clean.method).toUpperCase() === 'GET');
    const action = (tool.name === 'api_request' ? `api_request ${String(clean.method).toUpperCase()} ${clean.path}` : name).slice(0, 200);
    try {
      const result = await tool.run(clean, api, { endpoints, today });
      if (changes) app.services.agents.record(agent, { via, action, ok: true });
      return result;
    } catch (err) {
      if (changes) app.services.agents.record(agent, { via, action, ok: false, error: String(err.message).slice(0, 200) });
      throw err;
    }
  }

  function catalogue(agent) {
    return {
      name: 'Brisk Budget',
      version: APP_VERSION,
      instructions: INSTRUCTIONS,
      mcp: '/mcp',
      tools: allowedFor(agent).map(describeTool)
    };
  }

  // ----- MCP (Streamable HTTP, JSON responses) -----

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function answer(message, agent) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return 'id' in (message || {}) ? rpcError(message.id, -32600, 'Invalid request') : null;
    }
    const isNotification = !('id' in message);
    if (isNotification) return null; // notifications/initialized and friends need no reply
    const { id, method } = message;
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'brisk-budget', title: 'Brisk Budget', version: APP_VERSION },
          instructions: INSTRUCTIONS
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: allowedFor(agent).map(describeTool) });
      case 'tools/call': {
        if (!toolByName.has(params.name)) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const data = await runTool(params.name, params.arguments ?? {}, agent, 'mcp');
          const structured = data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data };
          return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: structured, isError: false });
        } catch (err) {
          const message = err instanceof HttpError ? err.message : 'Something went wrong running that tool.';
          if (!(err instanceof HttpError)) app.log.error('Agent tool failed:', err.stack || err.message);
          return ok({ content: [{ type: 'text', text: message }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  // One POST to /mcp: a message or a batch. Returns the JSON to send, or null for "202, nothing".
  async function handleMcp(payload, agent) {
    if (Array.isArray(payload)) {
      if (!payload.length) return rpcError(null, -32600, 'Empty batch');
      if (payload.length > MAX_BATCH) return rpcError(null, -32600, `A batch can hold up to ${MAX_BATCH} messages`);
      // One at a time, so a batch can't pile up work all at once
      const replies = [];
      for (const message of payload) {
        const reply = await answer(message, agent);
        if (reply) replies.push(reply);
      }
      return replies.length ? replies : null;
    }
    return answer(payload, agent);
  }

  return { callApi, runTool, catalogue, handleMcp, endpoints };
}
