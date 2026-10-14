'use strict';

const $ = (id) => document.getElementById(id);
const state = { session: null, models: [], modelSignature: null, selectedCode: 'curl', running: false, controller: null, secret: null, output: '', popup: null, authPoll: null, refreshing: false };
const numberFormat = new Intl.NumberFormat('zh-CN');
let toastTimer;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast-message').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').querySelector('.toast-icon').textContent = error ? '!' : '✓';
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}

function setAlert(message) {
  $('session-alert').textContent = message || '';
  $('session-alert').hidden = !message;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (!state.session?.csrf) throw new Error('本地会话尚未就绪，请稍后重试。');
    headers['X-Local-CSRF'] = state.session.csrf;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || `请求失败（${response.status}）`);
    error.code = data.error?.code || data.code;
    throw error;
  }
  return data;
}

function textCell(value, className) {
  const cell = document.createElement('td');
  cell.textContent = value ?? '—';
  if (className) cell.className = className;
  return cell;
}

function shortDate(value) {
  if (!value) return '尚未使用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function connected() { return Boolean(state.session?.account?.connected); }
function planReady() { return connected() && Boolean(state.session?.account?.planUsageEnabled); }

function renderSession() {
  const session = state.session;
  if (!session) return;
  const account = session.account;
  const isConnected = connected();
  const canUsePlan = planReady();
  $('base-url').textContent = session.baseUrl;
  $('connection-badge').className = `badge${isConnected ? '' : ' muted'}`;
  $('connection-badge').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot';
  $('connection-badge').append(dot, document.createTextNode(isConnected ? '已连接' : '未连接'));
  $('connection-title').textContent = isConnected ? (account.name ? `${account.name}，已连接` : '账户已成功连接') : '把账户连接到工作流';
  $('connection-description').textContent = isConnected
    ? (canUsePlan ? `${account.email || 'ChatGPT 账户'} · 已获得订阅用量授权，可开始本地调用。` : `${account.email || 'ChatGPT 账户'} · 尚未获得订阅用量授权，请重新登录检查权限。`)
    : '使用官方 ChatGPT 登录，连接你已获授权的模型与订阅用量。';
  $('login-btn').querySelector('span').textContent = isConnected ? '重新连接 ChatGPT' : 'Continue with ChatGPT';
  $('logout-btn').hidden = !isConnected;
  $('create-key-btn').disabled = !canUsePlan;
  $('empty-create-key-btn').disabled = !canUsePlan;
  $('create-key-btn').title = canUsePlan ? '创建绑定当前账户的本地密钥' : '请先连接具备订阅用量授权的账户';
  $('empty-create-key-btn').title = $('create-key-btn').title;
  const stats = session.stats || {};
  $('metric-requests').textContent = numberFormat.format(stats.requests || 0);
  $('metric-completed').textContent = numberFormat.format(stats.completed || 0);
  $('metric-input').textContent = numberFormat.format(stats.inputTokens || 0);
  $('metric-output').textContent = numberFormat.format(stats.outputTokens || 0);
  $('metric-keys').textContent = numberFormat.format(session.keys?.length || 0);
  renderKeys(session.keys || []);
  renderAccounts(session.accounts || []);
  renderLogs(session.logs || []);
  if (session.loginError) setAlert(`${session.loginError.message || '账户登录未完成，请重试。'}${session.loginError.code ? `（${session.loginError.code}）` : ''}`);
  const signature = account ? JSON.stringify([account.id, account.connected, account.planUsageEnabled, account.expiresAt]) : 'none';
  if (signature !== state.modelSignature) {
    state.modelSignature = signature;
    void loadModels(signature);
  }
  updateRunButton();
  renderCode();
}

function renderKeys(keys) {
  const fragment = document.createDocumentFragment();
  for (const key of keys) {
    const row = document.createElement('tr');
    const name = textCell(key.name || '未命名密钥');
    const owner = state.session.accounts?.find((account) => account.id === key.accountId);
    if (owner) {
      const metadata = document.createElement('div'); metadata.className = 'key-name-meta'; metadata.textContent = owner.email || owner.name || '绑定的 ChatGPT 账户'; name.append(metadata);
    }
    const prefix = document.createElement('td'); const code = document.createElement('code'); code.textContent = `${key.prefix || 'pb_'}••••••••`; prefix.append(code);
    const actionCell = document.createElement('td'); actionCell.className = 'action-cell';
    const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'revoke-button'; revoke.textContent = '撤销'; revoke.setAttribute('aria-label', `撤销密钥 ${key.name || ''}`);
    revoke.addEventListener('click', async () => {
      if (!window.confirm(`撤销「${key.name || '这把密钥'}」后，使用它的应用将无法继续调用。确定撤销？`)) return;
      revoke.disabled = true;
      try { await request(`/api/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); toast('密钥已撤销'); await refreshSession(); }
      catch (error) { toast(error.message, true); revoke.disabled = false; }
    });
    actionCell.append(revoke);
    row.append(name, prefix, textCell(shortDate(key.createdAt)), textCell(shortDate(key.lastUsedAt)), actionCell); fragment.append(row);
  }
  $('keys-body').replaceChildren(fragment);
  $('keys-empty').hidden = keys.length > 0;
}

function renderAccounts(accounts) {
  $('accounts-panel').hidden = accounts.length === 0;
  const fragment = document.createDocumentFragment();
  for (const account of accounts) {
    const selected = state.session.account?.id === account.id;
    const card = document.createElement('div'); card.className = `account-item${selected ? ' selected' : ''}`;
    const main = document.createElement('div'); main.className = 'account-main';
    const name = document.createElement('strong'); name.textContent = account.name || account.email || 'ChatGPT 账户';
    const status = document.createElement('span'); status.className = `badge${account.connected ? '' : ' muted'}`; status.textContent = selected ? '当前账户' : account.connected ? '已连接' : '已断开';
    main.append(name, status);
    const email = document.createElement('div'); email.className = 'account-email'; email.textContent = account.email || account.id;
    const actions = document.createElement('div'); actions.className = 'account-actions';
    if (!selected) {
      const select = document.createElement('button'); select.type = 'button'; select.textContent = '设为当前';
      select.addEventListener('click', async () => { select.disabled = true; try { await request('/api/accounts/select', { method: 'POST', body: { accountId: account.id } }); toast('已切换当前账户'); await refreshSession(); } catch (error) { toast(error.message, true); select.disabled = false; } });
      actions.append(select);
    }
    const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.textContent = '重新连接'; reconnect.addEventListener('click', () => startLogin(account.id, reconnect)); actions.append(reconnect);
    if (account.connected) {
      const disconnect = document.createElement('button'); disconnect.type = 'button'; disconnect.textContent = '断开连接';
      disconnect.addEventListener('click', async () => {
        disconnect.disabled = true;
        try { const result = await request('/api/auth/logout', { method: 'POST', body: { accountId: account.id } }); toast(result.message || '账户连接已断开'); await refreshSession(); }
        catch (error) { toast(error.message, true); disconnect.disabled = false; }
      });
      actions.append(disconnect);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-account'; remove.textContent = '移除';
    remove.disabled = Boolean(account.connected);
    remove.title = account.connected ? '请先断开连接，再移除账户记录' : '移除账户及其绑定的本地密钥';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`移除账户「${account.email || account.name || 'ChatGPT 账户'}」的记录，以及绑定它的所有本地 API 密钥？`)) return;
      remove.disabled = true;
      try { await request(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' }); toast('账户已移除'); await refreshSession(); }
      catch (error) { toast(error.message, true); remove.disabled = false; }
    });
    actions.append(remove); card.append(main, email, actions); fragment.append(card);
  }
  $('accounts-list').replaceChildren(fragment);
}

function renderLogs(logs) {
  const fragment = document.createDocumentFragment();
  for (const log of logs.slice(0, 8)) {
    const row = document.createElement('tr');
    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    const done = log.status === 'completed' || log.status === 'success';
    const failed = ['failed', 'error', 'incomplete', 'cancelled'].includes(log.status);
    status.className = `log-status${failed ? ' failed' : done ? '' : ' pending'}`;
    status.textContent = done ? '已完成' : log.status === 'cancelled' ? '已停止' : failed ? '未完成' : '处理中';
    if (log.errorCode) status.title = log.errorCode;
    statusCell.append(status);
    const id = textCell(log.id, 'log-id'); id.title = log.id || '';
    row.append(textCell(shortDate(log.at)), textCell(log.model), statusCell, textCell(log.durationMs == null ? '—' : `${(Number(log.durationMs) / 1000).toFixed(2)} s`), id); fragment.append(row);
  }
  $('logs-body').replaceChildren(fragment);
  $('logs-empty').hidden = logs.length > 0;
}

async function refreshSession({ notify = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh-btn').classList.add('refreshing');
  try {
    state.session = await request('/api/session');
    renderSession();
    if (notify) toast('工作区状态已刷新');
  } catch (error) {
    setAlert(`无法连接本地服务：${error.message}`);
    if (notify) toast(error.message, true);
  } finally { state.refreshing = false; $('refresh-btn').classList.remove('refreshing'); }
}

async function loadModels(signature) {
  const previous = $('model-select').value;
  state.models = [];
  $('model-select').replaceChildren(new Option(planReady() ? '正在加载账户可用模型…' : '连接账户后加载模型', ''));
  $('model-select').disabled = true;
  $('model-help').textContent = planReady() ? '正在获取当前账户授权的模型。' : connected() ? '当前账户尚未获得订阅用量授权，请重新连接并确认权限。' : '先连接 ChatGPT，模型列表将根据实际授权加载。';
  updateRunButton();
  if (!planReady()) return;
  try {
    const data = await request('/api/models');
    if (signature !== state.modelSignature) return;
    state.models = (data.models || []).filter((model) => model.slug);
    if (!state.models.length) {
      $('model-select').replaceChildren(new Option('当前授权未返回可用模型', ''));
      $('model-help').textContent = '当前账户未返回可用模型。请确认账户权限，或稍后重新连接。';
      return;
    }
    $('model-select').replaceChildren(...state.models.map((model) => new Option(model.display_name || model.slug, model.slug)));
    if (state.models.some((model) => model.slug === previous)) $('model-select').value = previous;
    $('model-select').disabled = state.running;
    $('model-help').textContent = '模型列表来自当前账户的实际授权。';
    renderCode();
  } catch (error) {
    if (signature !== state.modelSignature) return;
    $('model-select').replaceChildren(new Option('模型暂时不可用', ''));
    $('model-help').textContent = error.message;
  } finally { updateRunButton(); }
}

async function startLogin(accountId, sourceButton = $('login-btn')) {
  if (!state.session?.csrf) { toast('本地会话尚未就绪，请稍后重试。', true); return; }
  if (state.popup && !state.popup.closed) state.popup.close();
  const popup = window.open('about:blank', 'planbridge-auth', 'popup,width=600,height=740');
  if (!popup) { toast('浏览器拦截了授权窗口，请允许此本地站点打开弹窗。', true); return; }
  state.popup = popup;
  sourceButton.disabled = true;
  try {
    const data = await request('/api/auth/start', { method: 'POST', body: accountId ? { accountId } : {} });
    const url = new URL(data.url);
    if (url.protocol !== 'https:') throw new Error('授权地址无效，请检查本地服务配置。');
    popup.location.href = url.href;
    setAlert('授权窗口已打开，请在 ChatGPT 页面完成登录。本页会自动更新连接状态。');
    clearInterval(state.authPoll);
    const initialSignature = state.modelSignature;
    let polls = 0;
    state.authPoll = setInterval(async () => {
      polls += 1;
      await refreshSession();
      if (popup.closed || state.modelSignature !== initialSignature || polls >= 300) {
        clearInterval(state.authPoll); state.authPoll = null;
        if (!state.session?.loginError) setAlert('');
        if (state.modelSignature !== initialSignature && connected()) toast('ChatGPT 账户已连接');
      }
    }, 2000);
  } catch (error) { popup.close(); setAlert(error.message); toast(error.message, true); }
  finally { sourceButton.disabled = false; }
}

async function logout() {
  if (!state.session?.account) return;
  $('logout-btn').disabled = true;
  try {
    const data = await request('/api/auth/logout', { method: 'POST', body: { accountId: state.session.account.id } });
    toast(data.message || '账户连接已断开'); setAlert(''); await refreshSession();
  } catch (error) { toast(error.message, true); }
  finally { $('logout-btn').disabled = false; }
}

function openKeyDialog() {
  if (!planReady()) { toast('请先连接具备订阅用量授权的 ChatGPT 账户。', true); return; }
  clearSecret();
  $('key-create-fields').hidden = false;
  $('key-reveal').hidden = true;
  $('key-dialog-title').textContent = '创建 API 密钥';
  $('key-form-error').hidden = true;
  $('key-account-note').textContent = `绑定账户：${state.session.account.email || state.session.account.name || '当前 ChatGPT 账户'}。切换账户不会改变这把密钥的绑定。`;
  $('key-dialog').showModal();
  $('key-name').focus();
  $('key-name').select();
}

function clearSecret() { state.secret = null; $('key-secret').textContent = ''; }
function closeKeyDialog() { clearSecret(); $('key-dialog').close(); }

async function createKey(event) {
  event.preventDefault();
  if (!$('key-reveal').hidden) return;
  const name = $('key-name').value.trim();
  if (!name) { $('key-name').focus(); return; }
  $('confirm-create-key').disabled = true;
  $('key-form-error').hidden = true;
  try {
    const data = await request('/api/keys', { method: 'POST', body: { name } });
    if (typeof data.key !== 'string' || !data.key) throw new Error('服务未返回完整密钥，请检查调用结果。');
    if ($('key-dialog').open) {
      state.secret = data.key;
      $('key-secret').textContent = state.secret;
      $('key-create-fields').hidden = true;
      $('key-reveal').hidden = false;
      $('key-dialog-title').textContent = '密钥已创建';
      $('copy-key-secret').focus();
    } else toast('密钥已创建，但窗口已关闭。请撤销此密钥后重新创建。', true);
    await refreshSession();
  } catch (error) { $('key-form-error').textContent = error.message; $('key-form-error').hidden = false; }
  finally { $('confirm-create-key').disabled = false; }
}

async function copyText(value, message = '已复制') {
  if (!value) return;
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch { toast('浏览器未允许复制，请选中文本后手动复制。', true); }
}

function updateRunButton() {
  const ready = planReady() && Boolean($('model-select').value) && Boolean($('prompt-input').value.trim());
  $('run-btn').disabled = state.running || !ready;
  $('cancel-btn').hidden = !state.running;
  $('model-select').disabled = state.running || !state.models.length;
  $('prompt-input').disabled = state.running;
  $('instructions-input').disabled = state.running;
  $('playground-badge').className = `badge${state.running || ready ? '' : ' muted'}`;
  $('playground-badge').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot';
  $('playground-badge').append(dot, document.createTextNode(state.running ? '正在生成' : ready ? '可以运行' : '等待连接'));
  if (!state.running && !$('output-empty').hidden) $('run-state').textContent = ready ? '准备就绪' : '等待账户与模型连接';
}

function responseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output || []).flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text || '').join('');
}

async function runRequest() {
  if (state.running || !planReady() || !$('model-select').value) return;
  state.running = true; state.controller = new AbortController(); state.output = '';
  $('output-text').textContent = ''; $('output-text').hidden = false; $('output-empty').hidden = true; $('output-error').hidden = true;
  $('copy-output-btn').disabled = true; $('run-state').textContent = '正在连接…'; $('run-usage').textContent = 'stream: true · store: false'; $('run-duration').textContent = '';
  updateRunButton();
  const started = performance.now();
  let terminal = null;
  let usage = null;
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
  const durationTimer = setInterval(() => { $('run-duration').textContent = elapsed(); }, 200);
  function handleEvent(rawEvent) {
    let eventName = '';
    const dataLines = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length || dataLines.join('\n') === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(dataLines.join('\n')); } catch { throw new Error('收到无法解析的流式响应。'); }
    const type = payload.type || eventName;
    if (type === 'response.output_text.delta') {
      state.output += payload.delta || '';
      $('output-text').textContent = state.output; $('run-state').textContent = '正在生成…';
      $('copy-output-btn').disabled = !state.output;
      $('output-text').scrollTop = $('output-text').scrollHeight;
    } else if (type === 'response.completed') {
      const fullText = responseText(payload.response);
      if (fullText) { state.output = fullText; $('output-text').textContent = state.output; }
      usage = payload.response?.usage;
      terminal = 'completed';
    } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      terminal = type === 'response.incomplete' ? 'incomplete' : 'failed';
      throw new Error(payload.response?.error?.message || payload.error?.message || payload.message || (terminal === 'incomplete' ? `响应未完成：${payload.response?.incomplete_details?.reason || '请稍后重试。'}` : '模型响应失败，请检查账户授权或稍后重试。'));
    }
  }
  try {
    const body = { model: $('model-select').value, input: [{ role: 'user', content: $('prompt-input').value.trim() }], stream: true, store: false };
    const instructions = $('instructions-input').value.trim(); if (instructions) body.instructions = instructions;
    const response = await fetch('/api/playground', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Local-CSRF': state.session.csrf }, body: JSON.stringify(body), signal: state.controller.signal });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || error.message || `请求失败（${response.status}）`);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('服务未返回流式响应，请检查本地 API 配置。');
    $('run-state').textContent = '等待模型响应…';
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); handleEvent(chunk);
      }
      if (done) { if (buffer.trim()) handleEvent(buffer); break; }
    }
    if (terminal !== 'completed') throw new Error('连接在响应完成前结束，当前内容可能不完整，请重试。');
    $('run-state').textContent = '✓ 已完成';
    $('run-usage').textContent = usage ? `${numberFormat.format(usage.input_tokens || 0)} input · ${numberFormat.format(usage.output_tokens || 0)} output` : '调用完成 · 用量由本站记录';
    if (!state.output) { $('output-text').textContent = '响应已完成，但未包含可显示的文本。'; }
  } catch (error) {
    if (error.name === 'AbortError') {
      $('run-state').textContent = '已停止'; $('run-usage').textContent = '输出可能不完整';
      if (!state.output) $('output-text').textContent = '你已停止本次请求。';
    } else {
      state.controller.abort();
      $('output-error').textContent = error.message; $('output-error').hidden = false;
      $('run-state').textContent = '未完成'; $('run-usage').textContent = '请查看上方原因';
    }
  } finally {
    clearInterval(durationTimer); $('run-duration').textContent = elapsed(); state.running = false; state.controller = null;
    $('copy-output-btn').disabled = !state.output; updateRunButton(); await refreshSession();
  }
}

function codeExample() {
  const base = state.session?.baseUrl || 'http://127.0.0.1:4317/v1';
  const model = $('model-select').value || 'YOUR_AUTHORIZED_MODEL';
  if (state.selectedCode === 'python') {
    return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    api_key="YOUR_LOCAL_API_KEY",\n)\n\nresponse = client.responses.create(\n    model=${JSON.stringify(model)},\n    input="用一句话介绍你自己。",\n    store=False,\n)\nprint(response.output_text)`;
  }
  const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const data = JSON.stringify({ model, input: '用一句话介绍你自己。', store: false }, null, 2);
  return `curl ${shellQuote(`${base}/responses`)} \\\n  -H 'Authorization: Bearer YOUR_LOCAL_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(data)}`;
}

function renderCode() {
  $('code-example').textContent = codeExample();
  $('curl-tab').classList.toggle('active', state.selectedCode === 'curl');
  $('python-tab').classList.toggle('active', state.selectedCode === 'python');
  $('curl-tab').setAttribute('aria-selected', String(state.selectedCode === 'curl'));
  $('python-tab').setAttribute('aria-selected', String(state.selectedCode === 'python'));
}

$('refresh-btn').addEventListener('click', async () => { state.modelSignature = null; setAlert(''); await refreshSession({ notify: true }); });
$('login-btn').addEventListener('click', () => startLogin(state.session?.account?.id));
$('add-account-btn').addEventListener('click', () => startLogin(undefined, $('add-account-btn')));
$('logout-btn').addEventListener('click', logout);
$('copy-base-url').addEventListener('click', () => copyText(state.session?.baseUrl, 'Base URL 已复制'));
$('create-key-btn').addEventListener('click', openKeyDialog);
$('empty-create-key-btn').addEventListener('click', openKeyDialog);
$('key-form').addEventListener('submit', createKey);
for (const id of ['close-key-dialog', 'cancel-key-dialog', 'saved-key-btn']) $(id).addEventListener('click', closeKeyDialog);
$('key-dialog').addEventListener('close', clearSecret);
$('key-dialog').addEventListener('cancel', clearSecret);
$('copy-key-secret').addEventListener('click', () => copyText(state.secret, '完整密钥已复制，请妥善保存'));
$('run-btn').addEventListener('click', runRequest);
$('cancel-btn').addEventListener('click', () => state.controller?.abort());
$('copy-output-btn').addEventListener('click', () => copyText(state.output, '响应已复制'));
$('copy-code-btn').addEventListener('click', () => copyText(codeExample(), '接入示例已复制'));
$('curl-tab').addEventListener('click', () => { state.selectedCode = 'curl'; renderCode(); });
$('python-tab').addEventListener('click', () => { state.selectedCode = 'python'; renderCode(); });
$('model-select').addEventListener('change', () => { updateRunButton(); renderCode(); });
$('prompt-input').addEventListener('input', updateRunButton);
$('prompt-input').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void runRequest(); } });
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.data?.type !== 'planbridge-auth-complete') return;
  if (state.authPoll) { clearInterval(state.authPoll); state.authPoll = null; }
  setAlert(''); void refreshSession({ notify: true });
});
window.addEventListener('pagehide', () => { clearSecret(); state.controller?.abort(); });

