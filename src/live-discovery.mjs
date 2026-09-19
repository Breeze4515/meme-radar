import { normalizeList } from './gmgn.mjs';
import { discoveryScreen, knownRiskReasons } from './scoring.mjs';
import { config } from './config.mjs';

const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const count = value => { const n = number(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const rate = value => { const n = number(value); return n !== null && n >= 0 && n <= 1 ? n : null; };
const flag = value => ['1', 'true', 'yes'].includes(String(value).toLowerCase()) ? true
  : ['0', 'false', 'no'].includes(String(value).toLowerCase()) ? false : null;
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const safeText = (value, max) => /gmgn_[a-z0-9]{8,}|bearer\s|api[_ -]?key|private[_ -]?key/i.test(String(value)) ? '?' : text(value, max);
const identity = (chain, value) => chain === 'sol' ? value : value.toLowerCase();
const addressValid = (chain, value) => typeof value === 'string' && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(value);
const safeUrl = value => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href.slice(0, 500) : ''; }
  catch { return ''; }
};

export function liveRequestArgs(chain) {
  return ['market', 'trending', '--chain', chain, '--interval', '1m', '--limit', '100',
    '--order-by', 'volume', '--direction', 'desc', '--min-created', '5m',
    '--min-marketcap', '10000', '--max-marketcap', '500000', '--min-liquidity', '3000', '--raw'];
}

// This is a discovery snapshot, never an audit verdict. No extra per-token reads.
export function normalizeLiveRows(input, chain, previous = [], at = Date.now(), initialized = false) {
  const before = new Map(previous.map(row => [identity(chain, row.address), row]));
  const unique = new Map();
  for (const raw of input.slice(0, 100)) {
    if (!raw || !addressValid(chain, raw.address) || (raw.chain && raw.chain !== chain)) continue;
    const address = identity(chain, raw.address);
    if (knownRiskReasons(raw, config).length) continue;
    const mc = number(raw.market_cap), liquidity = number(raw.liquidity), created = number(raw.creation_timestamp);
    if (mc === null || mc < 10000 || mc > 500000 || liquidity === null || liquidity < 3000
      || created === null || created <= 0 || at / 1000 - created < 300) continue;
    if (flag(raw.is_wash_trading) === true || (chain !== 'sol' && flag(raw.is_honeypot) === true)
      || [raw.rug_ratio, raw.bundler_rate, raw.rat_trader_amount_rate].some(value => rate(value) !== null && rate(value) > .3)) continue;
    const old = before.get(address);
    const elapsed = old ? at - old.observedAt : 0;
    const comparable = elapsed >= 5000 && elapsed <= 120000;
    const price = number(raw.price), holders = count(raw.holder_count), smart = count(raw.smart_degen_count);
    const hasUnknownRisk = [raw.rug_ratio, raw.bundler_rate, raw.rat_trader_amount_rate].some(value => rate(value) === null)
      || flag(raw.is_wash_trading) === null || (chain !== 'sol' && flag(raw.is_honeypot) === null);
    unique.set(address, {
      address, chain, symbol: safeText(raw.symbol || '?', 30), name: safeText(raw.name, 80),
      marketCap: mc, liquidity, createdAt: created, price: price !== null && price > 0 ? price : null,
      volume1m: number(raw.volume) >= 0 ? number(raw.volume) : null,
      buys1m: count(raw.buys), sells1m: count(raw.sells), swaps1m: count(raw.swaps), holders, smartMoney: smart,
      observedAt: at, firstSeenAt: old?.firstSeenAt || at,
      newAt: old?.newAt || (initialized && !old ? at : 0),
      deltaWindowMs: comparable ? elapsed : null,
      priceDelta: comparable && price > 0 && old.price > 0 ? price / old.price - 1 : null,
      holdersDelta: comparable && holders !== null && old.holders !== null ? holders - old.holders : null,
      smartDelta: comparable && smart !== null && old.smartMoney !== null ? smart - old.smartMoney : null,
      priorityBand: mc >= 20000 && mc <= 80000, hasUnknownRisk,
      website: safeUrl(raw.website), twitter: safeText(raw.twitter_username, 80),
      auditEligible: discoveryScreen(raw, { ...config, chain }, at / 1000).pass
    });
  }
  return [...unique.values()].sort((a, b) => (b.volume1m || 0) - (a.volume1m || 0));
}

export class LiveDiscovery {
  constructor({ gmgn, settings = config, now = Date.now, intervalMs = 20000, leaseMs = 30000, schedule = setTimeout, cancel = clearTimeout }) {
    this.gmgn = gmgn; this.settings = settings; this.now = now; this.intervalMs = Math.max(20000, intervalMs);
    this.leaseMs = leaseMs; this.schedule = schedule; this.cancel = cancel;
    this.states = new Map(); this.raw = new Map(); this.focus = ''; this.leaseUntil = 0;
    this.nextPollAt = 0; this.running = false; this.timer = null; this.stopped = false; this.epoch = gmgn.keyEpoch;
  }

