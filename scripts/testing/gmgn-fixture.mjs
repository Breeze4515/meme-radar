// Offline-only network fixture: records no real credentials and prevents access
// to the user's legacy credential file when exercising the production worker.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalRead = fs.readFileSync;
fs.readFileSync = function (name, ...args) {
  if (String(name).endsWith('/.config/gmgn/.env')) throw new Error('Worker attempted to load global credentials');
  return originalRead.call(this, name, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  if (process.env.RADAR_TEST_REJECT === '1') {
    return new Response(JSON.stringify({ code: 401, message: process.env.RADAR_TEST_EXPECTED_KEY }), { status: 401 });
  }
  return new Response(JSON.stringify({ code: 0, data: { rank: [{
    keyMatches: options.headers['X-APIKEY'] === process.env.RADAR_TEST_EXPECTED_KEY,
    noPrivateKey: !process.env.GMGN_PRIVATE_KEY,
    noDebug: !process.env.GMGN_DEBUG,
    path: new URL(url).pathname
  }] } }), { status: 200 });
};
