import http from 'node:http';
import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatRequestToResponses, ChatCompletionAdapter } from './chat-compat.mjs';
import { resolveDataDir, canonicalDataDir } from './data-path.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const MAX_BODY = 16 * 1024 * 1024;
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const UNSUPPORTED = new Set(['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']);
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
class AppError extends Error {
  constructor(status, code, message, body) { super(message); Object.assign(this, { status, code, body }); }
}
function fail(status, code, message) { throw new AppError(status, code, message); }
export function normalizeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', '请求必须是 JSON 对象。');
  if (typeof body.model !== 'string' || !body.model.trim()) fail(400, 'model_required', '请选择或填写模型。');
  for (const key of Object.keys(body)) if (UNSUPPORTED.has(key)) fail(400, 'unsupported_capability', `订阅额度接口暂不支持 ${key}，请移除此参数。`);
  if (body.store === true) fail(400, 'unsupported_capability', '此接口必须使用 store: false。');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail(400, 'invalid_request', 'stream 必须是布尔值。');
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input) || input.length === 0 || input.some(item => !item || typeof item !== 'object' || Array.isArray(item))) fail(400, 'invalid_input', 'input 必须包含至少一个消息对象，也可使用字符串。');
  if (input.some(item => item.role === 'system')) fail(400, 'unsupported_capability', '请把 system 提示放入 instructions 或 developer 消息。');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => tool?.type !== 'namespace' || !Array.isArray(tool.tools) || tool.tools.some(t => !['function', 'custom'].includes(t?.type))))) fail(400, 'unsupported_capability', '当前订阅接口的 tools 仅接受 namespace 内的 function/custom 工具。');
  return { ...body, input, stream: true, store: false };
}
export function verifyIdentity(token, jwks, { clientId, nonce, subject, issuer = AUTH }) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (header.alg !== 'RS256' || !jwk || header.crit) throw Error();
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) throw Error();
    const time = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) throw Error();
    if (!Number.isFinite(claims.exp) || claims.exp < time - 5 || !Number.isFinite(claims.iat) || claims.iat > time + 5 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > time + 5))) throw Error();
    if (typeof claims.sub !== 'string' || !claims.sub || (subject && claims.sub !== subject) || (nonce && !equal(claims.nonce, nonce))) throw Error();
    return claims;
  } catch { fail(401, 'invalid_id_token', '登录身份验证失败，请重新授权。'); }
}

