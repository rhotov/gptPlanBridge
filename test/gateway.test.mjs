import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createApp, normalizeRequest, verifyIdentity } from '../server.mjs';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CLIENT = 'test_agent_client';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const jwks = { keys: [jwk] };
const config = { issuer: AUTH, authorization_endpoint: `${AUTH}/oauth/authorize`, token_endpoint: `${AUTH}/oauth/token`, jwks_uri: `${AUTH}/.well-known/jwks.json`, revocation_endpoint: `${AUTH}/oauth/revoke` };
const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
function jwt(claims = {}, header = {}) {
  const time = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ iss: AUTH, sub: 'subject-1', aud: CLIENT, iat: time, exp: time + 3600, email: 'first@example.test', name: 'Test Account', ...claims })}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}
function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function sseResponse(events, headers = {}) {
  const frames = events.map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(frames, { headers: { 'content-type': 'text/event-stream', ...headers } });
}
function completed(text = 'Hello', overrides = {}) {
  return [{ type: 'response.output_text.delta', delta: text.slice(0, 2) }, { type: 'response.output_text.delta', delta: text.slice(2) }, { type: 'response.completed', response: { id: 'resp_test', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 11, output_tokens: 7 }, ...overrides } }];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function eventually(predicate, message = 'condition did not become true') {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function harness(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'planbridge-test-'));
  const remoteCalls = [];
  const mock = { login: {}, latestAuth: null, tokenHandler: null, jwksHandler: null, modelsHandler: null, responsesHandler: null, discovery: config };
  const app = createApp({ dataDir, fetchImpl: async (url, options = {}) => {
    const call = { url: String(url), ...options };
    remoteCalls.push(call);
    if (call.url === `${AUTH}/.well-known/openid-configuration`) return jsonResponse(mock.discovery);
    if (call.url === config.jwks_uri) return mock.jwksHandler ? mock.jwksHandler(call) : jsonResponse(jwks);
    if (call.url === config.token_endpoint) {
      call.form = new URLSearchParams(options.body);
      if (mock.tokenHandler) return mock.tokenHandler(call);
      const clientId = call.form.get('client_id');
      const nonce = call.form.get('grant_type') === 'authorization_code' ? mock.latestAuth.searchParams.get('nonce') : undefined;
      const claims = { aud: clientId, nonce, ...mock.login.claims };
      return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt(claims), ...mock.login.tokens });
    }
    if (call.url === config.revocation_endpoint) { call.form = new URLSearchParams(options.body); return new Response(null, { status: 200 }); }
    if (call.url === `${RESOURCE}/models`) return mock.modelsHandler ? mock.modelsHandler(call) : jsonResponse({ models: [{ slug: 'gpt-test', display_name: 'Test GPT', visibility: 'list' }, { slug: 'hidden-test', visibility: 'hidden' }] });
    if (call.url === `${RESOURCE}/responses`) return mock.responsesHandler ? mock.responsesHandler(call) : sseResponse(completed());
    throw Error(`Unexpected external request: ${call.url}`);
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const request = async (path, { method = 'GET', body, admin = false, headers = {} } = {}) => {
    const merged = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(admin && cookie ? { cookie, 'x-local-csrf': csrf } : {}), ...headers };
    return fetch(`${origin}${path}`, { method, headers: merged, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  };
  const session = async () => {
    const response = await request('/api/session', { headers: cookie ? { cookie } : {} });
    assert.equal(response.status, 200);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json(); csrf = data.csrf; return data;
  };
  const start = async (body = {}) => {
    if (!cookie) await session();
    const response = await request('/api/auth/start', { method: 'POST', body, admin: true });
    assert.equal(response.status, 200);
    mock.latestAuth = new URL((await response.json()).url);
    return mock.latestAuth;
  };
  const callback = async (authorization, { clientId = CLIENT, code = 'test-code', headers = {}, error } = {}) => {
    const parameters = new URLSearchParams({ state: authorization.searchParams.get('state'), client_id: clientId, code });
    if (error) parameters.set('error', error);
    return request(`/auth/callback?${parameters}`, { headers: { cookie, ...headers } });
  };
  const login = async (options = {}) => {
    mock.login = { claims: options.claims || {}, tokens: options.tokens || {} };
    const authorization = await start(options.accountId ? { accountId: options.accountId } : {});
    const response = await callback(authorization, options);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?login=success');
    const data = await session(); assert.equal(data.loginError, null);
    return { account: data.account, authorization };
  };
  const key = async (name = 'Integration test') => {
    const response = await request('/api/keys', { method: 'POST', body: { name }, admin: true });
    assert.equal(response.status, 201); return response.json();
  };
  return { ...app, origin, dataDir, mock, remoteCalls, request, session, start, callback, login, key, get cookie() { return cookie; }, get csrf() { return csrf; } };
}

test('identity verification rejects forged or mismatched OIDC identities', async t => {
  const expected = { clientId: CLIENT, nonce: 'nonce-1', subject: 'subject-1' };
  assert.equal(verifyIdentity(jwt({ nonce: 'nonce-1' }), jwks, expected).sub, 'subject-1');
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['wrong issuer', jwt({ nonce: 'nonce-1', iss: 'https://attacker.test' })],
    ['wrong audience', jwt({ nonce: 'nonce-1', aud: 'other-client' })],
    ['multiple audiences without authorized party', jwt({ nonce: 'nonce-1', aud: [CLIENT, 'other-client'] })],
    ['wrong authorized party', jwt({ nonce: 'nonce-1', azp: 'other-client' })],
    ['wrong nonce', jwt({ nonce: 'wrong' })],
    ['missing nonce', jwt()],
    ['wrong subject', jwt({ nonce: 'nonce-1', sub: 'subject-2' })],
    ['expired', jwt({ nonce: 'nonce-1', exp: now - 60 })],
    ['future issued-at', jwt({ nonce: 'nonce-1', iat: now + 60 })],
    ['future not-before', jwt({ nonce: 'nonce-1', nbf: now + 60 })],
    ['unknown signing key', jwt({ nonce: 'nonce-1' }, { kid: 'unknown' })],
    ['unsupported signing algorithm', jwt({ nonce: 'nonce-1' }, { alg: 'none' })],
    ['unsupported critical header', jwt({ nonce: 'nonce-1' }, { crit: ['custom'] })],
  ];
  const genuine = jwt({ nonce: 'nonce-1' });
  const [header, , signature] = genuine.split('.');
  cases.push(['tampered payload', `${header}.${encode({ iss: AUTH, aud: CLIENT, sub: 'subject-1', nonce: 'nonce-1', iat: now, exp: now + 3600, admin: true })}.${signature}`]);
  for (const [name, token] of cases) await t.test(name, () => assert.throws(() => verifyIdentity(token, jwks, expected), error => error.status === 401 && error.code === 'invalid_id_token'));
  assert.equal(verifyIdentity(jwt({ nonce: 'nonce-1', aud: [CLIENT, 'other-client'], azp: CLIENT }), jwks, expected).sub, 'subject-1');
});