const navLinks = document.querySelectorAll('.side-nav a');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    const entry = entries.filter((item) => item.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!entry) return;
    for (const link of navLinks) link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`);
    const names = { overview: '概览', keys: 'API 密钥', playground: '试运行', docs: '接入指南' };
    document.querySelector('.breadcrumb strong').textContent = names[entry.target.id];
  }, { rootMargin: '-80px 0px -55% 0px', threshold: 0 });
  for (const id of ['overview', 'keys', 'playground', 'docs']) observer.observe($(id));
}

async function initialize() {
  $('create-key-btn').disabled = true; $('empty-create-key-btn').disabled = true;
  renderCode();
  await refreshSession();
  const loginResult = new URLSearchParams(location.search).get('login');
  if (loginResult) {
    if (window.opener && window.opener !== window) {
      window.opener.postMessage({ type: 'planbridge-auth-complete' }, location.origin);
      window.close();
    } else {
      if (loginResult === 'success') { setAlert(''); toast('ChatGPT 账户已连接'); }
      else if (!state.session?.loginError) setAlert('ChatGPT 登录未完成，请重试。');
      history.replaceState(null, '', location.pathname + location.hash);
    }
  }
  setInterval(() => { if (!document.hidden) void refreshSession(); }, 10000);
}
void initialize();
