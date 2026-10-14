import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createApp } from '../server.mjs';

const RESOURCE = 'https://api.openai.com/v1';
const LOCAL_KEY = 'pb_test_chat_compatibility';
const textResult = {
  id: 'resp_chat_test', object: 'response', status: 'completed', model: 'gpt-test',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] }],
  usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
};
function sse(events, headers = {}) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', ...headers } });
}
function untypedSse(events) {
  // Byte bodies preserve the real upstream case: no Content-Type header.
  return new Response(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
}
function textEvents(terminal = textResult) {
  return [
    { type: 'response.created', response: { id: terminal.id, model: terminal.model, created_at: 1700000000 } },
    { type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: 'world' },
    { type: 'response.completed', response: terminal },
  ];
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function eventually(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function harness(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'planbridge-chat-test-'));
  const remoteCalls = [];
  const mock = { responses: () => sse(textEvents()) };
  const app = createApp({ dataDir, fetchImpl: async (url, options = {}) => {
    const call = { url: String(url), ...options };
    remoteCalls.push(call);
    assert.equal(call.url, `${RESOURCE}/responses`, 'chat requests may only reach the official Responses endpoint');
    return mock.responses(call);
  } });
  app.state.accounts.push({ id: 'chat-account', subject: 'subject-chat', client_id: 'client-chat', access_token: 'access-chat-test', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expires_at: Date.now() + 3600000, token_version: 1 });
  app.state.activeAccountId = 'chat-account';
  app.state.keys.push({ id: 'chat-key', name: 'Chat test', accountId: 'chat-account', hash: createHash('sha256').update(LOCAL_KEY).digest('hex') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const request = (body = { model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }] }, headers = {}) => fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_KEY}`, ...headers }, body: JSON.stringify(body) });
  return { ...app, origin, remoteCalls, mock, request };
}
function frames(source) {
  return source.split(/\r?\n\r?\n/).filter(Boolean).map(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

test('Chat Completions requires the bound local API key and rejects foreign origins before inference', async t => {
  const h = await harness(t);
  for (const authorization of ['', 'Bearer access-chat-test', 'Bearer wrong-key']) {
    const response = await h.request(undefined, { authorization });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'invalid_api_key');
  }
  assert.equal((await h.request(undefined, { origin: 'https://attacker.test' })).status, 403);
  assert.equal(h.remoteCalls.length, 0);
});

test('invalid Chat requests and unsupported multi-choice generation stop before upstream inference', async t => {
  const h = await harness(t);
  const valid = { model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }] };
  const invalid = [
    null,
    { ...valid, model: '' },
    { ...valid, messages: [] },
    { ...valid, messages: [{ role: 'unknown-role', content: 'Hi' }] },
    { ...valid, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] },
    { ...valid, stream: 'true' },
    { ...valid, n: 2 },
  ];
  for (const body of invalid) {
    const response = await h.request(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok((await response.json()).error);
  }
  assert.equal(h.remoteCalls.length, 0);
  assert.equal(h.state.stats.requests, 0);
});

test('Cherry default parameters become a subscription-compatible Responses request and normal Chat JSON', async t => {
  const h = await harness(t);
  const response = await h.request({
    model: 'gpt-test', stream: false,
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }],
    temperature: 0.7, top_p: 1, max_tokens: 2048, max_completion_tokens: 4096,
    presence_penalty: 0, frequency_penalty: 0, n: 1,
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'chat.completion');
  assert.equal(data.model, 'gpt-test');
  assert.equal(data.choices.length, 1);
  assert.deepEqual(data.choices[0].message, { role: 'assistant', content: 'Hello world' });
  assert.equal(data.choices[0].finish_reason, 'stop');
  assert.equal(data.usage.prompt_tokens, 11);
  assert.equal(data.usage.completion_tokens, 7);
  assert.equal(data.usage.total_tokens, 18);
  assert.equal(data.usage.prompt_tokens_details.cached_tokens, 3);
  assert.equal(data.usage.completion_tokens_details.reasoning_tokens, 2);
  const ignored = response.headers.get('x-planbridge-ignored-parameters').split(',').map(name => name.trim()).sort();
  assert.deepEqual(ignored, ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty'].sort());
  const call = h.remoteCalls[0];
  assert.equal(call.headers.Authorization, 'Bearer access-chat-test');
  assert.equal(call.headers.Accept, 'text/event-stream');
  assert.equal(call.redirect, 'error');
  const payload = JSON.parse(call.body);
  assert.equal(payload.model, 'gpt-test');
  assert.equal(payload.stream, true);
  assert.equal(payload.store, false);
  assert.equal(payload.input[0].role, 'developer');
  for (const name of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'presence_penalty', 'frequency_penalty', 'n', 'messages']) assert.equal(payload[name], undefined, name);
  assert.deepEqual(h.state.stats, { requests: 1, completed: 1, failed: 0, inputTokens: 11, outputTokens: 7 });
});

test('Chat history and image parts reach Responses without losing turns or detail', async t => {
  const h = await harness(t);
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const response = await h.request({ model: 'gpt-test', messages: [
    { role: 'developer', content: 'Describe pictures.' },
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: [{ type: 'text', text: 'What is here?' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] },
  ] });
  assert.equal(response.status, 200); await response.json();
  const input = JSON.parse(h.remoteCalls[0].body).input;
  assert.deepEqual(input.map(item => item.role), ['developer', 'user', 'assistant', 'user']);
  assert.deepEqual(input[3].content, [{ type: 'input_text', text: 'What is here?' }, { type: 'input_image', image_url: image, detail: 'high' }]);
});

test('client function tools and call/result history map to the subscription namespace', async t => {
  const h = await harness(t);
  const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
  const response = await h.request({ model: 'gpt-test', tools: [{ type: 'function', function: { name: 'weather', description: 'Current weather', parameters, strict: true } }], tool_choice: 'auto', parallel_tool_calls: false, messages: [
    { role: 'user', content: 'Weather in Shanghai?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_weather_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] },
    { role: 'tool', tool_call_id: 'call_weather_1', content: '{"temperature":20}' },
    { role: 'user', content: 'Explain that result.' },
  ] });
  assert.equal(response.status, 200); await response.json();
  const payload = JSON.parse(h.remoteCalls[0].body);
  assert.equal(payload.tools[0].type, 'namespace');
  assert.equal(payload.tools[0].name, 'functions');
  assert.deepEqual(payload.tools[0].tools, [{ type: 'function', name: 'weather', description: 'Current weather', parameters, strict: true }]);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(payload.parallel_tool_calls, false);
  assert.deepEqual(payload.input[1], { type: 'function_call', call_id: 'call_weather_1', name: 'weather', namespace: 'functions', arguments: '{"city":"Shanghai"}' });
  assert.deepEqual(payload.input[2], { type: 'function_call_output', call_id: 'call_weather_1', output: '{"temperature":20}' });
});

test('legacy functions, named tool choice and audio input are rejected explicitly', async t => {
  const h = await harness(t);
  const basic = { model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }] };
  for (const body of [
    { ...basic, functions: [{ name: 'weather' }] },
    { ...basic, function_call: 'auto' },
    { ...basic, tool_choice: { type: 'function', function: { name: 'weather' } } },
    { ...basic, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } }] }] },
  ]) {
    const response = await h.request(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unsupported_capability');
  }
  assert.equal(h.remoteCalls.length, 0);
});

test('reasoning options and structured JSON output map to Responses settings', async t => {
  const h = await harness(t);
  const schema = { name: 'weather_result', strict: true, schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } };
  const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Return city as JSON' }], reasoning_effort: 'high', verbosity: 'low', response_format: { type: 'json_schema', json_schema: schema } });
  assert.equal(response.status, 200); await response.json();
  const payload = JSON.parse(h.remoteCalls[0].body);
  assert.deepEqual(payload.reasoning, { effort: 'high' });
  assert.deepEqual(payload.text, { verbosity: 'low', format: { type: 'json_schema', ...schema } });
});

test('tool argument deltas and reasoning text become Chat chunks without duplication at completion', async t => {
  for (const stream of [false, true]) {
    await t.test(`stream ${stream}`, async t => {
      const h = await harness(t);
      const item = { id: 'fc_weather', type: 'function_call', call_id: 'call_weather', namespace: 'functions', name: 'weather', arguments: '{"city":"Shanghai"}' };
      const terminal = { ...textResult, output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need current weather.' }] }, item] };
      h.mock.responses = () => sse([
        { type: 'response.reasoning_summary_text.delta', delta: 'Need current ' },
        { type: 'response.reasoning_summary_text.delta', delta: 'weather.' },
        { type: 'response.output_item.added', item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{"city":' },
        { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '"Shanghai"}' },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: terminal },
      ]);
      const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Weather?' }], stream });
      assert.equal(response.status, 200);
      if (stream) {
        const all = frames(await response.text());
        assert.equal(all.at(-1), '[DONE]');
        const choices = all.filter(item => item !== '[DONE]').flatMap(chunk => chunk.choices);
        assert.equal(choices.map(choice => choice.delta?.reasoning_content || '').join(''), 'Need current weather.');
        const calls = choices.flatMap(choice => choice.delta?.tool_calls || []);
        assert.equal(calls.filter(call => call.id === 'call_weather').length, 1);
        assert.ok(calls.every(call => call.index === 0));
        assert.equal(calls.map(call => call.function?.arguments || '').join(''), '{"city":"Shanghai"}');
        assert.equal(choices.filter(choice => choice.finish_reason === 'tool_calls').length, 1);
        assert.equal(choices.filter(choice => choice.finish_reason === 'stop').length, 0);
      } else {
        const data = await response.json();
        assert.deepEqual(data.choices[0].message, { role: 'assistant', content: null, reasoning_content: 'Need current weather.', tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] });
        assert.equal(data.choices[0].finish_reason, 'tool_calls');
      }
    });
  }
});

test('streaming Chat requests emit content chunks, one finish marker and DONE with optional usage', async t => {
  const h = await harness(t);
  const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const all = frames(await response.text());
  assert.equal(all.at(-1), '[DONE]');
  const chunks = all.filter(item => item !== '[DONE]');
  assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk'));
  assert.equal(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta?.content || '').join(''), 'Hello world');
  assert.equal(chunks.flatMap(chunk => chunk.choices).filter(choice => choice.finish_reason === 'stop').length, 1);
  const usage = chunks.find(chunk => chunk.choices.length === 0)?.usage;
  assert.equal(usage.prompt_tokens, 11);
  assert.equal(usage.completion_tokens, 7);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(h.state.stats.completed, 1);
});

test('valid Responses SSE without Content-Type works for Chat streaming and JSON clients', async t => {
  for (const stream of [false, true]) {
    await t.test(`stream ${stream}`, async t => {
      const h = await harness(t);
      h.mock.responses = () => {
        const response = untypedSse(textEvents());
        assert.equal(response.headers.get('content-type'), null);
        return response;
      };
      const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream });
      assert.equal(response.status, 200);
      if (stream) {
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        const all = frames(await response.text());
        assert.equal(all.at(-1), '[DONE]');
        assert.equal(all.filter(item => item !== '[DONE]').flatMap(chunk => chunk.choices).map(choice => choice.delta?.content || '').join(''), 'Hello world');
      } else {
        const data = await response.json();
        assert.equal(data.object, 'chat.completion');
        assert.equal(data.choices[0].message.content, 'Hello world');
        assert.equal(data.choices[0].finish_reason, 'stop');
      }
      assert.equal(h.state.stats.completed, 1);
      assert.equal(h.state.stats.failed, 0);
    });
  }
});

test('valid SSE without Content-Type also works for the native Responses route', async t => {
  for (const stream of [false, true]) {
    await t.test(`stream ${stream}`, async t => {
      const h = await harness(t);
      h.mock.responses = () => untypedSse(textEvents());
      const response = await fetch(`${h.origin}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_KEY}` }, body: JSON.stringify({ model: 'gpt-test', input: 'Hi', stream }) });
      assert.equal(response.status, 200);
      if (stream) {
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        const all = frames(await response.text());
        assert.equal(all.at(-1).type, 'response.completed');
        assert.equal(all.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), 'Hello world');
      } else {
        const data = await response.json();
        assert.equal(data.object, 'response');
        assert.equal(data.output_text, 'Hello world');
        assert.equal(data.status, 'completed');
      }
      assert.equal(h.state.stats.completed, 1);
      assert.equal(h.state.stats.failed, 0);
    });
  }
});

test('explicit JSON media type is still rejected despite HTTP 200 and SSE-shaped body', async t => {
  for (const route of ['chat', 'responses']) {
    for (const stream of [false, true]) {
      await t.test(`${route}, stream ${stream}`, async t => {
        const h = await harness(t);
        h.mock.responses = () => new Response(new TextEncoder().encode(textEvents().map(event => `data: ${JSON.stringify(event)}\n\n`).join('')), { headers: { 'content-type': 'application/json' } });
        const response = route === 'chat'
          ? await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream })
          : await fetch(`${h.origin}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_KEY}` }, body: JSON.stringify({ model: 'gpt-test', input: 'Hi', stream }) });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, 'invalid_upstream_stream');
        assert.equal(h.state.stats.completed, 0);
        assert.equal(h.state.stats.failed, 1);
      });
    }
  }
});

test('missing Content-Type never turns malformed or unfinished streams into success', async t => {
  for (const outcome of ['malformed', 'unfinished']) {
    for (const stream of [false, true]) {
      await t.test(`${outcome}, stream ${stream}`, async t => {
        const h = await harness(t);
        h.mock.responses = () => outcome === 'malformed'
          ? new Response(new TextEncoder().encode('data: {invalid JSON}\n\n'))
          : untypedSse([{ type: 'response.output_text.delta', delta: 'Partial' }]);
        const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream });
        const code = outcome === 'malformed' ? 'invalid_upstream_stream' : 'stream_interrupted';
        if (stream) {
          const source = await response.text();
          assert.ok(!source.includes('[DONE]'), source);
          assert.ok(!source.includes('"finish_reason":"stop"'), source);
          assert.ok(source.includes(code), source);
        } else {
          assert.equal(response.status, 502);
          assert.equal((await response.json()).error.code, code);
        }
        assert.equal(h.state.stats.completed, 0);
        assert.equal(h.state.stats.failed, 1);
      });
    }
  }
});

test('malformed completion terminals never count as successful Chat or Responses calls', async t => {
  const terminals = [
    { type: 'response.completed' },
    { type: 'response.completed', response: { ...textResult, status: 'failed' } },
    { type: 'response.completed', response: { ...textResult, status: 'incomplete' } },
  ];
  for (const [index, terminal] of terminals.entries()) {
    for (const route of ['chat', 'responses']) {
      for (const stream of [false, true]) {
        await t.test(`terminal ${index}, ${route}, stream ${stream}`, async t => {
          const h = await harness(t);
          h.mock.responses = () => untypedSse([{ type: 'response.output_text.delta', delta: 'Partial' }, terminal]);
          const response = route === 'chat'
            ? await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream })
            : await fetch(`${h.origin}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_KEY}` }, body: JSON.stringify({ model: 'gpt-test', input: 'Hi', stream }) });
          if (stream) {
            const source = await response.text();
            assert.ok(source.includes('invalid_upstream_stream'), source);
            assert.ok(!source.includes('[DONE]'), source);
            assert.ok(!source.includes('"finish_reason":"stop"'), source);
            assert.ok(!source.includes('"type":"response.completed"'), source);
          } else {
            assert.equal(response.status, 502);
            assert.equal((await response.json()).error.code, 'invalid_upstream_stream');
          }
          assert.equal(h.state.stats.completed, 0);
          assert.equal(h.state.stats.failed, 1);
          assert.equal(h.state.logs[0].errorCode, 'invalid_upstream_stream');
        });
      }
    }
  }
});

test('changed or shortened final tool arguments cannot produce successful Chat completion', async t => {
  for (const [name, finalArguments] of [['equal-length revision', '{"city":"Hangzhou"}'], ['shortened final', '{"city":"X"}']]) {
    for (const finalAt of ['output_item.done', 'response.completed']) {
      await t.test(`${name}, ${finalAt}`, async t => {
        const h = await harness(t);
        const item = { id: 'fc_consistency', type: 'function_call', call_id: 'call_consistency', name: 'weather', namespace: 'functions', arguments: '' };
        const finalItem = { ...item, arguments: finalArguments };
        h.mock.responses = () => sse([
          { type: 'response.output_item.added', item },
          { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{"city":"Shanghai"}' },
          ...(finalAt === 'output_item.done' ? [{ type: 'response.output_item.done', item: finalItem }] : []),
          { type: 'response.completed', response: { ...textResult, output: [finalItem] } },
        ]);
        const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Weather?' }], stream: true });
        const source = await response.text();
        assert.ok(source.includes('invalid_upstream_stream'), source);
        assert.ok(!source.includes('[DONE]'), source);
        assert.ok(!source.includes('"finish_reason":"stop"'), source);
        assert.ok(!source.includes('"finish_reason":"tool_calls"'), source);
        assert.equal(h.state.stats.completed, 0);
        assert.equal(h.state.stats.failed, 1);
        assert.equal(h.state.logs[0].errorCode, 'invalid_upstream_stream');
      });
    }
  }
});

test('subscription HTTP errors retain their code, request ID and retry hint for Chat clients', async t => {
  const h = await harness(t);
  h.mock.responses = () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Quota exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', 'x-request-id': 'request-chat-quota', 'retry-after': '30' } });
  const response = await h.request();
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(response.headers.get('x-request-id'), 'request-chat-quota');
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(h.state.stats.completed, 0);
});

test('failed and interrupted Responses streams never become successful Chat completions', async t => {
  for (const outcome of ['failed', 'interrupted']) {
    for (const stream of [false, true]) {
      await t.test(`${outcome}, stream ${stream}`, async t => {
        const h = await harness(t);
        h.mock.responses = () => sse([
          { type: 'response.output_text.delta', delta: 'Partial' },
          ...(outcome === 'failed' ? [{ type: 'response.failed', response: { id: 'resp_failed', status: 'failed', error: { code: 'server_error', message: 'Failed after partial output' } } }] : []),
        ]);
        const response = await h.request({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream });
        if (stream) {
          const source = await response.text();
          assert.ok(!source.includes('[DONE]'), source);
          assert.ok(!source.includes('"finish_reason":"stop"'), source);
          assert.match(source, /error|stream_interrupted/);
        } else {
          assert.ok(response.status >= 400, String(response.status));
          assert.ok((await response.json()).error);
        }
        assert.equal(h.state.stats.completed, 0);
        assert.equal(h.state.stats.failed, 1);
      });
    }
  }
});

test('disconnecting a streaming Chat client cancels upstream inference', async t => {
  const h = await harness(t);
  const entered = deferred(), aborted = deferred();
  let signal;
  h.mock.responses = call => {
    signal = call.signal;
    call.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'First' })}\n\n`));
      entered.resolve();
      call.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const request = http.request(`${h.origin}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.on('response', response => { response.once('data', () => request.destroy()); });
  request.end(JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream: true }));
  await entered.promise;
  await aborted.promise;
  assert.equal(signal.aborted, true);
  await eventually(() => h.state.stats.requests === 1, 'cancelled Chat request was not recorded');
  assert.equal(h.state.stats.failed, 1);
  assert.equal(h.state.stats.completed, 0);
  assert.equal(h.state.logs[0].errorCode, 'request_cancelled');
});