test('console and API routes enforce local session, CSRF, Host and origin', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/api/models')).status, 401);
  assert.equal((await h.request('/v1/models')).status, 401);
  assert.equal((await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'hello' } })).status, 401);
  const response = await h.request('/api/session');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  await h.session();
  assert.equal((await h.request('/api/auth/start', { method: 'POST', body: {}, headers: { cookie: h.cookie } })).status, 403);
  assert.equal((await h.request('/api/auth/start', { method: 'POST', body: {}, admin: true, headers: { 'x-local-csrf': 'wrong' } })).status, 403);
  assert.equal((await h.request('/api/auth/start', { method: 'POST', body: {}, admin: true, headers: { 'x-local-csrf': 'é'.repeat(h.csrf.length) } })).status, 403);
  for (const headers of [{ origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const rejected = await h.request('/api/session', { headers }); assert.equal(rejected.status, 403, JSON.stringify(headers));
  }
  // Native fetch rewrites Host; a raw request exercises the DNS rebinding guard.
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${h.origin}/api/session`, { headers: { host: 'attacker.test' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await h.request('/api/session', { headers: { origin: h.origin } })).status, 200);
  assert.equal(h.remoteCalls.length, 0);
});

test('OAuth uses PKCE, nonce, one-time browser-bound state and dynamic client registration', async t => {
  const h = await harness(t);
  const authorization = await h.start();
  assert.equal(authorization.origin, AUTH);
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('resource'), RESOURCE);
  assert.equal(authorization.searchParams.get('scope'), SCOPES);
  assert.equal(authorization.searchParams.get('redirect_uri'), `${h.origin}/auth/callback`);
  assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.ok(authorization.searchParams.get('nonce').length >= 32);
  const wrongBrowser = await h.callback(authorization, { headers: { cookie: 'pb_session=other-browser' } });
  assert.equal(wrongBrowser.status, 400);
  assert.equal(h.remoteCalls.filter(call => call.url === config.token_endpoint).length, 0);
  const response = await h.callback(authorization);
  assert.equal(response.headers.get('location'), '/?login=success');
  const tokenCall = h.remoteCalls.find(call => call.url === config.token_endpoint);
  assert.equal(tokenCall.form.get('client_id'), CLIENT);
  assert.equal(tokenCall.form.get('grant_type'), 'authorization_code');
  assert.equal(tokenCall.form.get('resource'), RESOURCE);
  assert.equal(tokenCall.form.get('redirect_uri'), `${h.origin}/auth/callback`);
  assert.equal(createHash('sha256').update(tokenCall.form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal((await h.callback(authorization)).status, 400);
  assert.equal(h.state.accounts.length, 1);
  assert.equal(h.state.accounts[0].client_id, CLIENT);
  assert.equal(h.state.accounts[0].subject, 'subject-1');
});

test('new OAuth attempts invalidate older state, denied callbacks cannot be replayed', async t => {
  const h = await harness(t);
  const first = await h.start(), second = await h.start();
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.equal((await h.callback(first)).status, 400);
  assert.equal((await h.callback(second, { error: 'access_denied' })).headers.get('location'), '/?login=error');
  assert.equal((await h.session()).loginError.code, 'authorization_denied');
  assert.equal((await h.callback(second)).status, 400);
  assert.equal(h.state.accounts.length, 0);
});

test('invalid nonce and a different reconnect client or account never replace saved identity', async t => {
  const h = await harness(t);
  const { account } = await h.login();
  const saved = JSON.stringify(h.state.accounts[0]);
  let authorization = await h.start({ accountId: account.id });
  assert.equal(authorization.searchParams.get('client_id'), CLIENT);
  assert.ok(authorization.searchParams.get('id_token_hint'));
  assert.equal((await h.callback(authorization, { clientId: 'wrong-client' })).headers.get('location'), '/?login=error');
  assert.equal((await h.session()).loginError.code, 'invalid_client_id');
  assert.equal(JSON.stringify(h.state.accounts[0]), saved);
  h.mock.login = { claims: { nonce: 'wrong-nonce' } };
  authorization = await h.start({ accountId: account.id });
  await h.callback(authorization);
  assert.equal((await h.session()).loginError.code, 'invalid_id_token');
  assert.equal(JSON.stringify(h.state.accounts[0]), saved);
  h.mock.login = { claims: { sub: 'someone-else' } };
  authorization = await h.start({ accountId: account.id });
  await h.callback(authorization);
  assert.equal((await h.session()).loginError.code, 'invalid_id_token');
  assert.equal(JSON.stringify(h.state.accounts[0]), saved);
});

test('credential persistence is private, atomically replaced and does not expose tokens in session', async t => {
  const h = await harness(t);
  await h.login();
  const issued = await h.key();
  const stateFile = join(h.dataDir, 'state.json');
  assert.equal(statSync(h.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.accounts[0].access_token, 'access-1');
  assert.equal(persisted.keys[0].hash, createHash('sha256').update(issued.key).digest('hex'));
  assert.ok(!readFileSync(stateFile, 'utf8').includes(issued.key));
  assert.deepEqual(readdirSync(h.dataDir), ['state.json']);
  const session = await h.session();
  const publicState = JSON.stringify(session);
  for (const secret of ['access-1', 'refresh-1', h.state.accounts[0].id_token, issued.key, persisted.keys[0].hash]) assert.ok(!publicState.includes(secret));
  assert.equal(session.keys[0].accountId, session.account.id);
  const reopened = createApp({ dataDir: h.dataDir, fetchImpl: () => assert.fail('reload must not contact upstream') });
  assert.equal(reopened.state.accounts[0].access_token, 'access-1');
  assert.equal(reopened.state.hostId, h.state.hostId);
});

test('malformed saved credentials are preserved instead of silently overwritten', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'planbridge-corrupt-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const stateFile = join(dataDir, 'state.json');
  writeFileSync(stateFile, '{broken', { mode: 0o600 });
  assert.throws(() => createApp({ dataDir }), /无法读取/);
  assert.equal(readFileSync(stateFile, 'utf8'), '{broken');
});

test('API keys remain bound to their account and become unusable after revocation', async t => {
  const h = await harness(t);
  const first = await h.login(), firstKey = await h.key('First');
  const second = await h.login({ clientId: 'second_client', claims: { sub: 'subject-2', email: 'second@example.test' }, tokens: { access_token: 'access-2' } });
  const secondKey = await h.key('Second');
  assert.notEqual(first.account.id, second.account.id);
  assert.equal(firstKey.record.accountId, first.account.id);
  assert.equal(secondKey.record.accountId, second.account.id);
  let response = await h.request('/v1/models', { headers: { authorization: `Bearer ${firstKey.key}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(model => model.id), ['gpt-test']);
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/models`).at(-1).headers.Authorization, 'Bearer access-1');
  response = await h.request('/v1/models', { headers: { authorization: `Bearer ${secondKey.key}` } });
  assert.equal(response.status, 200);
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/models`).at(-1).headers.Authorization, 'Bearer access-2');
  assert.ok(h.state.keys[0].lastUsedAt);
  assert.equal((await h.request(`/api/keys/${firstKey.record.id}`, { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await h.request('/v1/models', { headers: { authorization: `Bearer ${firstKey.key}` } })).status, 401);
  assert.equal((await h.request('/v1/models', { headers: { authorization: `Bearer ${secondKey.key}`, origin: 'https://attacker.test' } })).status, 403);
});

