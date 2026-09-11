import test from 'node:test';
import assert from 'node:assert/strict';
import { configureWindowsSystemProxy, detectWindowsSystemProxy, normalizeProxyUrl, parseWindowsProxyServer } from '../src/windows-proxy.mjs';

test('Windows proxy parsing supports ordinary and protocol-specific system proxy values', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(parseWindowsProxyServer('http=127.0.0.1:8080;https=127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('file:///tmp/no'), '');
});

test('existing proxy environment always wins and non-Windows never executes probes', () => {
  let calls = 0;
  const envResult = detectWindowsSystemProxy({ platform: 'win32', env: { HTTPS_PROXY: 'http://127.0.0.1:1080' }, run: () => { calls++; } });
  assert.equal(envResult.source, 'environment');
  assert.equal(calls, 0);
  const direct = detectWindowsSystemProxy({ platform: 'darwin', env: {}, run: () => { calls++; } });
  assert.equal(direct.source, 'not-windows');
  assert.equal(calls, 0);
});

test('portable Windows startup mirrors the effective system proxy without exposing it to UI', () => {
  const env = {};
  const commands = [];
  const detected = configureWindowsSystemProxy({ platform: 'win32', env, run: (binary, args) => {
    commands.push([binary, args]);
    return 'http://127.0.0.1:7890/';
  } });
  assert.equal(detected.source, 'windows-system');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(commands[0][0], 'powershell.exe');
});

test('registry fallback is used when PowerShell proxy discovery is unavailable', () => {
  const result = detectWindowsSystemProxy({ platform: 'win32', env: {}, run: (binary, args) => {
    if (binary === 'powershell.exe') throw new Error('disabled');
    if (args.includes('ProxyEnable')) return 'ProxyEnable    REG_DWORD    0x1';
    return 'ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:7890';
  } });
  assert.deepEqual(result, { proxy: 'http://127.0.0.1:7890/', source: 'windows-registry' });
});
