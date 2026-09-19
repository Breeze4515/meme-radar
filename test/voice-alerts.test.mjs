import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VoiceAlerts, voiceEligible, voiceKey, VOICE_TTL } from '../public/voice-alerts.mjs';
import { CANDIDATE_PHRASE, createVoicePlayer, selectChineseVoice } from '../public/voice-player.mjs';
import { voiceSnapshot, toPublicStatus, createServer } from '../src/server.mjs';
import { config } from '../src/config.mjs';

const now = 1_800_000_000_000;
const row = (address = '0x' + 'a'.repeat(40), at = now) => ({ address, chain: 'bsc',
  status: 'X_REVIEW', qualified: true, auditedAt: at, staleAt: at + 600000 });
const snapshot = rows => ({ chains: { bsc: rows } });

test('quiet baseline, newly audited promotion, duplicate suppression and downgrade cancellation', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  const old = row(), pending = { ...row('pending'), status: 'WAIT_RECHECK', qualified: false };
  tracker.ingest(snapshot([old, pending]), now);
  assert.equal(tracker.batch({}, now).length, 0);
  const promoted = row('pending', now + 1000);
  tracker.ingest(snapshot([old, promoted]), now + 1000);
  assert.deepEqual(tracker.batch({}, now + 1000), [promoted]);
  tracker.ingest(snapshot([old, pending]), now + 2000);
  assert.equal(tracker.batch({}, now + 2000).length, 0);
  tracker.ingest(snapshot([old, promoted]), now + 3000);
  tracker.acknowledge([promoted], now + 3000);
  tracker.ingest(snapshot([old, promoted]), now + 4000);
  assert.equal(tracker.batch({}, now + 4000).length, 0);
});

test('stale, ignored, unknown, failed, future and unaudited-before-enable candidates never alert', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  tracker.ingest(snapshot([]), now);
  const rows = [row('old', now - 1), { ...row('stale'), staleAt: now },
    { ...row('failed'), qualified: false }, row('future', now + 5000), row('ignored')];
  tracker.ingest(snapshot(rows), now, r => r.address === 'ignored');
  assert.equal(tracker.batch({}, now).length, 0);
  assert.equal(voiceEligible(row('too-old', now - 601000), now), false);
  tracker.reset(now + 10000);
  tracker.ingest(snapshot([row('restart', now + 10000)]), now + 10000);
  assert.equal(tracker.batch({}, now + 10000).length, 0);
});

test('identity and cross-tab persisted dedupe respect chain and Solana case', () => {
  assert.equal(voiceKey(row('0xAa')), voiceKey(row('0xaa')));
  assert.notEqual(voiceKey({ chain: 'sol', address: 'Abc' }), voiceKey({ chain: 'sol', address: 'abc' }));
  assert.notEqual(voiceKey(row('same')), voiceKey({ chain: 'arc', address: 'same' }));
  const tracker = new VoiceAlerts(); tracker.reset(now); tracker.ingest(snapshot([]), now);
  const candidate = row('a', now + 1); tracker.ingest(snapshot([candidate]), now + 1);
  assert.equal(tracker.batch({ [voiceKey(candidate)]: now }, now + 1).length, 0);
  tracker.ingest(snapshot([row('a', now + VOICE_TTL + 1)]), now + VOICE_TTL + 1);
  assert.equal(tracker.batch({}, now + VOICE_TTL + 1).length, 0);
});

test('continuous qualification and regular reaudits do not re-alert after 24 hours', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now); tracker.ingest(snapshot([row()]), now);
  for (const offset of [VOICE_TTL - 1, VOICE_TTL + 1, 2 * VOICE_TTL + 1]) {
    tracker.ingest(snapshot([row(undefined, now + offset)]), now + offset);
    assert.equal(tracker.batch({}, now + offset).length, 0);
  }
});

test('server voice snapshot includes all enabled chains, excludes incomplete/legacy/held and leaks no raw data', () => {
  const make = chain => ({ ...row(), chain, deep: { chainPass: true, chartRisk: { pass: true, version: 1 } },
    auditHealth: { complete: true }, privateStuff: 'do-not-return', rawDiscovery: { confidential: true } });
  const state = { activeChain: 'bsc', candidates: [make('bsc')], chainStates: { arc: { candidates: [make('arc')] } } };
  let result = voiceSnapshot(state, ['bsc', 'arc', 'fake']);
  assert.deepEqual(Object.keys(result.chains), ['bsc', 'arc']);
  assert.equal(result.chains.arc[0].qualified, true);
  assert.doesNotMatch(JSON.stringify(result), /privateStuff|do-not-return|rawDiscovery/);
  state.candidates[0].auditHealth.complete = false;
  state.chainStates.arc.candidates[0].deep.chartRisk.version = 0;
  result = voiceSnapshot(state, ['bsc', 'arc']);
  assert.equal(result.chains.bsc[0].qualified, false); assert.equal(result.chains.arc[0].qualified, false);
  assert.equal(toPublicStatus({ activeChain: 'arc', candidates: state.chainStates.arc.candidates }).candidates[0].status, 'WAIT_RECHECK');
});