test('upstream receives the subscription Responses contract and non-streaming clients receive assembled text', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  const requestBody = { model: 'gpt-test', input: 'Hi', instructions: 'Be brief.', stream: false };
  const response = await h.request('/v1/responses', { method: 'POST', body: requestBody, headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.output_text, 'Hello');
  assert.equal(result.status, 'completed');
  assert.equal(result.usage.input_tokens, 11);
  const inferenceCall = h.remoteCalls.find(call => call.url === `${RESOURCE}/responses`);
  assert.deepEqual(JSON.parse(inferenceCall.body), { model: 'gpt-test', input: [{ role: 'user', content: 'Hi' }], instructions: 'Be brief.', stream: true, store: false });
  assert.equal(inferenceCall.headers.Authorization, 'Bearer access-1');
  assert.equal(inferenceCall.headers.Accept, 'text/event-stream');
  assert.equal(inferenceCall.redirect, 'error');
  assert.deepEqual(h.state.stats, { requests: 1, completed: 1, failed: 0, inputTokens: 11, outputTokens: 7 });
  assert.equal(h.state.logs[0].status, 'completed');
});

test('unsupported inputs fail locally before any inference request', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  for (const invalid of [
    { temperature: 0.2 }, { max_output_tokens: 10 }, { previous_response_id: 'previous' }, { store: true },
    { input: [{ role: 'system', content: 'Hidden system prompt' }] }, { input: [] }, { input: 5 },
    { tools: [{ type: 'web_search' }] }, { stream: 'true' }, { model: '' },
  ]) {
    const response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi', ...invalid }, headers: { authorization: `Bearer ${issued.key}` } });
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/responses`).length, 0);
  assert.deepEqual(normalizeRequest({ model: 'gpt-test', input: [{ role: 'developer', content: 'Be brief.' }], tools: [{ type: 'namespace', name: 'local', tools: [{ type: 'function', name: 'hello', parameters: { type: 'object' } }] }] }).store, false);
});

test('streaming success preserves event frames and reports completed usage', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  h.mock.responsesHandler = () => sseResponse(completed('你好'), { 'x-request-id': 'req-upstream' });
  const response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi', stream: true }, headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-request-id'), 'req-upstream');
  const stream = await response.text();
  assert.match(stream, /response\.completed/);
  assert.match(stream, /你好/);
  assert.equal(h.state.stats.completed, 1);
});

test('a terminal event finishes the request even if upstream keeps the stream open', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  let cancelled = false;
  h.mock.responsesHandler = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(completed('Finished').map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      // Deliberately leave the connection open after response.completed.
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await fetch(`${h.origin}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', input: 'Hi' }), signal: AbortSignal.timeout(1500) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output_text, 'Finished');
  assert.equal(cancelled, true);
  assert.equal(h.state.stats.completed, 1);
});

