// A conservative preference filter, not a fraud diagnosis. Reuses the existing
// completed 1m sample; it makes no claim about unseen or second-level history.
export const CHART_RISK_VERSION = 1;
export function applyRiskExclusion(row, exclusions = {}, chain = row.chain) {
  const address = String(row.address || '').trim();
  const held = exclusions[`${chain}:${chain === 'sol' ? address : address.toLowerCase()}`];
  if (!held) return row;
  return { ...row, status: 'HARD_REJECT', decisionReason: held.reasons.join('；'),
    deep: { ...row.deep, chainPass: false, checks: { ...row.deep?.checks, chartRisk: false },
      failed: [...new Set([...(row.deep?.failed || []), 'chartRisk'])],
      chartRisk: { ...held, status: 'REJECT', pass: false } } };
}
const minute = 60_000;
const number = value => (typeof value !== 'number' && typeof value !== 'string')
  || (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function chartRiskScreen(candles, now = Date.now()) {
  const rows = new Map();
  let invalid = !Array.isArray(candles), conflict = false;
  for (const raw of Array.isArray(candles) ? candles : []) {
    let time = number(raw?.time ?? raw?.t);
    if (time !== null && time < 1e12) time *= 1000;
    const row = { time, open: number(raw?.open ?? raw?.o), high: number(raw?.high ?? raw?.h),
      low: number(raw?.low ?? raw?.l), close: number(raw?.close ?? raw?.c), volume: number(raw?.volume ?? raw?.v) };
    if (!(time > 0) || time > now + minute || [row.open, row.high, row.low, row.close].some(n => !(n > 0))
      || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)
      || row.volume === null || row.volume < 0) { invalid = true; continue; }
    if (time + minute > now) continue; // Do not judge a still-forming candle.
    const old = rows.get(time);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) conflict = true;
    rows.set(time, row);
  }
  const bars = [...rows.values()].sort((a, b) => a.time - b.time);
  const gap = bars.some((b, i) => i && Math.abs(b.time - bars[i - 1].time - minute) > 1000);
  const priceGap = bars.some((b, i) => i && Math.abs(b.open / bars[i - 1].close - 1) >= .35);
  const base = { version: CHART_RISK_VERSION, bars: bars.length, from: bars[0]?.time || 0,
    to: bars.at(-1) ? bars.at(-1).time + minute : 0, scope: 'observed_1m_window', reasons: [], codes: [] };
  if (invalid || conflict || gap || priceGap || bars.length < 5 || bars.filter(b => b.volume > 0).length < 4 || now - base.to > 2 * minute) {
    return { ...base, pass: false, status: 'UNKNOWN', reasons: ['形态数据不足、冲突、断档或过期，等待复核'],
      unknownFields: ['chartRisk.candles'] };
  }
  const codes = [], reasons = [];
  // A vertical 1m jump followed by at least three narrow plateau closes.
  for (let i = 0; i < bars.length - 3; i++) {
    const bar = bars[i], after = bars.slice(i + 1, i + 4);
    const anchor = bar.open;
    const jump = bar.close / anchor - 1;
    const closes = [bar.close, ...after.map(b => b.close)];
    if (bar.volume > 0 && after.every(b => b.volume > 0) && jump >= .35 && Math.max(...closes) / Math.min(...closes) - 1 <= .15
      && after.at(-1).close / anchor >= 1.30) {
      codes.push('VERTICAL_PLATEAU'); reasons.push('单分钟跳升≥35%后窄幅平台，按风险偏好排除'); break;
    }
  }
  // Only earlier CLOSES establish a peak. Two later closes must both be below
  // 40% of that peak; an unordered high/low in one candle cannot prove a dump.
  let peak = bars[0].volume > 0 ? bars[0].close : 0, maxConfirmedDrawdown = 0;
  for (let i = 1; i < bars.length - 1; i++) {
    const drawdown = peak > 0 ? 1 - Math.max(bars[i].close, bars[i + 1].close) / peak : 0;
    maxConfirmedDrawdown = Math.max(maxConfirmedDrawdown, drawdown);
    if (bars[i].volume > 0 && bars[i + 1].volume > 0 && drawdown >= .60) {
      codes.push('SUSTAINED_COLLAPSE'); reasons.push('已观测收盘高点后连续两根回撤≥60%，保留风险排除'); break;
    }
    if (bars[i].volume > 0) peak = Math.max(peak, bars[i].close);
  }
  return { ...base, pass: codes.length === 0, status: codes.length ? 'REJECT' : 'CLEAR_IN_WINDOW',
    codes, reasons, maxConfirmedDrawdown, unknownFields: [] };
}