const localVoice = { name: 'Meijia', lang: 'zh-TW', localService: true };
function mockSpeech(voices = [localVoice]) {
  const utterances = [];
  let timeout, cancellations = 0;
  const synthesis = { paused: true, getVoices: () => voices, resume() { this.paused = false; },
    speak(u) { utterances.push(u); }, cancel() { cancellations++; } };
  const player = createVoicePlayer({ synthesis, makeUtterance: text => ({ text }),
    schedule(fn) { timeout = fn; return 1; }, cancelTimer() { timeout = null; } });
  return { player, synthesis, utterances, expire() { timeout(); }, get cancellations() { return cancellations; } };
}
test('voice selection prefers installed Chinese female voices and never falls back to cloud voices', () => {
  const male = { name: 'Male', lang: 'zh-CN', localService: true, default: true };
  const remote = { name: 'Xiaoxiao', lang: 'zh-CN', localService: false };
  assert.equal(selectChineseVoice([male, remote, localVoice]), localVoice);
  assert.equal(selectChineseVoice([remote, { ...male, lang: 'en-US' }]), null);
  assert.equal(selectChineseVoice([male]), male);
});
test('player unlocks in gesture, speaks fixed text locally, never overlaps, and stop is not delivery', async () => {
  const { player, synthesis, utterances } = mockSpeech();
  await assert.rejects(player.play(.5), /suspended/);
  const unlocking = player.unlock(); assert.equal(synthesis.paused, false); await unlocking;
  assert.equal(player.ready, true);
  const playing = player.play(.5); assert.equal(await player.play(.5), false);
  assert.equal(utterances[0].text, CANDIDATE_PHRASE); assert.equal(utterances[0].voice, localVoice);
  assert.equal(utterances[0].volume, .5); assert.equal(utterances[0].rate, .9);
  player.stop(); assert.equal(await playing, false);
  const completed = player.play(2); assert.equal(utterances.at(-1).volume, 1);
  utterances.at(-1).onend(); assert.equal(await completed, true);
  assert.equal(await player.play(0), false); assert.equal(await player.play(Infinity), false);
});
test('missing Chinese voice can be retried after voice discovery, with no silent fake success', async () => {
  const voices = [], { player } = mockSpeech(voices);
  await assert.rejects(player.unlock(), /chinese_voice_missing/); assert.equal(player.ready, false);
  voices.push(localVoice); await player.unlock(); assert.equal(player.ready, true);
});
test('speech failure and timeout disable player until explicitly reenabled', async () => {
  const h = mockSpeech(); await h.player.unlock();
  const failure = h.player.play(.5); h.utterances.at(-1).onerror({ error: 'not-allowed' });
  await assert.rejects(failure, /not-allowed/); assert.equal(h.player.ready, false);
  await h.player.unlock(); const timed = h.player.play(.5); h.expire();
  await assert.rejects(timed, /speech_timeout/); assert.equal(h.player.ready, false);
  assert.equal(h.cancellations, 1); assert.equal(h.player.playing, false);
});

test('exact static routes serve voice modules, keep CSP, exclude recordings and reject traversal', async () => {
  const server = createServer({ state: { value: {} }, settings: config });
  const dispatch = url => new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: { host: `127.0.0.1:${config.port}` }, socket: { remoteAddress: '127.0.0.1' } };
    const out = {};
    const res = { writeHead(status, headers) { Object.assign(out, { status, headers }); }, end(body) { resolve({ ...out, body }); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
  for (const route of ['/voice-ui.mjs', '/voice-alerts.mjs', '/voice-player.mjs']) {
    const result = await dispatch(route); assert.equal(result.status, 200); assert.match(result.headers['Content-Type'], /javascript/);
    assert.match(result.headers['Content-Security-Policy'], /connect-src 'self'/);
  }
  assert.equal((await dispatch('/audio/candidate-found.wav')).status, 404);
  assert.equal((await dispatch('/audio/../src/config.mjs')).status, 404);
  assert.equal((await dispatch('/voice-unknown.mjs')).status, 404);
  const ui = fs.readFileSync(new URL('../public/voice-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /addEventListener\('storage'/); assert.match(ui, /navigator\.locks\.request/);
  assert.match(ui, /if \(player.playing \|\| state === 'loading'\) return/);
});