test('failed, incomplete and truncated upstream streams are never counted as completed', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  const cases = [
    { events: [{ type: 'response.failed', response: { id: 'failed', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Quota exhausted' } } }], expectedStatus: 429, expectedCode: 'subscription_sharing_usage_limit_exceeded' },
    { events: [{ type: 'response.incomplete', response: { id: 'incomplete', status: 'incomplete', incomplete_details: { reason: 'other' } } }], expectedStatus: 502, expectedCode: 'response_incomplete' },
    { events: [{ type: 'error', code: 'subscription_sharing_user_not_eligible', message: 'Not eligible' }], expectedStatus: 403, expectedCode: 'subscription_sharing_user_not_eligible' },
    { events: [{ type: 'response.output_text.delta', delta: 'Partial' }], expectedStatus: 502, expectedCode: 'stream_interrupted' },
    { events: ['data: not-json\n\n'], expectedStatus: 502, expectedCode: 'invalid_upstream_stream' },
  ];
  for (const { events, expectedStatus, expectedCode } of cases) {
    h.mock.responsesHandler = () => sseResponse(events);
    const response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi' }, headers: { authorization: `Bearer ${issued.key}` } });
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error.code, expectedCode);
    assert.equal(h.state.logs[0].status, 'failed');
    assert.equal(h.state.logs[0].errorCode, expectedCode);
  }
  assert.equal(h.state.stats.requests, cases.length);
  assert.equal(h.state.stats.failed, cases.length);
  assert.equal(h.state.stats.completed, 0);
  h.mock.responsesHandler = () => sseResponse([{ type: 'response.output_text.delta', delta: 'Partial' }]);
  const response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi', stream: true }, headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: error\ndata: .*stream_interrupted/);
  assert.equal(h.state.stats.completed, 0);
});

test('disconnecting a streaming client aborts upstream and records cancellation', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  let aborted = false;
  h.mock.responsesHandler = call => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n'));
      call.signal.addEventListener('abort', () => {
        aborted = true;
        controller.error(new DOMException('Request aborted', 'AbortError'));
      }, { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  await new Promise((resolve, reject) => {
    const request = http.request(`${h.origin}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' } }, response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.end(JSON.stringify({ model: 'gpt-test', input: 'Hi', stream: true }));
  });
  await eventually(() => h.state.logs.length === 1, 'cancelled request was not recorded');
  assert.equal(aborted, true);
  assert.equal(h.state.logs[0].errorCode, 'request_cancelled');
  assert.equal(h.state.stats.completed, 0);
  assert.equal(h.state.stats.failed, 1);
});

test('upstream HTTP errors preserve status, request ID and retry-after', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  h.mock.responsesHandler = () => jsonResponse({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Quota exhausted' } }, 429, { 'retry-after': '60', 'x-request-id': 'req-limit' });
  const response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi' }, headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.headers.get('x-request-id'), 'req-limit');
  assert.equal((await response.json()).error.code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(h.state.stats.failed, 1);
});

test('expired credentials refresh once for concurrent requests and rotate the refresh token', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  h.state.accounts[0].expires_at = Date.now() - 1;
  const entered = deferred(), release = deferred();
  let refreshCount = 0;
  h.mock.tokenHandler = async call => {
    assert.equal(call.form.get('grant_type'), 'refresh_token');
    assert.equal(call.form.get('client_id'), CLIENT);
    assert.equal(call.form.get('resource'), RESOURCE);
    refreshCount++;
    assert.equal(call.form.get('refresh_token'), refreshCount === 1 ? 'refresh-1' : 'refresh-rotated-1');
    entered.resolve();
    if (refreshCount === 1) await release.promise;
    return jsonResponse({ access_token: `access-rotated-${refreshCount}`, refresh_token: `refresh-rotated-${refreshCount}`, token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt() });
  };
  const invoke = () => h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi' }, headers: { authorization: `Bearer ${issued.key}` } });
  const one = invoke(), two = invoke();
  await entered.promise;
  // Give the other accepted connection a turn while refresh remains pending.
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(refreshCount, 1);
  release.resolve();
  const responses = await Promise.all([one, two]);
  for (const response of responses) { assert.equal(response.status, 200); await response.json(); }
  assert.equal(refreshCount, 1);
  assert.equal(h.state.accounts[0].refresh_token, 'refresh-rotated-1');
  assert.deepEqual(h.remoteCalls.filter(call => call.url === `${RESOURCE}/responses`).map(call => call.headers.Authorization), ['Bearer access-rotated-1', 'Bearer access-rotated-1']);
  h.state.accounts[0].expires_at = Date.now() - 1;
  const next = await invoke(); assert.equal(next.status, 200); await next.json();
  assert.equal(refreshCount, 2);
  assert.equal(JSON.parse(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).accounts[0].refresh_token, 'refresh-rotated-2');
});

test('terminal refresh failure clears credentials, while missing plan scope never reaches inference', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  h.state.accounts[0].expires_at = Date.now() - 1;
  h.mock.tokenHandler = () => jsonResponse({ error: 'invalid_grant' }, 400);
  let response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi' }, headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'reauthorization_required');
  for (const field of ['access_token', 'refresh_token', 'id_token', 'expires_at']) assert.equal(h.state.accounts[0][field], undefined);
  assert.equal((await h.session()).account.connected, false);
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/responses`).length, 0);
  h.mock.tokenHandler = null;
  await h.login({ accountId: h.state.accounts[0].id, tokens: { scope: 'openid profile email offline_access resource.invoke' } });
  assert.equal((await h.session()).account.planUsageEnabled, false);
  assert.equal((await h.request('/api/keys', { method: 'POST', body: {}, admin: true })).status, 401);
  response = await h.request('/v1/responses', { method: 'POST', body: { model: 'gpt-test', input: 'Hi' }, headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'plan_usage_not_authorized');
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/responses`).length, 0);
});

test('refresh requires a rotating refresh token and verifies any refreshed identity', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  h.state.accounts[0].expires_at = Date.now() - 1;
  const previous = { ...h.state.accounts[0] };
  h.mock.tokenHandler = () => jsonResponse({ access_token: 'rotated', token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
  let response = await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_token_response');
  assert.deepEqual(h.state.accounts[0], previous);
  h.mock.tokenHandler = () => jsonResponse({ access_token: 'rotated', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt({ sub: 'wrong-subject' }) });
  response = await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'invalid_id_token');
  for (const field of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'pending_refresh']) assert.equal(h.state.accounts[0][field], undefined);
  assert.equal(h.state.accounts[0].subject, previous.subject);
  assert.equal(h.state.accounts[0].token_version, previous.token_version + 1);
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/models`).length, 0);
});

test('logout revokes the latest refresh token and account removal deletes its API keys', async t => {
  const h = await harness(t);
  const { account } = await h.login(); const issued = await h.key();
  assert.equal((await h.request(`/api/accounts/${account.id}`, { method: 'DELETE', admin: true })).status, 409);
  const logout = await h.request('/api/auth/logout', { method: 'POST', body: { accountId: account.id }, admin: true });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).revoked, true);
  const revocation = h.remoteCalls.find(call => call.url === config.revocation_endpoint);
  assert.equal(revocation.form.get('token'), 'refresh-1');
  assert.equal(revocation.form.get('client_id'), CLIENT);
  assert.equal(revocation.form.get('token_type_hint'), 'refresh_token');
  assert.equal((await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } })).status, 401);
  assert.equal((await h.request(`/api/accounts/${account.id}`, { method: 'DELETE', admin: true })).status, 200);
  assert.equal(h.state.accounts.length, 0);
  assert.equal(h.state.keys.length, 0);
  assert.equal(h.state.activeAccountId, null);
  assert.equal((await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } })).status, 401);
});

