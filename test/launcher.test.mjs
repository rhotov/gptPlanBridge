import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../data-path.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await pause(25);
  }
}
async function reservePort() {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  assert.notEqual(port, 4317, 'tests must never use the real application port');
  return port;
}
async function fixture(t, { externalDataDir = false } = {}) {
  // Node resolves /var to /private/var on macOS before deriving service identity.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'planbridge-launcher-test-')));
  const dataDir = externalDataDir ? join(root, 'Application Support', 'PlanBridge') : join(root, '.data');
  const port = await reservePort();
  const serviceId = createHash('sha256').update(dataDir).digest('hex').slice(0, 20);
  const origin = `http://127.0.0.1:${port}`;
  const recordFile = join(dataDir, `server-${port}.json`);
  const ownedPids = new Set();
  for (const file of ['server.mjs', 'chat-compat.mjs', 'data-path.mjs', 'launch.mjs', 'start.command', 'stop.command']) copyFileSync(join(source, file), join(root, file));
  mkdirSync(join(root, 'macos'));
  copyFileSync(join(source, 'macos', 'app-control.mjs'), join(root, 'macos', 'app-control.mjs'));
  chmodSync(join(root, 'start.command'), 0o755);
  chmodSync(join(root, 'stop.command'), 0o755);
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public', 'index.html'), '<!doctype html><title>Isolated launcher test</title>');
  const health = async () => {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(400), redirect: 'error' });
      if (!response.ok) return null;
      const data = await response.json();
      return data.service === 'planbridge' && data.serviceId === serviceId ? data : null;
    } catch { return null; }
  };
  t.after(async () => {
    // Cleanup uses only the isolated checkout's verified health identity/PIDs.
    const current = await health();
    if (current) ownedPids.add(current.pid);
    for (const pid of ownedPids) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await eventually(async () => !(await health()), 'isolated child server did not stop');
    rmSync(root, { recursive: true, force: true });
  });
  const run = (script, overrides = {}) => new Promise(resolve => {
    let launcher;
    launcher = execFile('/bin/zsh', [join(root, script)], {
      cwd: root,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`, PLANBRIDGE_DATA_DIR: dataDir, PLANBRIDGE_PORT: String(port), PLANBRIDGE_USE_ENV_PROXY: '0', ...overrides },
      timeout: 10000,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr, pid: launcher.pid }));
  });
  const start = async () => {
    const launch = await run('start.command');
    assert.equal(launch.code, 0, `${launch.stdout}\n${launch.stderr}`);
    const current = await health();
    assert.ok(current, 'launcher exited without a reachable isolated server');
    assert.ok(Number.isInteger(current.pid) && current.pid > 1);
    assert.notEqual(current.pid, launch.pid);
    ownedPids.add(current.pid);
    return { launch, current };
  };
  const control = (action, overrides = {}) => new Promise(resolve => {
    execFile(process.execPath, ['--no-use-env-proxy', join(root, 'macos', 'app-control.mjs'), action], {
      cwd: root,
      env: { ...process.env, PLANBRIDGE_DATA_DIR: dataDir, PLANBRIDGE_PORT: String(port), PLANBRIDGE_USE_ENV_PROXY: '0', ...overrides },
      timeout: 15000, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr, result: stdout ? JSON.parse(stdout) : null }));
  });
  return { root, dataDir, port, origin, recordFile, serviceId, health, run, start, control };
}

test('detached launcher exits while its server stays reachable, reuses the running PID, and stops its owned instance', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  const first = await h.start();
  assert.match(first.launch.stdout, /后台启动/);
  assert.equal(first.current.ok, true);
  assert.equal(first.current.serviceId, h.serviceId);
  assert.equal(typeof first.current.instanceId, 'string');
  assert.equal(process.kill(first.current.pid, 0), true);
  const page = await fetch(h.origin, { signal: AbortSignal.timeout(1000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Isolated launcher test/);
  assert.equal(statSync(h.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(h.dataDir, 'server.log')).mode & 0o777, 0o600);
  assert.equal(statSync(h.recordFile).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(h.recordFile, 'utf8'));
  assert.deepEqual(record, { pid: first.current.pid, instanceId: first.current.instanceId, serviceId: h.serviceId, port: h.port });
  const second = await h.start();
  assert.match(second.launch.stdout, /已在运行/);
  assert.equal(second.current.pid, first.current.pid);
  assert.equal(second.current.instanceId, first.current.instanceId);
  const stopped = await h.run('stop.command');
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
  assert.match(stopped.stdout, /已停止/);
  await eventually(async () => !(await h.health()), 'stop.command left the owned server responding');
  assert.equal(existsSync(h.recordFile), false);
});

test('stale PID and instance records never terminate a responding listener', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  const { current } = await h.start();
  const record = JSON.parse(readFileSync(h.recordFile, 'utf8'));
  for (const stale of [{ ...record, pid: process.pid }, { ...record, instanceId: 'stale-instance-from-an-earlier-process' }]) {
    writeFileSync(h.recordFile, JSON.stringify(stale), { mode: 0o600 });
    const stopped = await h.run('stop.command');
    assert.equal(stopped.code, 1);
    assert.match(stopped.stderr, /标识不匹配/);
    const responding = await h.health();
    assert.ok(responding, 'stale ownership record caused a live listener to stop');
    assert.equal(responding.pid, current.pid);
    assert.equal(responding.instanceId, current.instanceId);
    assert.equal(process.kill(current.pid, 0), true);
  }
  // The fixture explicitly terminates its verified child PID rather than trusting
  // the stale on-disk ownership record or touching the real application service.
});

test('launcher and app control share external canonical data, bundled Node override, and safe switch lifecycle', { timeout: 20000 }, async t => {
  const h = await fixture(t, { externalDataDir: true });
  const initial = await h.control('status');
  assert.equal(initial.code, 0);
  assert.equal(initial.result.state, 'stopped');
  assert.equal(initial.result.dataDir, h.dataDir);
  assert.equal(initial.stderr, '');
  const started = await h.control('start', { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PLANBRIDGE_NODE_BIN: '/deliberately/missing/node' });
  assert.equal(started.code, 0, started.stdout);
  assert.equal(started.result.state, 'running');
  const health = await h.health();
  assert.equal(health.serviceId, h.serviceId);
  assert.equal(existsSync(join(h.root, '.data', 'state.json')), false);
  assert.equal(statSync(join(h.dataDir, 'state.json')).mode & 0o777, 0o600);
  const stopped = await h.control('stop');
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(stopped.result.state, 'stopped');
  assert.equal(await h.health(), null);
  assert.equal(existsSync(join(h.dataDir, 'state.json')), true);
});

test('data resolver follows an owner-only migration pointer and refuses invalid or relative locations', async t => {
  const h = await fixture(t, { externalDataDir: true });
  const legacy = join(h.root, '.data');
  mkdirSync(legacy, { recursive: true });
  const pointer = join(legacy, 'storage-location.json');
  writeFileSync(pointer, JSON.stringify({ dataDir: h.dataDir }), { mode: 0o644 });
  assert.equal(resolveDataDir(h.root, {}), h.dataDir);
  assert.equal(statSync(pointer).mode & 0o777, 0o600);
  assert.equal(statSync(h.dataDir).mode & 0o777, 0o700);
  assert.throws(() => resolveDataDir(h.root, { PLANBRIDGE_DATA_DIR: 'relative/path' }), /绝对路径/);
  assert.throws(() => resolveDataDir(h.root, { PLANBRIDGE_DATA_DIR: '/' }), /根目录/);
  assert.throws(() => resolveDataDir(h.root, { PLANBRIDGE_DATA_DIR: homedir() }), /主目录/);
  writeFileSync(pointer, 'null');
  assert.throws(() => resolveDataDir(h.root, {}), /无效/);
  writeFileSync(pointer, '{broken');
  assert.throws(() => resolveDataDir(h.root, {}), /无法读取/);
});

test('app prepare atomically migrates only legacy state, redirects old launchers, and preserves the running service', { timeout: 25000 }, async t => {
  const h = await fixture(t, { externalDataDir: true });
  const legacy = join(h.root, '.data');
  const oldStart = await h.run('start.command', { PLANBRIDGE_DATA_DIR: legacy });
  assert.equal(oldStart.code, 0, oldStart.stderr);
  const oldHealth = await (await fetch(`${h.origin}/health`)).json();
  t.after(async () => {
    try {
      const responding = await (await fetch(`${h.origin}/health`, { signal: AbortSignal.timeout(400) })).json();
      if (responding.pid === oldHealth.pid && responding.instanceId === oldHealth.instanceId && responding.serviceId === oldHealth.serviceId) process.kill(oldHealth.pid, 'SIGTERM');
    } catch {}
  });
  const oldState = readFileSync(join(legacy, 'state.json'), 'utf8');
  writeFileSync(join(legacy, 'not-to-migrate.txt'), 'private unrelated fixture');
  const prepared = await h.control('prepare', { PLANBRIDGE_LEGACY_DATA_DIR: legacy });
  assert.equal(prepared.code, 0, prepared.stdout);
  assert.equal(prepared.result.state, 'running');
  const newHealth = await h.health();
  assert.ok(newHealth);
  assert.notEqual(newHealth.pid, oldHealth.pid);
  assert.notEqual(newHealth.serviceId, oldHealth.serviceId);
  assert.equal(readFileSync(join(h.dataDir, 'state.json'), 'utf8'), oldState);
  assert.equal(existsSync(join(h.dataDir, 'not-to-migrate.txt')), false);
  assert.equal(JSON.parse(readFileSync(join(legacy, 'storage-location.json'))).dataDir, h.dataDir);
  assert.equal(statSync(join(legacy, 'storage-location.json')).mode & 0o777, 0o600);
  const oldPathStart = await h.run('start.command', { PLANBRIDGE_DATA_DIR: '' });
  assert.equal(oldPathStart.code, 0, oldPathStart.stderr);
  assert.equal((await h.health()).pid, newHealth.pid);
  const again = await h.control('prepare', { PLANBRIDGE_LEGACY_DATA_DIR: legacy });
  assert.equal(again.code, 0, again.stdout);
  assert.equal((await h.health()).pid, newHealth.pid);
  assert.equal((await h.control('stop')).result.state, 'stopped');
});

test('app prepare does not overwrite two existing stores or terminate another listener', { timeout: 20000 }, async t => {
  const h = await fixture(t, { externalDataDir: true });
  const legacy = join(h.root, '.data');
  mkdirSync(legacy, { recursive: true });
  mkdirSync(h.dataDir, { recursive: true });
  const sourceState = JSON.stringify({ accounts: [], keys: [], marker: 'legacy' });
  const targetState = JSON.stringify({ accounts: [], keys: [], marker: 'target' });
  writeFileSync(join(legacy, 'state.json'), sourceState);
  writeFileSync(join(h.dataDir, 'state.json'), targetState);
  const prepared = await h.control('prepare', { PLANBRIDGE_LEGACY_DATA_DIR: legacy });
  assert.equal(prepared.code, 1);
  assert.equal(prepared.result.ok, false);
  assert.equal(readFileSync(join(h.dataDir, 'state.json'), 'utf8'), targetState);
  assert.equal(existsSync(join(legacy, 'storage-location.json')), false);
  const unrelated = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ service: 'other', pid: process.pid })); });
  await new Promise(resolve => unrelated.listen(h.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  assert.equal((await h.control('status')).result.state, 'occupied');
  const stopped = await h.control('stop');
  assert.equal(stopped.code, 1);
  assert.equal(stopped.result.state, 'occupied');
  const started = await h.control('start');
  assert.equal(started.code, 1);
  assert.equal(started.result.state, 'occupied');
  assert.equal((await fetch(h.origin)).status, 200);
});

test('app stop adopts only a verified service with a missing record and still refuses stale existing records', { timeout: 20000 }, async t => {
  const h = await fixture(t, { externalDataDir: true });
  const first = await h.start();
  rmSync(h.recordFile);
  const stopped = await h.control('stop');
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(stopped.result.state, 'stopped');
  const second = await h.start();
  const record = JSON.parse(readFileSync(h.recordFile, 'utf8'));
  writeFileSync(h.recordFile, JSON.stringify({ ...record, instanceId: 'unrelated-instance' }));
  const refused = await h.control('stop');
  assert.equal(refused.code, 1);
  assert.equal(refused.result.ok, false);
  assert.equal((await h.health()).pid, second.current.pid);
  assert.equal((await h.health()).instanceId, second.current.instanceId);
  assert.notEqual(first.current.pid, second.current.pid);
});
