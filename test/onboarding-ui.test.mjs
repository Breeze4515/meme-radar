import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf("let gmgnKeyMessageKey = ''"), html.indexOf('async function refresh()'));

test('key form waits for actual verification, clears input and displays only translated error codes', async () => {
  for (const item of [
    { ok: true, body: { verified: true }, message: 'gmgnApiConnected', scans: 1, blocked: false },
    { ok: false, body: { error: 'gmgn_auth_failed' }, message: 'gmgnApiInvalid', scans: 0, blocked: false },
    { ok: false, body: { error: 'gmgn_rate_limited', retryAfterSeconds: 45 }, message: 'gmgnApiRateCountdown', scans: 0, blocked: true },
    { ok: false, body: { error: '<script>raw-secret</script>' }, message: 'gmgnApiFailed', scans: 0, blocked: false },
    { ok: true, body: { configured: true }, message: 'gmgnApiFailed', scans: 0, blocked: false }
  ]) {
    const key = `gmgn_${'d'.repeat(32)}`;
    const elements = { gmgnKeyInput: { value: key }, gmgnKeyButton: {}, gmgnKeyStatus: {} };
    let refreshes = 0;
    let finish;
    const context = vm.createContext({
      byId: id => elements[id], t: key => key, showToast() {}, AbortSignal, setTimeout: () => 0,
      fetch: async (url, request) => {
        assert.equal(url, '/api/gmgn-key');
        assert.deepEqual(JSON.parse(request.body), { apiKey: key });
        assert.equal(elements.gmgnKeyInput.value, '');
        return new Promise(resolve => { finish = () => resolve({ ok: item.ok, json: async () => item.body }); });
      },
      refresh: async () => { refreshes++; }
    });
    vm.runInContext(source, context);
    const pending = context.connectGmgnApi({ preventDefault() {} });
    assert.equal(elements.gmgnKeyStatus.textContent, 'gmgnApiConnecting');
    assert.equal(elements.gmgnKeyButton.disabled, true);
    finish();
    await pending;
    assert.equal(elements.gmgnKeyInput.value, '');
    assert.equal(elements.gmgnKeyInput.disabled, false);
    assert.equal(elements.gmgnKeyButton.disabled, item.blocked);
    assert.equal(elements.gmgnKeyStatus.textContent, item.message);
    assert.equal(refreshes, item.scans);
  }
});
