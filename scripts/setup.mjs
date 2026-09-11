import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function supportedNode(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major === 22 && minor >= 23 || major === 24 && minor >= 5 || major > 24;
}

export async function dependenciesReady(root = projectRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'gmgn-cli', 'package.json'), 'utf8'));
    if (installed.version !== manifest.dependencies['gmgn-cli']) return false;
    await import(pathToFileURL(path.join(root, 'node_modules/gmgn-cli/dist/client/OpenApiClient.js')).href);
    await import(pathToFileURL(path.join(root, 'node_modules/gmgn-cli/dist/output.js')).href);
    return true;
  } catch { return false; }
}

function npmEntry() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(bin, 'node_modules/npm/bin/npm-cli.js'), process.env.npm_execpath
  ];
  const found = candidates.find(value => value && value.endsWith('npm-cli.js') && fs.existsSync(value));
  if (!found) throw new Error('此 Node 安装缺少 npm，请运行“安装并启动.command”或安装包含 npm 的 Node.js。');
  return found;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function withLocalLock(name, callback) {
  const runtime = path.join(projectRoot, '.runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lock = path.join(runtime, `${name}.lock`);
  const ownerFile = path.join(lock, 'pid');
  for (let attempt = 0; attempt < 400; attempt++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(ownerFile, String(process.pid), { mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(ownerFile, 'utf8'));
        if (!alive(owner)) { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); continue; }
      } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
      await delay(300);
      continue;
    }
    try { return await callback(); }
    finally { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); }
  }
  throw new Error('另一个安装或启动任务仍在进行，请等待完成后重试。');
}

export async function ensureDependencies({ checkOnly = false } = {}) {
  if (!supportedNode(process.versions.node)) throw new Error('需要 Node.js 22.23+ 或 24.5+，双击“安装并启动.command”可自动准备。');
  if (await dependenciesReady()) return;
  if (checkOnly) throw new Error('依赖尚未安装。运行 npm run setup 或双击“安装并启动.command”。');
  await withLocalLock('dependencies', async () => {
    if (await dependenciesReady()) return;
    const npm = npmEntry();
    console.log('首次运行：正在安装雷达组件，请稍候……');
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
    for (const key of Object.keys(env)) if (key.startsWith('GMGN_')) delete env[key];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: projectRoot, env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (result !== 0 || !await dependenciesReady()) throw new Error('组件安装未完成，请检查网络后重新运行安装入口。');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { await ensureDependencies({ checkOnly: process.argv.includes('--check') }); console.log('运行环境已就绪。'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
