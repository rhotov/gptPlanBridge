import { randomUUID } from 'node:crypto';

const OMIT = new Set(['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'logprobs', 'top_logprobs', 'user', 'metadata']);
const ACCEPT = new Set(['model', 'messages', 'stream', 'stream_options', 'n', 'store', 'reasoning_effort', 'verbosity', 'response_format', 'tools', 'tool_choice', 'parallel_tool_calls']);
const NS = 'functions';
function invalid(message, code = 'invalid_request') {
  const error = new Error(message); error.status = 400; error.code = code; throw error;
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function content(value, role) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('messages 中的 content 必须为文本或内容数组。');
  return value.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    if (part?.type === 'image_url' && role === 'user' && typeof part.image_url?.url === 'string') {
      return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    }
    invalid(`聊天兼容接口暂不支持 ${part?.type || '未知'} 内容。`, 'unsupported_capability');
  });
}

export function chatRequestToResponses(body) {
  if (!object(body)) invalid('请求必须是 JSON 对象。');
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('请选择模型。');
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages 必须包含至少一条消息。');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream 必须是布尔值。');
  if (body.n !== undefined && body.n !== 1) invalid('订阅接口一次只能返回一个结果，请使用 n: 1。', 'unsupported_capability');
  if (body.store === true) invalid('订阅接口必须使用 store: false。', 'unsupported_capability');
  for (const key of Object.keys(body)) if (!OMIT.has(key) && !ACCEPT.has(key)) invalid(`聊天兼容接口暂不支持 ${key}。`, 'unsupported_capability');
  if (body.stream_options !== undefined && (!object(body.stream_options) || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) invalid('stream_options 格式无效。');
  const input = [];
  for (const message of body.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) invalid('messages 中存在不支持的角色。');
    if (message.function_call) invalid('请使用 tool_calls，旧版 function_call 不受支持。', 'unsupported_capability');
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) invalid('工具结果缺少 tool_call_id。');
      const result = content(message.content, 'tool');
      if (Array.isArray(result) && result.some(part => part.type !== 'input_text')) invalid('工具结果仅支持文本。');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof result === 'string' ? result : result.map(part => part.text).join('\n') });
      continue;
    }
    const role = message.role === 'system' ? 'developer' : message.role;
    const calls = message.tool_calls;
    if (calls !== undefined && (role !== 'assistant' || !Array.isArray(calls))) invalid('tool_calls 只支持 assistant 消息中的数组。');
    if (message.content != null) input.push({ role, content: content(message.content, role) });
    else if (!calls?.length) invalid('消息缺少 content。');
    for (const call of calls || []) {
      if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') invalid('工具调用格式无效。');
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, namespace: NS, arguments: call.function.arguments });
    }
  }
  const payload = { model: body.model, input, stream: body.stream === true, store: false };
  if (body.reasoning_effort != null) {
    if (typeof body.reasoning_effort !== 'string') invalid('reasoning_effort 必须是字符串。');
    payload.reasoning = { effort: body.reasoning_effort };
  }
  if (body.verbosity != null) payload.text = { verbosity: body.verbosity };
  if (body.response_format != null) {
    const format = body.response_format;
    if (!object(format)) invalid('response_format 格式无效。');
    if (format.type === 'json_object' || format.type === 'text') payload.text = { ...payload.text, format: { type: format.type } };
    else if (format.type === 'json_schema' && object(format.json_schema)) payload.text = { ...payload.text, format: { type: 'json_schema', ...format.json_schema } };
    else invalid('response_format 仅支持 text、json_object 和 json_schema。', 'unsupported_capability');
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) invalid('tools 必须为数组。');
    const tools = body.tools.map(tool => {
      const fn = tool?.function;
      if (tool?.type !== 'function' || !object(fn) || typeof fn.name !== 'string' || !fn.name) invalid('聊天兼容接口只支持客户端 function 工具。', 'unsupported_capability');
      return { type: 'function', name: fn.name, ...(typeof fn.description === 'string' ? { description: fn.description } : {}), parameters: fn.parameters || { type: 'object', properties: {} }, strict: fn.strict ?? false };
    });
    if (tools.length) payload.tools = [{ type: 'namespace', name: NS, description: 'Functions executed by the chat client.', tools }];
  }
  if (body.tool_choice !== undefined) {
    if (!['auto', 'none', 'required'].includes(body.tool_choice)) invalid('tool_choice 暂支持 auto、none 或 required。', 'unsupported_capability');
    payload.tool_choice = body.tool_choice;
  }
  if (body.parallel_tool_calls !== undefined) payload.parallel_tool_calls = body.parallel_tool_calls;
  return { payload, ignored: Object.keys(body).filter(key => OMIT.has(key)) };
}