  syncCredentials() {
    if (this.epoch !== this.gmgn.keyEpoch) {
      this.states.clear(); this.raw.clear(); this.epoch = this.gmgn.keyEpoch;
    }
  }

  touch(chain) {
    if (!this.settings.supportedChains.includes(chain)) throw new Error('unsupported_chain');
    this.syncCredentials(); this.focus = chain; this.leaseUntil = this.now() + this.leaseMs;
    if (!this.timer && !this.running && !this.stopped) this.arm();
    return this.snapshot(chain);
  }

  arm() {
    if (this.stopped || !this.focus || this.now() >= this.leaseUntil) return;
    const wait = Math.max(0, this.nextPollAt - this.now(), (this.gmgn.nextAllowedAt || 0) - this.now());
    this.timer = this.schedule(() => { this.timer = null; void this.poll(); }, wait);
    this.timer?.unref?.();
  }

  async poll() {
    if (this.running || this.stopped || !this.focus || this.now() >= this.leaseUntil) return;
    if (this.now() < this.nextPollAt || this.now() < (this.gmgn.nextAllowedAt || 0)) { this.arm(); return; }
    this.syncCredentials();
    const chain = this.focus, at = this.now(), epoch = this.gmgn.keyEpoch;
    const old = this.states.get(chain) || { rows: [], lastSuccessAt: 0, pollCount: 0 };
    this.running = true; this.nextPollAt = at + this.intervalMs;
    this.states.set(chain, { ...old, status: 'LOADING', lastAttemptAt: at });
    try {
      if (!await this.gmgn.configured()) {
        this.states.set(chain, { ...old, status: 'AUTH_REQUIRED', lastAttemptAt: at }); return;
      }
      const result = await this.gmgn.run(liveRequestArgs(chain), { deadline: Date.now() + 25000 });
      if (this.stopped || epoch !== this.gmgn.keyEpoch) return;
      let payload = result;
      for (let i = 0; i < 3 && payload && !Array.isArray(payload) && payload.data != null; i++) payload = payload.data;
      if (!Array.isArray(payload) && !Array.isArray(payload?.rank)) throw new Error('invalid_live_response');
      const input = normalizeList(result, ['rank']);
      const now = this.now();
      const rows = normalizeLiveRows(input, chain, old.rows, now, old.lastSuccessAt > 0);
      this.states.set(chain, { rows, status: 'READY', lastAttemptAt: at, lastSuccessAt: now,
        requestMs: now - at, pollCount: old.pollCount + 1, receivedCount: input.length, filteredCount: Math.max(0, input.length - rows.length) });
      this.raw.set(chain, new Map(input.filter(row => row && addressValid(chain, row.address) && rows.some(x => identity(chain, row.address) === x.address))
        .map(row => [identity(chain, row.address), row])));
    } catch (error) {
      if (this.stopped || epoch !== this.gmgn.keyEpoch) return;
      const status = error.code === 'GMGN_RATE_LIMITED' ? 'RATE_LIMITED'
        : ['GMGN_AUTH_FAILED', 'GMGN_PERMISSION_DENIED'].includes(error.code) ? 'AUTH_REQUIRED' : 'ERROR';
      this.states.set(chain, { ...old, status, lastAttemptAt: at });
      this.nextPollAt = Math.max(this.nextPollAt, this.now() + (status === 'AUTH_REQUIRED' ? 60000 : status === 'ERROR' ? 30000 : error.retryAfterMs || 0));
    } finally { this.running = false; this.arm(); }
  }

  snapshot(chain) {
    this.syncCredentials();
    const state = this.states.get(chain) || { status: 'WAITING', rows: [], lastSuccessAt: 0, pollCount: 0 };
    return structuredClone({ ...state, chain, intervalMs: this.intervalMs, execution: false,
      nextPollAt: Math.max(this.nextPollAt, this.gmgn.nextAllowedAt || 0),
      status: this.gmgn.disabled ? 'AUTH_REQUIRED' : this.gmgn.nextAllowedAt > this.now() ? 'RATE_LIMITED' : state.status,
      stale: !state.lastSuccessAt || this.now() - state.lastSuccessAt > 60000 });
  }

  auditRow(chain, address) {
    this.syncCredentials();
    const snapshot = this.snapshot(chain);
    if (snapshot.stale || this.gmgn.disabled || snapshot.status === 'AUTH_REQUIRED') return null;
    const row = this.raw.get(chain)?.get(identity(chain, address));
    if (!row) return null;
    // Interval-specific counters must never masquerade as five-minute counters.
    const { volume, swaps, buys, sells, price_change_percent, ...audit } = row;
    return structuredClone(audit);
  }

  stop() { this.stopped = true; if (this.timer) this.cancel(this.timer); this.timer = null; }
}