test('an in-flight reconnect cannot commit after logout or a newer login attempt', async t => {
  for (const holdAt of ['token', 'jwks']) {
    for (const action of ['logout', 'new login']) {
      await t.test(`${holdAt} held during ${action}`, async t => {
        const h = await harness(t);
        const { account } = await h.login();
        const original = await h.start({ accountId: account.id });
        const entered = deferred(), release = deferred();
        const heldKey = { ...jwk, kid: 'held-reconnect-key' };
        h.mock.tokenHandler = async call => {
          const held = call.form.get('code') === 'held-code';
          const nonce = (held ? original : h.mock.latestAuth).searchParams.get('nonce');
          const response = jsonResponse({ access_token: held ? 'access-stale-reconnect' : 'access-new-reconnect', refresh_token: held ? 'refresh-stale-reconnect' : 'refresh-new-reconnect', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt({ nonce }, held ? { kid: heldKey.kid } : {}) });
          if (held && holdAt === 'token') { entered.resolve(); await release.promise; }
          return response;
        };
        h.mock.jwksHandler = async () => {
          if (holdAt === 'jwks') { entered.resolve(); await release.promise; }
          return jsonResponse({ keys: [jwk, heldKey] });
        };
        const staleCallback = h.callback(original, { code: 'held-code' });
        await entered.promise;
        if (action === 'logout') {
          const response = await h.request('/api/auth/logout', { method: 'POST', body: { accountId: account.id }, admin: true });
          assert.equal(response.status, 200);
          assert.equal(h.state.accounts[0].access_token, undefined);
        } else {
          const newest = await h.start({ accountId: account.id });
          const response = await h.callback(newest, { code: 'new-code' });
          assert.equal(response.headers.get('location'), '/?login=success');
          assert.equal(h.state.accounts[0].access_token, 'access-new-reconnect');
        }
        const authoritativeState = structuredClone(h.state.accounts[0]);
        release.resolve();
        const oldResponse = await staleCallback;
        assert.equal(oldResponse.status, 303);
        assert.equal(oldResponse.headers.get('location'), '/?login=error');
        assert.deepEqual(h.state.accounts[0], authoritativeState);
        assert.equal((await h.session()).loginError, null);
        assert.equal(h.state.accounts.length, 1);
      });
    }
  }
});