function usage(response) {
  const u = response?.usage;
  if (!u) return undefined;
  return { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0)), ...(u.input_tokens_details ? { prompt_tokens_details: u.input_tokens_details } : {}), ...(u.output_tokens_details ? { completion_tokens_details: u.output_tokens_details } : {}) };
}
function outputText(response) { return (response?.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join(''); }
function refusalText(response) { return (response?.output || []).flatMap(item => item.content || []).filter(part => part.type === 'refusal').map(part => part.refusal || '').join(''); }
function reasoning(response) { return (response?.output || []).filter(item => item.type === 'reasoning').flatMap(item => item.summary || []).map(part => part.text || '').join(''); }
function functionCalls(response) { return (response?.output || []).filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '' } })); }
const frame = data => `data: ${JSON.stringify(data)}\n\n`;

export class ChatCompletionAdapter {
  constructor(model, { includeUsage = false } = {}) {
    this.model = model; this.includeUsage = includeUsage; this.id = `chatcmpl-${randomUUID()}`;
    this.created = Math.floor(Date.now() / 1000); this.started = false; this.textSeen = false; this.reasoningSeen = false;
    this.calls = new Map(); this.sentArguments = new Map();
  }
  chunk(delta, finish = null, extra = {}) {
    return frame({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  }
  start() {
    if (this.started) return [];
    this.started = true; return [this.chunk({ role: 'assistant', content: '' })];
  }
  tool(item, final = false) {
    const key = item.id || item.call_id;
    let call = this.calls.get(key), frames = [];
    if (!call) {
      call = { index: this.calls.size, id: item.call_id, name: item.name };
      this.calls.set(key, call); this.sentArguments.set(key, '');
      frames.push(...this.start(), this.chunk({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
    }
    const sent = this.sentArguments.get(key) || '';
    if (final && (typeof item.arguments !== 'string' || !item.arguments.startsWith(sent))) invalid('工具参数流不一致。', 'invalid_upstream_stream');
    if (typeof item.arguments === 'string' && item.arguments.length > sent.length && (final || !sent)) {
      if (!item.arguments.startsWith(sent)) invalid('工具参数流不一致。', 'invalid_upstream_stream');
      const delta = item.arguments.slice(sent.length); this.sentArguments.set(key, item.arguments);
      frames.push(this.chunk({ tool_calls: [{ index: call.index, function: { arguments: delta } }] }));
    }
    return frames;
  }
  event(event) {
    if (event.type === 'response.created' && typeof event.response?.model === 'string') this.model = event.response.model;
    if (event.type === 'response.output_text.delta') { this.textSeen = true; return [...this.start(), this.chunk({ content: event.delta || '' })]; }
    if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(event.type)) { this.reasoningSeen = true; return [...this.start(), this.chunk({ reasoning_content: event.delta || '' })]; }
    if (event.type === 'response.refusal.delta') { this.textSeen = true; return [...this.start(), this.chunk({ content: event.delta || '', refusal: event.delta || '' })]; }
    if (['response.output_item.added', 'response.output_item.done'].includes(event.type) && event.item?.type === 'function_call') return this.tool(event.item, event.type.endsWith('.done'));
    if (event.type === 'response.function_call_arguments.delta') {
      const call = this.calls.get(event.item_id);
      if (!call) invalid('工具参数流缺少对应调用。', 'invalid_upstream_stream');
      this.sentArguments.set(event.item_id, (this.sentArguments.get(event.item_id) || '') + (event.delta || ''));
      return [this.chunk({ tool_calls: [{ index: call.index, function: { arguments: event.delta || '' } }] })];
    }
    return [];
  }
  finish(response, fallback = '') {
    const calls = functionCalls(response), refusal = refusalText(response), text = outputText(response) || fallback || refusal;
    const summary = reasoning(response);
    return { id: this.id, object: 'chat.completion', created: this.created, model: response?.model || this.model, choices: [{ index: 0, message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(refusal ? { refusal } : {}), ...(summary ? { reasoning_content: summary } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], ...(usage(response) ? { usage: usage(response) } : {}) };
  }
  completedSSE(response) {
    const frames = this.start();
    if (!this.textSeen && (outputText(response) || refusalText(response))) frames.push(this.chunk({ content: outputText(response) || refusalText(response) }));
    if (!this.reasoningSeen && reasoning(response)) frames.push(this.chunk({ reasoning_content: reasoning(response) }));
    for (const item of response?.output || []) if (item.type === 'function_call') frames.push(...this.tool(item, true));
    frames.push(this.chunk({}, this.calls.size ? 'tool_calls' : 'stop'));
    if (this.includeUsage && usage(response)) frames.push(frame({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: response?.model || this.model, choices: [], usage: usage(response) }));
    frames.push('data: [DONE]\n\n'); return frames;
  }
  error(code, message) { return frame({ error: { code, message, type: 'upstream_error' } }); }
}
