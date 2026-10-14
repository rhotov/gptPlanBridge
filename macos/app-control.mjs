import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, copyFileSync, linkSync, constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { canonicalDataDir, resolveDataDir } from '../data-path.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PLANBRIDGE_PORT || 4317);
const url = `http://127.0.0.1:${port}`;
let dataDir;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class ControlError extends Error {
  constructor(message, state = 'error') { super(message); this.state = state; }
}
const identity = dir => createHash('sha256').update(dir).digest('hex').slice(0, 20);

async function portOpen() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = open => { if (!done) { done = true; socket.destroy(); resolve(open); } };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function inspect(dir = dataDir) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    if (response.ok) {
      const health = await response.json();
      if (health.service === 'planbridge' && health.serviceId === identity(dir) && Number.isInteger(health.pid) && health.pid > 1 && typeof health.instanceId === 'string' && health.instanceId) return { state: 'running', health };
    }
    return { state: 'occupied' };
  } catch {
    return { state: await portOpen() ? 'occupied' : 'stopped' };
  }
}
function command(file, args, dir) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: root,
      env: { ...process.env, PLANBRIDGE_DATA_DIR: dir, PLANBRIDGE_NODE_BIN: process.execPath, PLANBRIDGE_PORT: String(port), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      timeout: 20000, maxBuffer: 64 * 1024,
    }, error => error ? reject(new ControlError('服务器操作未完成，请查看数据目录中的 server.log。')) : resolve());
  });
}
async function stop(dir = dataDir) {
  const current = await inspect(dir);
  if (current.state === 'occupied') throw new ControlError(`端口 ${port} 被其他服务占用；未停止任何其他进程。`, 'occupied');
  if (current.state === 'stopped') return current;
  const record = join(dir, `server-${port}.json`);
  if (!existsSync(record)) {
    if ((await inspect(dir)).state !== 'running') throw new ControlError('服务状态发生变化，请重试。');
    await command(process.execPath, ['--no-use-env-proxy', join(root, 'launch.mjs'), 'start'], dir);
  }
  await command(process.execPath, ['--no-use-env-proxy', join(root, 'launch.mjs'), 'stop'], dir);
  const result = await inspect(dir);
  if (result.state !== 'stopped') throw new ControlError('停止请求已发出，但端口仍在响应。', result.state === 'occupied' ? 'occupied' : 'error');
  return result;
}
async function waitForExit(pid) {
  const deadline = Date.now() + 15000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw new ControlError('无法确认旧服务已退出；未复制账号凭证。'); }
    if (Date.now() >= deadline) throw new ControlError('旧服务仍在完成请求；请稍后重新打开 PlanBridge，账号数据尚未迁移。');
    await pause(100);
  }
}
async function start() {
  const current = await inspect();
  if (current.state === 'running') return current;
  if (current.state === 'occupied') throw new ControlError(`端口 ${port} 被其他服务占用；请先关闭占用此端口的应用。`, 'occupied');
  await command('/bin/zsh', [join(root, 'start.command')], dataDir);
  const result = await inspect();
  if (result.state !== 'running') throw new ControlError('服务器启动后没有通过状态检查。', result.state === 'occupied' ? 'occupied' : 'error');
  return result;
}
function readRedirect(legacy) {
  try {
    const location = JSON.parse(readFileSync(join(legacy, 'storage-location.json'), 'utf8'));
    if (!location || typeof location.dataDir !== 'string' || !isAbsolute(location.dataDir)) throw Error();
    return canonicalDataDir(location.dataDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ControlError('旧目录的存储位置记录无效；未覆盖任何账号数据。');
  }
}
function writeRedirect(legacy) {
  const file = join(legacy, 'storage-location.json'), temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ dataDir }, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally { rmSync(temp, { force: true }); }
}
function copyState(source) {
  const file = join(dataDir, 'state.json'), temp = `${file}.${randomUUID()}.tmp`;
  try {
    // Validate syntax without exposing or modifying the credentials.
    const state = JSON.parse(readFileSync(source, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(state.accounts) || !Array.isArray(state.keys)) throw Error();
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    chmodSync(temp, 0o600);
    // A hard link refuses to overwrite a concurrently created state file.
    linkSync(temp, file);
    chmodSync(file, 0o600);
  } catch { throw new ControlError('旧账号数据未能迁移；未覆盖现有账号数据。'); }
  finally { rmSync(temp, { force: true }); }
}
async function prepare() {
  const legacyPath = process.env.PLANBRIDGE_LEGACY_DATA_DIR;
  if (!legacyPath) return inspect();
  if (!isAbsolute(legacyPath)) throw new ControlError('旧数据目录必须是绝对路径。');
  if (!existsSync(legacyPath)) return inspect();
  const legacy = canonicalDataDir(legacyPath);
  if (legacy === dataDir) return inspect();
  const redirect = readRedirect(legacy);
  if (redirect && redirect !== dataDir) throw new ControlError('旧数据目录已连接到另一个存储位置；未修改账号数据。');
  const source = join(legacy, 'state.json'), destination = join(dataDir, 'state.json');
  if (!existsSync(source)) return inspect();
  if (existsSync(destination)) {
    if (!redirect) throw new ControlError('新旧目录中均有账号数据；为避免覆盖或重复使用刷新令牌，未自动迁移。');
    return inspect();
  }
  const pendingFile = join(dataDir, 'migration-pending.json');
  if (existsSync(pendingFile)) {
    let pending;
    try { pending = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch {}
    if (!pending || !Number.isInteger(pending.pid) || pending.pid <= 1 || pending.serviceId !== identity(legacy) || typeof pending.instanceId !== 'string') throw new ControlError('迁移状态记录无效；未复制账号凭证。');
    await waitForExit(pending.pid);
    rmSync(pendingFile);
  }
  const previous = await inspect(legacy);
  if (previous.state === 'occupied') throw new ControlError(`端口 ${port} 被其他服务占用；请关闭占用此端口的应用后重新打开 PlanBridge。`, 'occupied');
  if (previous.state === 'running') {
    writeFileSync(pendingFile, JSON.stringify({ pid: previous.health.pid, instanceId: previous.health.instanceId, serviceId: previous.health.serviceId }), { mode: 0o600, flag: 'wx' });
    // Adopt only a service already verified to belong to the legacy store.
    const record = join(legacy, `server-${port}.json`);
    if (!existsSync(record)) {
      if ((await inspect(legacy)).state !== 'running') throw new ControlError('旧服务状态发生变化，请重新打开 PlanBridge。');
      await command(process.execPath, ['--no-use-env-proxy', join(root, 'launch.mjs'), 'start'], legacy);
    }
    await stop(legacy);
    await waitForExit(previous.health.pid);
    rmSync(pendingFile);
  }
  copyState(source);
  writeRedirect(legacy);
  if (previous.state === 'running') {
    await pause(100);
    return start();
  }
  return inspect();
}

try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ControlError('服务器端口必须在 1024–65535 之间。');
  dataDir = resolveDataDir(root);
  const action = process.argv[2] || 'status';
  let result;
  if (action === 'prepare') result = await prepare();
  else if (action === 'status') result = await inspect();
  else if (action === 'start') result = await start();
  else if (action === 'stop') result = await stop();
  else throw new ControlError('只支持 prepare、status、start 或 stop。');
  process.stdout.write(`${JSON.stringify({ ok: true, state: result.state, url, dataDir, ...(result.state === 'occupied' ? { message: `端口 ${port} 被其他服务占用。` } : {}) })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, state: error.state || 'error', url, message: error instanceof ControlError ? error.message : '本地服务管理失败；请检查存储目录权限和应用文件。' })}\n`);
  process.exitCode = 1;
}
