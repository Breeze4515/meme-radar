import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { projectRoot, withLocalLock } from './setup.mjs';

const port = Number(process.env.RADAR_PORT || 3791);
let stopping = false;
let child;
function stop() { stopping = true; child?.kill('SIGTERM'); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function health() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

await withLocalLock(`supervisor-${port}`, async () => {
  let crashes = 0;
  while (!stopping) {
    const started = Date.now();
    let failures = 0;
    let recycle = false;
    child = spawn(process.execPath, ['--use-env-proxy', path.join(projectRoot, 'src/main.mjs')], {
      cwd: projectRoot, env: process.env, stdio: 'inherit'
    });
    const watchdog = setInterval(async () => {
      const monitored = child;
      const snapshot = await health();
      // A provider outage is not a hung process: restart only on a dead local
      // HTTP loop or a cycle that cannot finish within its bounded request budget.
      failures = snapshot ? 0 : failures + 1;
      const stuck = snapshot?.scanner?.scanInProgress && snapshot.scanner.cycleStartedAt
        && Date.now() - snapshot.scanner.cycleStartedAt > 8 * 60_000;
      if ((failures >= 3 || stuck) && monitored && child === monitored) {
        recycle = true; monitored.kill('SIGTERM');
        const deadline = setTimeout(() => { if (monitored.exitCode === null && !monitored.signalCode) monitored.kill('SIGKILL'); }, 5000);
        deadline.unref();
      }
    }, 30_000);
    const result = await new Promise(resolve => {
      child.once('error', () => resolve(1)); child.once('exit', code => resolve(code));
    });
    clearInterval(watchdog);
    child = null;
    if (stopping || result === 0 && !recycle) break;
    crashes = Date.now() - started > 5 * 60_000 ? 1 : crashes + 1;
    console.error(`雷达进程退出，自动恢复尝试 ${crashes}；扫描记录将从本机恢复。`);
    await delay(Math.min(60_000, 3000 * 2 ** Math.min(crashes - 1, 5)));
  }
});
