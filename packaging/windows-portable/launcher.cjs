const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const root = path.dirname(process.execPath);
const node = path.join(root, 'runtime', 'node.exe');
const main = path.join(root, 'src', 'main.mjs');
const opener = path.join(root, 'scripts', 'wait-and-open.mjs');

if (![node, main, opener].every(file => fs.existsSync(file))) {
  console.error('Meme Radar files are incomplete. Extract the full portable package and try again.');
  process.stdin.resume();
  return;
}

console.log('Meme Radar is starting...');
console.log('Keep this window open. Closing it stops the local radar.');

const openTask = spawn(node, [opener], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
openTask.unref();

const radar = spawn(node, ['--use-env-proxy', main], { cwd: root, windowsHide: false, stdio: 'inherit' });
radar.once('error', error => {
  console.error(`Meme Radar could not start: ${error.message}`);
  process.stdin.resume();
});
radar.once('exit', code => {
  if (code) {
    console.error(`Meme Radar stopped with error code ${code}. Take a screenshot of this window.`);
    process.stdin.resume();
  } else {
    process.exit(0);
  }
});
