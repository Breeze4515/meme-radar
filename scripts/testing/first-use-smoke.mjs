import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../../src/config.mjs';
import { GmgnKeyStore } from '../../src/gmgn-key-store.mjs';
import { GmgnConnection } from '../../src/gmgn-connection.mjs';
import { GmgnClient } from '../../src/gmgn.mjs';
import { RadarState } from '../../src/state.mjs';
import { Scanner } from '../../src/scanner.mjs';
import { createServer } from '../../src/server.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-first-use-'));
const valid = `gmgn_${'a'.repeat(32)}`;
const invalid = `gmgn_${'b'.repeat(32)}`;
const keyStore = new GmgnKeyStore(temporary);
const state = new RadarState(temporary);
const gmgn = new GmgnClient({ apiKeyProvider: () => keyStore.get(), legacyKeyProvider: () => '',
  privateKeyProvider: () => keyStore.verificationPrivateKey() });
gmgn.run = async (_args, options = {}) => {
  const key = options.apiKey || gmgn.apiKey();
  if (key !== valid) throw Object.assign(new Error('synthetic rejected key'), { code: 'GMGN_AUTH_FAILED' });
  gmgn.lastVerifiedKey = key;
  return [];
};
const scanner = new Scanner({ gmgn, state });
const connection = new GmgnConnection({ gmgn, keyStore, scanner });
const settings = { ...config, port: 0 };
const server = createServer({ state, settings, saveGmgnKey: key => connection.apply(key),
  getGmgnConnection: () => connection.snapshot(), getGmgnOnboarding: options => keyStore.onboarding(options) });

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const base = `http://127.0.0.1:${settings.port}`;
    const req = http.request(`${base}${route}`, { method, headers: { Origin: base, 'Content-Type': 'application/json' } }, response => {
      let output = '';
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(output) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function prepareAgent() {
  const prepared = await request('POST', '/api/gmgn-onboarding', { regenerate: false });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.algorithm, 'Ed25519');
  assert.match(prepared.body.publicKey, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(JSON.stringify(prepared.body).includes('PRIVATE KEY'), false);
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  settings.port = server.address().port;
  await scanner.cycle();
  const before = await request('GET', '/api/status');
  assert.equal(before.body.status, 'GMGN_AUTH_REQUIRED');
  assert.equal(before.body.gmgnConnection.configured, false);
  const unprepared = await request('POST', '/api/gmgn-key', { apiKey: invalid });
  assert.equal(unprepared.status, 409);
  assert.equal(unprepared.body.error, 'gmgn_onboarding_required');
  await prepareAgent();
  const rejected = await request('POST', '/api/gmgn-key', { apiKey: invalid });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error, 'gmgn_auth_failed');
  assert.equal(keyStore.configured(), false);
  const accepted = await request('POST', '/api/gmgn-key', { apiKey: valid });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { accepted: true, configured: true, verified: true });
  for (let count = 0; count < 40 && state.value.scanCount === 0; count++) await delay(25);
  const after = await request('GET', '/api/status');
  assert.equal(after.body.status, 'RUNNING');
  assert.ok(after.body.scanCount > 0);
  assert.equal(after.body.gmgnConnection.status, 'VERIFIED');
  assert.equal(JSON.stringify(after.body).includes(valid), false);
  await prepareAgent();
  const replaceRejected = await request('POST', '/api/gmgn-key', { apiKey: invalid });
  assert.equal(replaceRejected.status, 401);
  assert.equal(replaceRejected.body.error, 'gmgn_auth_failed');
  assert.equal(keyStore.get(), valid);
  console.log('首次使用 HTTP 流程通过：无 Key 等待 → 无效 Key 拒绝 → 验证成功保存 → 自动扫描 → 错误换 Key 保留原配置。');
} finally {
  scanner.stop();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