test('an old refresh success or terminal failure cannot alter freshly reconnected credentials', async t => {
  for (const outcome of ['success', 'terminal failure']) {
    await t.test(outcome, async t => {
      const h = await harness(t);
      const { account } = await h.login(); const issued = await h.key();
      h.state.accounts[0].expires_at = Date.now() - 1;
      const entered = deferred(), release = deferred();
      h.mock.tokenHandler = async call => {
        if (call.form.get('grant_type') === 'refresh_token') {
          entered.resolve(); await release.promise;
          if (outcome === 'terminal failure') return jsonResponse({ error: 'invalid_grant' }, 400);
          return jsonResponse({ access_token: 'access-stale-refresh', refresh_token: 'refresh-stale-refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt() });
        }
        return jsonResponse({ access_token: 'access-current-reconnect', refresh_token: 'refresh-current-reconnect', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt({ nonce: h.mock.latestAuth.searchParams.get('nonce') }) });
      };
      const staleRequest = h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } });
      await entered.promise;
      await h.login({ accountId: account.id });
      assert.equal(h.state.accounts[0].access_token, 'access-current-reconnect');
      const authoritativeState = structuredClone(h.state.accounts[0]);
      release.resolve();
      const response = await staleRequest;
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'credentials_changed');
      assert.deepEqual(h.state.accounts[0], authoritativeState);
      assert.equal(h.state.accounts[0].pending_refresh, undefined);
      assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/models`).length, 0);
      assert.equal(JSON.parse(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).accounts[0].refresh_token, 'refresh-current-reconnect');
    });
  }
});

test('temporary JWKS failure preserves rotated credentials for validation retry without spending another refresh token', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  const account = h.state.accounts[0];
  account.expires_at = Date.now() - 1;
  const version = account.token_version;
  let refreshRequests = 0, keyRequests = 0;
  const rotatedKey = { ...jwk, kid: 'rotated-refresh-key' };
  h.mock.tokenHandler = call => {
    assert.equal(call.form.get('grant_type'), 'refresh_token');
    assert.equal(call.form.get('refresh_token'), 'refresh-1');
    refreshRequests++;
    return jsonResponse({ access_token: 'access-after-key-rotation', refresh_token: 'refresh-after-key-rotation', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt({}, { kid: rotatedKey.kid }) });
  };
  h.mock.jwksHandler = () => {
    keyRequests++;
    if (keyRequests === 1) throw Error('Temporary key-server outage');
    return jsonResponse({ keys: [jwk, rotatedKey] });
  };
  let response = await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'upstream_unreachable');
  assert.equal(refreshRequests, 1);
  assert.equal(account.access_token, 'access-1');
  assert.equal(account.refresh_token, 'refresh-1');
  assert.equal(account.pending_refresh.version, version);
  assert.equal(account.pending_refresh.tokens.refresh_token, 'refresh-after-key-rotation');
  const saved = JSON.parse(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).accounts[0];
  assert.equal(saved.pending_refresh.tokens.access_token, 'access-after-key-rotation');
  assert.ok(!JSON.stringify(await h.session()).includes('refresh-after-key-rotation'));
  response = await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(response.status, 200); await response.json();
  assert.equal(refreshRequests, 1);
  assert.equal(keyRequests, 2);
  assert.equal(account.access_token, 'access-after-key-rotation');
  assert.equal(account.refresh_token, 'refresh-after-key-rotation');
  assert.equal(account.pending_refresh, undefined);
  assert.equal(account.token_version, version + 1);
  assert.equal(JSON.parse(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).accounts[0].pending_refresh, undefined);
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/models`).at(-1).headers.Authorization, 'Bearer access-after-key-rotation');
});

