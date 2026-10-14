import { mkdirSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function canonicalDataDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('PLANBRIDGE_DATA_DIR 必须是绝对路径。');
  const normalized = resolve(path);
  if (normalized === '/' || normalized === resolve(homedir())) throw Error('数据目录不能是文件系统根目录或用户主目录。');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(resolve(path));
  if (canonical === '/' || canonical === realpathSync(homedir())) throw Error('数据目录不能是文件系统根目录或用户主目录。');
  chmodSync(canonical, 0o700);
  return canonical;
}

export function resolveDataDir(root, env = process.env) {
  if (env.PLANBRIDGE_DATA_DIR) return canonicalDataDir(env.PLANBRIDGE_DATA_DIR);
  const legacy = join(root, '.data');
  const locationFile = join(legacy, 'storage-location.json');
  let location, hasLocation = false;
  try {
    location = JSON.parse(readFileSync(locationFile, 'utf8'));
    hasLocation = true;
    chmodSync(locationFile, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('本地存储位置记录无法读取；为保护账号，服务不会创建另一份凭证。');
  }
  if (hasLocation) {
    if (!location || typeof location.dataDir !== 'string' || !isAbsolute(location.dataDir)) throw Error('本地存储位置记录无效；请检查 .data/storage-location.json。');
    return canonicalDataDir(location.dataDir);
  }
  return canonicalDataDir(legacy);
}
