import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.RADAR_PORT || 3791);
const url = `http://127.0.0.1:${port}/`;

function ready() {
  return new Promise(resolve => {
    const request = http.get(`${url}health`, { timeout: 500 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

for (let attempt = 0; attempt < 40; attempt++) {
  if (await ready()) {
    const command = process.platform === 'win32' ? 'rundll32.exe'
      : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    process.exit(0);
  }
  await delay(250);
}

console.error(`本地服务未能及时启动，请手动打开 ${url}`);
process.exitCode = 1;