export function createApp({ dataDir = resolveDataDir(ROOT), fetchImpl = globalThis.fetch, publicDir = join(ROOT, 'public') } = {}) {
  dataDir = canonicalDataDir(dataDir);
  const instanceId = randomUUID();
  const serviceId = hash(dataDir).slice(0, 20);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const file = join(dataDir, 'state.json');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); chmodSync(file, 0o600); }
  catch (error) {
    if (error.code !== 'ENOENT') throw Error('本地数据文件无法读取。请检查数据目录中的 state.json；为保护账号，服务不会覆盖它。');
    state = { hostId: `urn:uuid:${randomUUID()}`, accounts: [], activeAccountId: null, keys: [], stats: { requests: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0 }, logs: [] };
  }
  function save() {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  }
  save();
  const sessions = new Map(), transactions = new Map(), refreshes = new Map(), loginAttempts = new Set();
  const modelCache = new Map();
  let discoveryCache, keyCache, inFlight = 0, baseUrl;
  function summary(account) {
    if (!account) return null;
    return { id: account.id, email: account.email, name: account.name, clientId: account.client_id, scopes: account.scopes || [], connected: !!account.access_token, planUsageEnabled: !!account.access_token && account.scopes?.includes('chatgpt.tokens.use.direct'), expiresAt: account.expires_at || null };
  }
  const selected = () => state.accounts.find(account => account.id === state.activeAccountId);
  function sessionFor(req) {
    const id = /(?:^|;\s*)pb_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const session = sessions.get(id);
    if (session?.expiresAt > Date.now()) return { id, ...session };
    if (id) sessions.delete(id);
    return null;
  }
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  function json(res, status, data) {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  function sameOrigin(req) {
    if (req.headers.origin && req.headers.origin !== baseUrl) fail(403, 'origin_rejected', '只允许本站请求。');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin_rejected', '跨站请求被拒绝。');
  }
  function admin(req, mutate = false) {
    sameOrigin(req);
    const session = sessionFor(req);
    if (!session) fail(401, 'local_session_required', '请先打开本地控制台。');
    if (mutate && !equal(req.headers['x-local-csrf'], session.csrf)) fail(403, 'csrf_rejected', '页面已过期，请刷新后重试。');
    return session;
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'json_required', '请使用 Content-Type: application/json。');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) fail(413, 'body_too_large', '请求内容超过 16 MB。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'invalid_json', 'JSON 格式错误。'); }
  }
  async function remote(url, options = {}) {
    try { return await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(25000) }); }
    catch (error) { if (error.name === 'AbortError') throw error; fail(502, 'upstream_unreachable', '无法连接 OpenAI。请检查网络或代理配置，然后重试。'); }
  }
  async function remoteJson(url, options = {}) {
    const response = await remote(url, options);
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = { error: { code: 'upstream_http_error', message: `OpenAI 返回 HTTP ${response.status}。` } }; }
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code || data.code || 'upstream_http_error';
      const err = new AppError(response.status, code, data.error?.message || `OpenAI 返回 HTTP ${response.status}。`, data);
      err.requestId = response.headers.get('x-request-id'); throw err;
    }
    return data;
  }
  async function discovery() {
    if (discoveryCache?.expires > Date.now()) return discoveryCache.value;
    const value = await remoteJson(`${AUTH}/.well-known/openid-configuration`);
    if (value.issuer !== AUTH) fail(502, 'invalid_discovery', 'OpenAI 登录配置无效。');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      if (value[field] && (!value[field].startsWith(`${AUTH}/`) || new URL(value[field]).origin !== AUTH)) fail(502, 'invalid_discovery', '登录端点与 OpenAI 域名不匹配。');
    }
    if (!value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) fail(502, 'invalid_discovery', '登录配置缺少必要端点。');
    discoveryCache = { value, expires: Date.now() + 3600000 }; return value;
  }
  async function jwks(token) {
    const kid = (() => { try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).kid; } catch { return null; } })();
    if (!keyCache || keyCache.expires < Date.now() || !keyCache.value.keys?.some(key => key.kid === kid)) {
      keyCache = { value: await remoteJson((await discovery()).jwks_uri), expires: Date.now() + 3600000 };
    }
    return keyCache.value;
  }
  function applyTokens(account, tokens, retainIdentity = true) {
    if (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || typeof tokens.access_token !== 'string' || !tokens.access_token || String(tokens.token_type).toLowerCase() !== 'bearer') fail(502, 'invalid_token_response', 'OpenAI 没有返回有效的访问令牌。');
    if (typeof tokens.scope !== 'string') fail(502, 'invalid_token_response', 'OpenAI 没有返回授权范围。');
    const scopes = tokens.scope.split(/\s+/).filter(Boolean);
    if (scopes.includes('offline_access') && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)) fail(502, 'invalid_token_response', 'OpenAI 没有返回轮换的刷新令牌。');
    Object.assign(account, { access_token: tokens.access_token, refresh_token: tokens.refresh_token || null, token_type: tokens.token_type, scopes, expires_at: Date.now() + tokens.expires_in * 1000, earliest_refresh_at: tokens.earliest_refresh_at || null, saved_at: now() });
    account.token_version = (account.token_version || 0) + 1;
    if (tokens.id_token && retainIdentity) account.id_token = tokens.id_token;
  }
  function clearTokens(account) {
    for (const field of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'earliest_refresh_at', 'pending_refresh']) delete account[field];
    account.token_version = (account.token_version || 0) + 1;
    modelCache.delete(account.id); save();
  }
  function invalidateLogins(predicate) {
    for (const attempt of loginAttempts) if (predicate(attempt)) {
      attempt.invalidated = true; transactions.delete(attempt.state); loginAttempts.delete(attempt);
    }
  }
  async function tokenFor(account) {
    if (!account?.access_token) fail(401, 'login_required', '请先在控制台连接 ChatGPT 账号。');
    if (!account.scopes?.includes('chatgpt.tokens.use.direct')) fail(403, 'plan_usage_not_authorized', '账号尚未授权使用 ChatGPT 计划，请重新登录并允许计划额度权限。');
    if (account.expires_at > Date.now() + 15000) return account.access_token;
    if (refreshes.has(account.id)) return refreshes.get(account.id);
    const pending = (async () => {
      if (!account.refresh_token) fail(401, 'reauthorization_required', '登录已过期，请重新连接账号。');
      const version = account.token_version || 0, refreshToken = account.refresh_token, clientId = account.client_id;
      const current = () => state.accounts.includes(account) && !!account.access_token && (account.token_version || 0) === version;
      try {
        let tokens = account.pending_refresh?.version === version ? account.pending_refresh.tokens : null;
        if (!tokens) {
          const config = await discovery();
          tokens = await remoteJson(config.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE }).toString() });
          if (!current()) fail(409, 'credentials_changed', '账号授权已变更，请重新发起请求。');
          // A rotating refresh token is spent already. Protect the replacement before
          // fetching optional identity keys so a temporary network failure is resumable.
          applyTokens({ ...account }, tokens);
          account.pending_refresh = { version, tokens, receivedAt: Date.now() }; save();
        }
        if (tokens.id_token) verifyIdentity(tokens.id_token, await jwks(tokens.id_token), { clientId: account.client_id, subject: account.subject });
        if (!current()) fail(409, 'credentials_changed', '账号授权已变更，请重新发起请求。');
        const receivedAt = account.pending_refresh?.receivedAt || Date.now();
        applyTokens(account, tokens); account.expires_at = receivedAt + tokens.expires_in * 1000;
        delete account.pending_refresh; save();
        if (!account.scopes.includes('chatgpt.tokens.use.direct')) fail(403, 'plan_usage_not_authorized', '刷新后的授权不含计划额度权限，请重新连接账号。');
        return account.access_token;
      } catch (error) {
        if (!current()) fail(409, 'credentials_changed', '账号授权已变更，请重新发起请求。');
        if (error.code === 'invalid_id_token') { clearTokens(account); throw error; }
        if (TERMINAL_REFRESH.has(error.code)) { clearTokens(account); fail(401, 'reauthorization_required', '登录凭证已失效，请重新连接同一账号。'); }
        throw error;
      }
    })();
    refreshes.set(account.id, pending);
    try { return await pending; } finally { refreshes.delete(account.id); }
  }
  function accountByKey(req) {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!token) fail(401, 'invalid_api_key', '请提供本地 API Key：Authorization: Bearer <key>。');
    const digest = hash(token);
    const key = state.keys.find(item => equal(item.hash, digest));
    if (!key) fail(401, 'invalid_api_key', '本地 API Key 无效或已撤销。');
    const account = state.accounts.find(item => item.id === key.accountId);
    if (!account) fail(401, 'login_required', '此 Key 绑定的账号不存在，请重新生成。');
    key.lastUsedAt = now(); save(); return account;
  }
  async function models(account) {
    const token = await tokenFor(account);
    const cached = modelCache.get(account.id);
    if (cached?.expires > Date.now()) return cached.models;
    const data = await remoteJson(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(data.models)) fail(502, 'invalid_model_catalog', 'OpenAI 未返回此账号的模型目录。');
    const list = data.models.filter(item => item.visibility === 'list' && typeof item.slug === 'string').map(({ slug, display_name }) => ({ slug, display_name: display_name || slug }));
    modelCache.set(account.id, { models: list, expires: Date.now() + 60000 }); return list;
  }
  function record(log, terminal) {
    state.stats.requests++; state.stats[log.status === 'completed' ? 'completed' : 'failed']++;
    if (terminal?.usage) { state.stats.inputTokens += terminal.usage.input_tokens || 0; state.stats.outputTokens += terminal.usage.output_tokens || 0; }
    state.logs.unshift(log); state.logs = state.logs.slice(0, 40); save();
  }
  async function inference(req, res, account, raw, adapter = null) {
    const payload = normalizeRequest(raw);
    let cancelledBeforeInference = res.destroyed, token;
    const cancelDuringRefresh = () => { cancelledBeforeInference = true; };
    res.on('close', cancelDuringRefresh);
    try { token = await tokenFor(account); } finally { res.off('close', cancelDuringRefresh); }
    if (cancelledBeforeInference || res.destroyed) return;
    if (inFlight >= 3) fail(429, 'local_concurrency_limit', '本地最多同时运行 3 个请求，请稍后重试。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60000); timeout.unref();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    inFlight++;
    const start = Date.now(), log = { id: randomUUID(), at: now(), model: payload.model, status: 'failed', durationMs: 0, errorCode: null };
    let terminal, streaming = raw.stream === true;
    try {
      const upstream = await remote(`${RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(payload), signal: controller.signal });
      const requestId = upstream.headers.get('x-request-id');
      if (requestId) res.setHeader('x-request-id', requestId);
      if (!upstream.ok) {
        let data; try { data = await upstream.json(); } catch { data = { error: { code: 'upstream_http_error', message: `OpenAI 返回 HTTP ${upstream.status}。` } }; }
        const error = new AppError(upstream.status, data.error?.code || 'upstream_http_error', data.error?.message || 'OpenAI 拒绝此次请求。', data);
        const retry = upstream.headers.get('retry-after'); if (retry) res.setHeader('retry-after', retry);
        throw error;
      }
      const upstreamContentType = upstream.headers.get('content-type');
      // Some successful subscription streams omit Content-Type. In that case
      // parse and validate the SSE body and terminal event rather than reject it.
      if (!upstream.body || (upstreamContentType && !upstreamContentType.includes('text/event-stream'))) fail(502, 'invalid_upstream_stream', 'OpenAI 没有返回预期的事件流。');
      if (streaming) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); }
      const decoder = new TextDecoder(); let buffer = '', output = '', terminalType, pendingFrames = [];
      const writeChunk = async chunk => {
        if (!res.destroyed && !res.write(chunk)) await new Promise(resolve => {
          const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); };
          res.once('drain', ready); res.once('close', ready);
        });
      };
      const processFrame = frame => {
        const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!text || text === '[DONE]') return;
        let event; try { event = JSON.parse(text); } catch { fail(502, 'invalid_upstream_stream', 'OpenAI 事件流包含无效 JSON。'); }
        if (adapter && streaming) pendingFrames.push(...adapter.event(event));
        if (event.type === 'response.output_text.delta') output += event.delta || '';
        if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          if (terminalType) return;
          if (event.type === 'response.completed' && (!event.response || typeof event.response !== 'object' || Array.isArray(event.response) || event.response.status !== 'completed')) fail(502, 'invalid_upstream_stream', 'OpenAI 完成事件缺少有效的 completed 响应。');
          terminalType = event.type; terminal = event.response;
          if (terminalType === 'response.completed') log.status = 'completed';
          else log.errorCode = event.response?.error?.code || event.error?.code || event.code || (terminalType === 'response.incomplete' ? 'response_incomplete' : 'upstream_error');
        }
      };
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
        if (buffer.length > 32 * 1024 * 1024 || output.length > 32 * 1024 * 1024) fail(502, 'stream_too_large', '返回内容过大。');
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) { processFrame(buffer.slice(0, split)); buffer = buffer.slice(split + 2); }
        if (streaming) {
          if (adapter) { if (pendingFrames.length) await writeChunk(pendingFrames.join('')); pendingFrames = []; }
          else await writeChunk(chunk);
        }
        if (terminalType) break;
      }
      buffer += decoder.decode(); if (buffer.trim()) processFrame(buffer);
      if (!terminalType) fail(502, 'stream_interrupted', '连接提前结束，未收到 response.completed；此次调用未被记为成功。');
      if (streaming && adapter) {
        if (pendingFrames.length) await writeChunk(pendingFrames.join(''));
        res.end(log.status === 'completed' ? adapter.completedSSE(terminal).join('') : adapter.error(log.errorCode, terminal?.error?.message || '生成未完成。'));
      }
      else if (streaming) res.end();
      else if (log.status === 'completed') json(res, 200, adapter ? adapter.finish(terminal, output) : { ...terminal, output_text: output });
      else json(res, errorStatus(log.errorCode), { error: { code: log.errorCode, message: terminal?.error?.message || '生成未完成，请检查错误。', type: 'upstream_error' }, response: terminal || null });
    } catch (error) {
      log.status = 'failed'; log.errorCode = controller.signal.aborted ? 'request_cancelled' : (typeof error.code === 'string' ? error.code : 'upstream_error');
      if (!res.destroyed) {
        if (res.headersSent) { res.end(adapter ? adapter.error(log.errorCode, error.message || '连接中断。') : `event: error\ndata: ${JSON.stringify({ type: 'error', code: log.errorCode, message: error.message || '连接中断。' })}\n\n`); }
        else if (controller.signal.aborted) fail(504, 'request_cancelled', '请求超时或已取消。');
        else throw error;
      }
    } finally { clearTimeout(timeout); res.off('close', cancel); inFlight--; log.durationMs = Date.now() - start; record(log, terminal); }
  }
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const port = server.address()?.port;
      baseUrl = `http://127.0.0.1:${port}`;
      // Use one canonical origin, including for the OAuth loopback callback.
      if (req.headers.host !== `127.0.0.1:${port}`) fail(403, 'host_rejected', `请访问 ${baseUrl}。`);
      const url = new URL(req.url, baseUrl), path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, service: 'planbridge', serviceId, pid: process.pid, instanceId });
      if (req.method === 'GET' && path === '/auth/callback') {
        const pending = transactions.get(url.searchParams.get('state'));
        const session = sessionFor(req);
        if (!pending || pending.expiresAt < Date.now() || !session || !equal(pending.sessionId, session.id)) fail(400, 'invalid_oauth_state', '登录请求已过期或不属于此浏览器，请回到本地页面重新登录。');
        transactions.delete(url.searchParams.get('state'));
        try {
          if (url.searchParams.has('error')) fail(400, 'authorization_denied', 'ChatGPT 授权未完成，请重新登录并检查计划额度权限。');
          const callbackClient = url.searchParams.get('client_id');
          const clientId = pending.clientId === 'dynamic_agent_client' ? callbackClient : pending.clientId;
          if (!clientId || clientId === 'dynamic_agent_client' || (callbackClient && callbackClient !== clientId)) fail(400, 'invalid_client_id', '授权未返回匹配的应用编号，请重新登录。');
          const code = url.searchParams.get('code'); if (!code) fail(400, 'missing_code', '登录回调没有授权码。');
          const tokens = await remoteJson((await discovery()).token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }).toString() });
          if (typeof tokens.id_token !== 'string') fail(502, 'missing_id_token', 'OpenAI 未返回身份凭证。');
          const claims = verifyIdentity(tokens.id_token, await jwks(tokens.id_token), { clientId, nonce: pending.nonce, subject: pending.subject });
          let account = state.accounts.find(item => item.client_id === clientId && item.subject === claims.sub);
          if (pending.accountId && (!account || account.id !== pending.accountId)) fail(401, 'account_mismatch', '返回的身份与所选账号不一致。');
          const next = { ...(account || {}), id: account?.id || randomUUID(), issuer: AUTH, subject: claims.sub, client_id: clientId, email: typeof claims.email === 'string' ? claims.email : '', name: typeof claims.name === 'string' ? claims.name : '', id_token: tokens.id_token };
          applyTokens(next, tokens);
          delete next.pending_refresh;
          if (pending.invalidated) fail(409, 'login_cancelled', '此登录已被新请求或断开操作取消，请重新连接。');
          if (account) Object.assign(account, next); else { account = next; state.accounts.push(account); }
          delete account.pending_refresh;
          state.activeAccountId = account.id; modelCache.delete(account.id); save();
          sessions.get(session.id).loginError = null;
          res.writeHead(303, { Location: '/?login=success' }); res.end(); return;
        } catch (error) {
          if (!pending.invalidated) sessions.get(session.id).loginError = { code: error.code || 'login_failed', message: error.message || '登录失败。' };
          res.writeHead(303, { Location: '/?login=error' }); res.end(); return;
        } finally { loginAttempts.delete(pending); }
      }
      if (req.method === 'GET' && path === '/api/session') {
        sameOrigin(req);
        let session = sessionFor(req);
        if (!session) {
          const id = random(); session = { id, csrf: random(), expiresAt: Date.now() + 86400000 };
          sessions.set(id, session);
          res.setHeader('Set-Cookie', `pb_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
        }
        return json(res, 200, { csrf: session.csrf, baseUrl: `${baseUrl}/v1`, account: summary(selected()), accounts: state.accounts.map(summary), keys: state.keys.map(({ hash, ...item }) => item), stats: state.stats, logs: state.logs, hostId: state.hostId, loginError: session.loginError || null });
      }
      if (path.startsWith('/api/')) {
        const session = admin(req, req.method !== 'GET');
        if (req.method === 'POST' && path === '/api/auth/start') {
          const data = await body(req), account = data.accountId ? state.accounts.find(item => item.id === data.accountId) : null;
          if (data.accountId && !account) fail(404, 'account_not_found', '账号不存在。');
          const ownerSession = sessions.get(session.id);
          ownerSession.loginError = null;
          const epoch = ownerSession.authEpoch = (ownerSession.authEpoch || 0) + 1;
          invalidateLogins(attempt => attempt.expiresAt < Date.now() || attempt.sessionId === session.id);
          const config = await discovery(), verifier = random(), nonce = random(), oauthState = random();
          if (ownerSession.authEpoch !== epoch) fail(409, 'login_cancelled', '登录请求已被较新的操作取消。');
          const clientId = account?.client_id || 'dynamic_agent_client', redirectUri = `${baseUrl}/auth/callback`;
          const attempt = { state: oauthState, verifier, nonce, clientId, redirectUri, accountId: account?.id, subject: account?.subject, sessionId: session.id, expiresAt: Date.now() + 10 * 60000 };
          transactions.set(oauthState, attempt); loginAttempts.add(attempt);
          const authorization = new URL(config.authorization_endpoint);
          const params = { client_id: clientId, ext_agent_host_id: state.hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state: oauthState, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
          if (!account) params.agent_name_hint = 'PlanBridge';
          if (account?.id_token) params.id_token_hint = account.id_token;
          if (account?.email) params.login_hint = account.email;
          for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value);
          return json(res, 200, { url: authorization.href });
        }
        if (req.method === 'POST' && path === '/api/auth/logout') {
          const data = await body(req), account = data.accountId ? state.accounts.find(item => item.id === data.accountId) : selected();
          if (!account) fail(404, 'account_not_found', '账号不存在。');
          sessions.get(session.id).authEpoch = (sessions.get(session.id).authEpoch || 0) + 1;
          invalidateLogins(attempt => attempt.accountId === account.id || attempt.sessionId === session.id);
          // Wait for refresh so revocation uses the latest rotating refresh token.
          if (refreshes.has(account.id)) await refreshes.get(account.id).catch(() => {});
          const refreshToken = account.pending_refresh?.version === (account.token_version || 0)
            ? account.pending_refresh.tokens.refresh_token || account.refresh_token
            : account.refresh_token;
          clearTokens(account);
          for (const [id, tx] of transactions) if (tx.accountId === account.id) transactions.delete(id);
          let revoked = false;
          if (refreshToken) {
            try {
              const config = await discovery();
              if (config.revocation_endpoint) {
                const response = await remote(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: account.client_id }).toString() }); revoked = response.ok;
              }
            } catch {}
          }
          return json(res, 200, { ok: true, revoked, message: revoked ? '已断开，并撤销 OpenAI 刷新令牌。' : '已清除本地凭证；远程撤销未确认，可在 ChatGPT 设置中移除此应用的授权。' });
        }
        if (req.method === 'POST' && path === '/api/accounts/select') {
          const data = await body(req); if (!state.accounts.some(item => item.id === data.accountId)) fail(404, 'account_not_found', '账号不存在。');
          state.activeAccountId = data.accountId; save(); return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && path.startsWith('/api/accounts/')) {
          const id = path.split('/').pop(), account = state.accounts.find(item => item.id === id);
          if (!account) fail(404, 'account_not_found', '账号不存在。');
          if (account.access_token || refreshes.has(id)) fail(409, 'disconnect_first', '请先断开账号，再移除本地记录。');
          invalidateLogins(attempt => attempt.accountId === id);
          state.accounts = state.accounts.filter(item => item.id !== id); state.keys = state.keys.filter(item => item.accountId !== id);
          if (state.activeAccountId === id) state.activeAccountId = state.accounts[0]?.id || null;
          save(); return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && path === '/api/models') return json(res, 200, { models: await models(selected()) });
        if (req.method === 'POST' && path === '/api/keys') {
          const data = await body(req), account = selected();
          if (!account?.access_token || !account.scopes?.includes('chatgpt.tokens.use.direct')) fail(401, 'login_required', '请先连接并授权使用 ChatGPT 计划额度。');
          if (state.keys.length >= 100) fail(400, 'key_limit', '最多保存 100 个 Key，请先撤销不用的 Key。');
          const key = `pb_local_${random()}`, record = { id: randomUUID(), name: typeof data.name === 'string' ? data.name.trim().slice(0, 80) || '本地调用' : '本地调用', prefix: key.slice(0, 18), createdAt: now(), lastUsedAt: null, accountId: account.id };
          state.keys.push({ ...record, hash: hash(key) }); save(); return json(res, 201, { key, record });
        }
        if (req.method === 'DELETE' && path.startsWith('/api/keys/')) {
          const id = path.split('/').pop(); if (!state.keys.some(item => item.id === id)) fail(404, 'key_not_found', 'Key 不存在。');
          state.keys = state.keys.filter(item => item.id !== id); save(); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && path === '/api/playground') return await inference(req, res, selected(), await body(req));
        fail(404, 'not_found', '接口不存在。');
      }
      if (path.startsWith('/v1/')) {
        sameOrigin(req); const account = accountByKey(req);
        if (req.method === 'GET' && path === '/v1/models') {
          const list = await models(account); return json(res, 200, { object: 'list', data: list.map(item => ({ id: item.slug, object: 'model', owned_by: 'openai', display_name: item.display_name })), models: list });
        }
        if (req.method === 'POST' && path === '/v1/responses') return await inference(req, res, account, await body(req));
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          const chat = await body(req), { payload, ignored } = chatRequestToResponses(chat);
          if (ignored.length) res.setHeader('x-planbridge-ignored-parameters', ignored.join(','));
          return await inference(req, res, account, payload, new ChatCompletionAdapter(chat.model, { includeUsage: chat.stream_options?.include_usage === true }));
        }
        fail(404, 'route_not_supported', '本地网关支持 /v1/models、/v1/responses 与 /v1/chat/completions。');
      }
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css', '/favicon.svg'].includes(path)) {
        const name = path === '/' ? 'index.html' : path.slice(1);
        let content; try { content = readFileSync(join(publicDir, name)); } catch { fail(404, 'not_found', '页面文件不存在。'); }
        const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' }[name.split('.').pop()];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(content); return;
      }
      fail(404, 'not_found', '页面不存在。');
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.end();
      if (error.requestId) res.setHeader('x-request-id', error.requestId);
      json(res, error.status || 500, error.body || { error: { code: error.code || 'internal_error', message: error.status ? error.message : '本地服务发生错误，请重启后再试。', type: 'local_gateway_error' } });
    }
  });
  server.requestTimeout = 300000;
  return { server, state };
}
function errorStatus(code) {
  if (code === 'subscription_sharing_usage_limit_exceeded') return 429;
  if (['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(code)) return 503;
  if (['subscription_sharing_user_not_eligible', 'subscription_sharing_route_not_supported', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code)) return 403;
  if (code === 'subscription_sharing_invalid_user') return 401;
  if (code === 'subscription_sharing_unsupported_capability') return 400;
  return 502;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PLANBRIDGE_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PLANBRIDGE_PORT 必须在 1024–65535 之间。');
  const { server } = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭旧服务或设置 PLANBRIDGE_PORT。` : `服务无法启动 (${error.code || 'unknown'})。`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`PlanBridge 已启动： http://127.0.0.1:${port}\n仅限本机访问，按 Ctrl+C 停止。`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