test('logout after a pending refresh revokes the replacement token and clears all pending credentials', async t => {
  const h = await harness(t);
  const { account: summary } = await h.login(); const issued = await h.key();
  const account = h.state.accounts[0];
  account.expires_at = Date.now() - 1;
  h.mock.tokenHandler = call => {
    assert.equal(call.form.get('grant_type'), 'refresh_token');
    assert.equal(call.form.get('refresh_token'), 'refresh-1');
    return jsonResponse({ access_token: 'pending-access', refresh_token: 'pending-replacement-refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt({}, { kid: 'pending-logout-key' }) });
  };
  h.mock.jwksHandler = () => { throw Error('Temporary key-server outage'); };
  const refreshAttempt = await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(refreshAttempt.status, 502);
  assert.equal((await refreshAttempt.json()).error.code, 'upstream_unreachable');
  assert.equal(account.refresh_token, 'refresh-1');
  assert.equal(account.pending_refresh.tokens.refresh_token, 'pending-replacement-refresh');
  assert.equal(account.pending_refresh.version, account.token_version);
  const response = await h.request('/api/auth/logout', { method: 'POST', body: { accountId: summary.id }, admin: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, true);
  const revocations = h.remoteCalls.filter(call => call.url === config.revocation_endpoint);
  assert.equal(revocations.length, 1);
  assert.equal(revocations[0].form.get('token'), 'pending-replacement-refresh');
  assert.equal(revocations[0].form.get('client_id'), CLIENT);
  for (const field of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'pending_refresh']) assert.equal(account[field], undefined);
  const persisted = JSON.parse(readFileSync(join(h.dataDir, 'state.json'), 'utf8')).accounts[0];
  assert.equal(persisted.pending_refresh, undefined);
  assert.equal(persisted.refresh_token, undefined);
  assert.equal((await h.session()).account.connected, false);
  assert.equal((await h.request('/v1/models', { headers: { authorization: `Bearer ${issued.key}` } })).status, 401);
});

test('a client disconnected during refresh never starts upstream inference', async t => {
  const h = await harness(t);
  await h.login(); const issued = await h.key();
  h.state.accounts[0].expires_at = Date.now() - 1;
  const entered = deferred(), release = deferred(), disconnected = deferred();
  h.server.on('request', (request, response) => {
    if (request.url === '/v1/responses') response.once('close', () => disconnected.resolve());
  });
  h.mock.tokenHandler = async call => {
    assert.equal(call.form.get('grant_type'), 'refresh_token');
    entered.resolve(); await release.promise;
    return jsonResponse({ access_token: 'access-after-disconnect', refresh_token: 'refresh-after-disconnect', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, id_token: jwt() });
  };
  const request = http.request(`${h.origin}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: 'gpt-test', input: 'Hi', stream: true }));
  await entered.promise;
  request.destroy();
  await disconnected.promise;
  release.resolve();
  await eventually(() => h.state.accounts[0].access_token === 'access-after-disconnect', 'pending refresh did not finish');
  await h.session();
  assert.equal(h.state.accounts[0].refresh_token, 'refresh-after-disconnect');
  assert.equal(h.remoteCalls.filter(call => call.url === `${RESOURCE}/responses`).length, 0);
  assert.equal(h.state.stats.requests, 0);
  assert.equal(h.state.logs.length, 0);
});
