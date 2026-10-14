import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './data-path.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir(root);
const serviceId = createHash('sha256').update(dataDir).digest('hex').slice(0, 20);
const port = Number(process.env.PLANBRIDGE_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PLANBRIDGE_PORT 必须在 1024–65535 之间。');
const url = `http://127.0.0.1:${port}`;
const recordFile = join(dataDir, `server-${port}.json`);
const logFile = join(dataDir, 'server.log');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);

async function health() {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (data.service !== 'planbridge' || data.serviceId !== serviceId || !Number.isInteger(data.pid) || data.pid <= 1 || typeof data.instanceId !== 'string') throw Error();
    return data;
  } catch { return null; }
}
function saveRecord(current) {
  const temp = `${recordFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ pid: current.pid, instanceId: current.instanceId, serviceId, port }), { mode: 0o600 });
  renameSync(temp, recordFile);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start() {
  const existing = await health();
  if (existing) { saveRecord(existing); console.log(`PlanBridge 已在运行：${url}`); return; }
  const log = openSync(logFile, 'a', 0o600);
  chmodSync(logFile, 0o600);
  const args = process.execArgv.includes('--no-use-env-proxy') ? ['--no-use-env-proxy'] : process.execArgv.includes('--use-env-proxy') ? ['--use-env-proxy'] : [];
  const child = spawn(process.execPath, [...args, join(root, 'server.mjs')], { cwd: root, detached: true, stdio: ['ignore', log, log], env: process.env });
  closeSync(log);
  let spawnError, exited = false;
  child.once('error', error => { spawnError = error; });
  child.once('exit', () => { exited = true; });
  child.unref();
  for (let attempts = 0; attempts < 40; attempts++) {
    if (spawnError) throw Error(`无法启动后台服务 (${spawnError.code || 'unknown'})。`);
    const current = await health();
    if (current) {
      saveRecord(current);
      console.log(`PlanBridge 已在后台启动：${url}\n关闭此窗口不会停止服务。\n停止服务请打开 stop.command。\n运行日志：${logFile}`);
      return;
    }
    if (exited) break;
    await pause(150);
  }
  throw Error(`服务未能启动，可能是端口占用或启动异常。请查看日志：${logFile}`);
}

async function stop() {
  const current = await health();
  let record;
  try { record = JSON.parse(readFileSync(recordFile, 'utf8')); } catch {}
  if (!current) {
    rmSync(recordFile, { force: true });
    console.log('本项目当前没有可连接的后台服务，未终止任何其他进程。'); return;
  }
  // Never kill a recycled PID or a service from another checkout.
  if (!record || record.pid !== current.pid || record.instanceId !== current.instanceId || record.serviceId !== current.serviceId) throw Error('后台进程标识不匹配，未停止任何进程。请先运行 start.command 确认此项目的服务。');
  process.kill(current.pid, 'SIGTERM');
  for (let attempts = 0; attempts < 30; attempts++) {
    if (!(await health())) { rmSync(recordFile, { force: true }); console.log('PlanBridge 本地服务已停止。'); return; }
    await pause(100);
  }
  throw Error('停止请求已发出，但服务仍在响应。请稍后再检查。');
}

try {
  const action = process.argv[2] || 'start';
  if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else throw Error('只支持 start 或 stop。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
