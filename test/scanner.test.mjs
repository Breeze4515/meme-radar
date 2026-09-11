import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Scanner, classifyDeepResult, mergeSecondaryClassification, selectAuditQueue, summarizeOutcomes,
  twitterHandle, updateOutcomeTracking, upsertOutcome
} from '../src/scanner.mjs';

test('manual rescan requests run immediately or queue behind the active cycle', async () => {
  const scanner = Object.create(Scanner.prototype);
  scanner.running = true;
  scanner.rescanRequested = false;
  assert.deepEqual(scanner.requestCycle(), { queued: true });
  assert.equal(scanner.rescanRequested, true);

  let cycles = 0;
  scanner.running = false;
  scanner.cycle = async () => { cycles += 1; };
  assert.deepEqual(scanner.requestCycle(), { queued: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cycles, 1);
});

test('X链接只接受真实用户名并拒绝站内功能路径', () => {
  assert.equal(twitterHandle('x.com/real_user/status/1'), 'real_user');
  assert.equal(twitterHandle('https://twitter.com/RealUser'), 'RealUser');
  assert.equal(twitterHandle('@valid_name'), 'valid_name');
  assert.equal(twitterHandle('https://x.com/search?q=token'), '');
  assert.equal(twitterHandle('x.com/x.com'), '');
  assert.equal(twitterHandle('bad.handle'), '');
});

test('scanner separates permanent safety failures from dynamic rechecks', () => {
  assert.equal(classifyDeepResult({ failed: ['ownerRenounced'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'HARD_REJECT');
  assert.equal(classifyDeepResult({ failed: ['openSource'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'HARD_REJECT');
  assert.equal(classifyDeepResult({ failed: ['lpLocked'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'HARD_REJECT');
  assert.equal(classifyDeepResult({ failed: ['tax'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'HARD_REJECT');
  assert.equal(classifyDeepResult({ failed: ['notHoneypot'], blockingUnknownFields: [], honeypotEvidence: '检测到貔貅' }, { complete: true }).status, 'HARD_REJECT');
  assert.equal(classifyDeepResult({ failed: ['observation'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'WAIT_RECHECK');
  assert.equal(classifyDeepResult({ failed: ['marketBehavior'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'WAIT_RECHECK');
  assert.equal(classifyDeepResult({ failed: ['tax'], blockingUnknownFields: ['buyTax'], honeypotEvidence: '未验证' }, { complete: true }).status, 'WAIT_RECHECK');
  assert.equal(classifyDeepResult({ chainPass: true, failed: [], blockingUnknownFields: [] }, { complete: true }).status, 'X_REVIEW');
  assert.equal(classifyDeepResult({ chainPass: true, failed: [], blockingUnknownFields: [] }, { complete: false }).status, 'WAIT_RECHECK');
});

test('persistent audit scheduler prioritizes fresh priority-band candidates and reserves fairness and recheck slots', () => {
  const now = 1_800_000_000_000;
  const queue = [
    { address: 'newer', firstSeenAt: now - 1_000, nextAuditAt: 0, lastAuditedAt: 0, priorityBand: true, score: 99 },
    { address: 'older', firstSeenAt: now - 10_000, nextAuditAt: 0, lastAuditedAt: 0, priorityBand: false, score: 10 },
    { address: 'retry', firstSeenAt: now - 20_000, nextAuditAt: now - 1, lastAuditedAt: now - 5_000, status: 'WAIT_RECHECK' }
  ];
  const addresses = new Set(queue.map(item => item.address));
  assert.equal(selectAuditQueue(queue, addresses, now, 1, 1)[0].address, 'newer');
  assert.equal(selectAuditQueue(queue, addresses, now, 5, 1)[0].address, 'older');
  assert.equal(selectAuditQueue(queue, addresses, now, 3, 1)[0].address, 'retry');
});

test('secondary safety is a one-vote veto while unsupported coverage remains manual-only', () => {
  const passed = { status: 'X_REVIEW', hardFailed: [], waitingFailed: [] };
  const fatal = mergeSecondaryClassification(passed, {
    status: 'COMPLETE',
    sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } },
    security: { verdict: 'FATAL' }, conflicts: []
  });
  assert.equal(fatal.status, 'HARD_REJECT');

  const degraded = mergeSecondaryClassification(passed, {
    status: 'DEGRADED',
    sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'ERROR' } },
    security: { verdict: 'UNKNOWN' }, conflicts: []
  });
  assert.equal(degraded.status, 'WAIT_RECHECK');

  const conflict = mergeSecondaryClassification(passed, {
    status: 'COMPLETE',
    sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } },
    security: { verdict: 'NO_FATAL_FLAGS' }, conflicts: [{ type: 'MARKET_MISMATCH' }]
  });
  assert.equal(conflict.status, 'WAIT_RECHECK');

  const securityConflict = mergeSecondaryClassification(passed, {
    status: 'COMPLETE',
    sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } },
    security: { verdict: 'NO_FATAL_FLAGS' }, conflicts: [{ type: 'SECURITY_MISMATCH' }]
  });
  assert.equal(securityConflict.status, 'WAIT_RECHECK');

  const websiteConflict = mergeSecondaryClassification(passed, {
    status: 'COMPLETE',
    sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } },
    security: { verdict: 'NO_FATAL_FLAGS' }, conflicts: [{ type: 'WEBSITE_MISMATCH' }]
  });
  assert.equal(websiteConflict.status, 'X_REVIEW');

  const fatalOverridesWaiting = mergeSecondaryClassification({ status: 'WAIT_RECHECK', hardFailed: [], waitingFailed: ['observation'] }, {
    status: 'COMPLETE',
    sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } },
    security: { verdict: 'FATAL' }, conflicts: []
  });
  assert.equal(fatalOverridesWaiting.status, 'HARD_REJECT');

  const unsupported = mergeSecondaryClassification(passed, {
    status: 'DEGRADED',
    sources: { dexScreener: { status: 'UNSUPPORTED' }, goPlus: { status: 'UNSUPPORTED' } },
    security: { verdict: 'UNSUPPORTED' }, conflicts: []
  });
  assert.equal(unsupported.status, 'X_REVIEW');
  assert.match(unsupported.secondaryReason, /仅供人工查看/);
});

test('shadow outcomes sample each requested horizon on time without late backfill', () => {
  const day = 24 * 60 * 60_000;
  const baselineAt = 1_800_000_000_000;
  let outcomes = [{ address: 'token', baselineAt, baselinePrice: 100, initialDecision: 'X_REVIEW', samples: {} }];

  outcomes = updateOutcomeTracking(outcomes, new Map([['token', { price: 110 }]]), baselineAt + 31 * 60_000, 7 * day);
  assert.ok(Math.abs(outcomes[0].samples.m30.return - .10) < 1e-12);
  assert.equal(outcomes[0].samples.h2, undefined);

  outcomes = updateOutcomeTracking(outcomes, new Map([['token', { price: 90 }]]), baselineAt + 2 * 60 * 60_000 + 2 * 60_000, 7 * day);
  assert.ok(Math.abs(outcomes[0].samples.h2.return + .10) < 1e-12);
  assert.ok(Math.abs(outcomes[0].samples.m30.return - .10) < 1e-12);

  outcomes = updateOutcomeTracking(outcomes, new Map([['token', { price: 130 }]]), baselineAt + day + 3 * 60_000, 7 * day);
  assert.ok(Math.abs(outcomes[0].samples.h24.return - .30) < 1e-12);
  assert.ok(Math.abs(outcomes[0].samples.h2.return + .10) < 1e-12);

  const lateOnly = updateOutcomeTracking(
    [{ address: 'late', baselineAt, baselinePrice: 100, initialDecision: 'X_REVIEW', samples: {} }],
    new Map([['late', { price: 125 }]]), baselineAt + day, 7 * day
  )[0];
  assert.equal(lateOnly.samples.m30, undefined);
  assert.equal(lateOnly.samples.h2, undefined);
  assert.equal(lateOnly.samples.h24.return, .25);
});

test('only X_REVIEW creates a shadow cohort while later decisions still update its audit trail', () => {
  const now = 1_800_000_000_000;
  const base = { address: 'token', chain: 'sol', symbol: 'DOG', price: 1, auditedAt: now, deep: { failed: [] } };
  const outcomes = [];
  upsertOutcome(outcomes, { ...base, status: 'WAIT_RECHECK' }, now);
  upsertOutcome(outcomes, { ...base, address: 'rejected', status: 'HARD_REJECT' }, now);
  assert.equal(outcomes.length, 0);

  upsertOutcome(outcomes, { ...base, status: 'X_REVIEW' }, now);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].initialDecision, 'X_REVIEW');
  upsertOutcome(outcomes, { ...base, status: 'WAIT_RECHECK', auditedAt: now + 1 }, now + 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].latestDecision, 'WAIT_RECHECK');

  const legacyMixedCohort = [{ address: 'legacy', baselineAt: now, baselinePrice: 1, samples: {} }];
  assert.deepEqual(updateOutcomeTracking(legacyMixedCohort, new Map(), now, 7 * 24 * 60 * 60_000), []);
});

test('calibration readiness requires 50 completed samples at all three declared horizons', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    address: `token-${index}`,
    initialDecision: 'X_REVIEW',
    samples: { m30: { return: .1 }, h2: { return: .05 }, ...(index < 49 ? { h24: { return: -.02 } } : {}) }
  }));
  const incomplete = summarizeOutcomes(rows);
  assert.equal(incomplete.tracked, 50);
  assert.equal(incomplete.completed30m, 50);
  assert.equal(incomplete.completed2h, 50);
  assert.equal(incomplete.completed24h, 49);
  assert.equal(incomplete.calibrationReady, false);

  rows[49].samples.h24 = { return: .03 };
  assert.equal(summarizeOutcomes(rows).calibrationReady, true);
});

test('Solana outcome matching preserves base58 address case while EVM keys remain case-insensitive', () => {
  const now = 1_800_000_000_000;
  const sol = 'So11111111111111111111111111111111111111112';
  const lowerSol = sol.replace(/^S/, 's');
  const solOutcome = [{ address: sol, baselineAt: now, baselinePrice: 1, initialDecision: 'X_REVIEW', samples: {} }];
  const exact = updateOutcomeTracking(solOutcome, new Map([[sol, { price: 2 }], [lowerSol, { price: 99 }]]), now + 30 * 60_000, 7 * 24 * 60 * 60_000)[0];
  assert.equal(exact.samples.m30.return, 1);

  const evm = '0xAa00000000000000000000000000000000000000';
  const evmOutcome = [{ address: evm, baselineAt: now, baselinePrice: 1, initialDecision: 'X_REVIEW', samples: {} }];
  const evmKey = evm.toLowerCase();
  const matched = updateOutcomeTracking(evmOutcome, new Map([[evmKey, { price: 1.5 }]]), now + 30 * 60_000, 7 * 24 * 60 * 60_000)[0];
  assert.equal(matched.samples.m30.return, .5);
});
