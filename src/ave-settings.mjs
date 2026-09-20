import { mkdirSync, lstatSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only these two documented GETs are reachable. No quote, approval, signing,
// broadcasting, custom host or automatic scanner calls in this connector.
export const AVE_CHECKS = Object.freeze({
  data: { url: 'https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc', header: 'X-API-KEY' },
  trade: { url: 'https://bot-api.ave.ai/v1/thirdParty/chainWallet/getGasTip', header: 'AVE-ACCESS-KEY' },
});
export class AveError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const failure = (code, message, status) => { throw new AveError(code, message, status); };
const keyValue = value => {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(value.trim()))
    failure('AVE_KEY', '请填写 AVE API Key，不是钱包私钥或助记词');
  return value.trim();
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateAveCheck(kind, body) {
  if (kind === 'data') {
    const token = body?.data?.token, price = token?.current_price_usd;
    if (body?.status !== 1 || !object(token) || token.chain !== 'bsc'
      || !['number', 'string'].includes(typeof price) || !String(price).trim()
      || !Number.isFinite(Number(price)) || Number(price) <= 0
      || (token.token !== undefined && (typeof token.token !== 'string' || token.token.toLowerCase() !== '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')))
      failure('AVE_SCHEMA', 'AVE 行情响应未通过校验', 502);
  } else if (kind === 'trade') {
    if (body?.status !== 200 || !Array.isArray(body.data) || !body.data.length
      || !body.data.every(row => object(row) && typeof row.chain === 'string'
        && ['high', 'average', 'low'].every(k => typeof row[k] === 'string' && /^\d+$/.test(row[k]))))
      failure('AVE_SCHEMA', 'AVE 交易服务只读响应未通过校验', 502);
  } else failure('AVE_KIND', '未知 AVE 接口类型');
}
export function createAveSettings({ directory, fetchImpl = fetch, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const file = join(directory, 'ave-credentials.json');
  let key = '', requiresReentry = false, health = {}, busy = false, nextAt = 0;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid AVE configuration');
    chmodSync(file, 0o600);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.schema === 2 && typeof value.key === 'string') {
      key = value.key ? keyValue(value.key) : '';
    } else if (value.schema === 1 && object(value.keys)
      && !Object.keys(value.keys).some(k => !Object.hasOwn(AVE_CHECKS, k))) {
      // Migrate identical/one-sided legacy credentials in memory only. Never
      // arbitrarily choose between two different saved secrets or erase either.
      const unique = [...new Set(Object.values(value.keys).map(keyValue))];
      if (unique.length > 1) requiresReentry = true;
      else key = unique[0] || '';
    } else throw new Error('Invalid AVE configuration');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('AVE 本机配置无法读取；原文件保留');
  }
  const save = updated => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Invalid configuration directory');
    chmodSync(directory, 0o700);
    const temporary = join(directory, 'ave-credentials-' + randomUUID() + '.tmp');
    writeFileSync(temporary, JSON.stringify({ schema: 2, key: updated }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
    key = updated; requiresReentry = false;
  };
  const snapshot = () => ({
    configured: Boolean(key), requiresReentry, hasStoredKey: Boolean(key) || requiresReentry,
    data: { configured: Boolean(key), status: 'untested', ...health.data },
    trade: { configured: Boolean(key), status: 'untested', ...health.trade },
    executionReady: false,
    executionReason: 'AVE 钱包签名尚未接入，站内实盘已锁定；GMGN 仅作信号扫描',
  });
  const safeError = e => e instanceof AveError ? e : new AveError('AVE_CONNECT', 'AVE 连接失败，请检查网络', 502);
  async function check(kind, candidate) {
    const endpoint = AVE_CHECKS[kind];
    const response = await fetchImpl(endpoint.url, { method: 'GET', headers: { [endpoint.header]: candidate, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12000) });
    if ([401, 403].includes(response.status)) failure('AVE_AUTH', 'AVE Key 或该接口权限未通过', 400);
    if (response.status === 429) { nextAt = now() + 60000; failure('AVE_RATE_LIMIT', 'AVE 已限流，冷却一分钟；不会自动重试', 429); }
    if (!response.ok) failure('AVE_UPSTREAM', 'AVE 服务暂不可用', 502);
    if (Number(response.headers?.get('content-length')) > 1_000_000) failure('AVE_SCHEMA', 'AVE 响应过大，已停止读取', 502);
    let content = '';
    for await (const chunk of response.body) {
      content += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(content) > 1_000_000) failure('AVE_SCHEMA', 'AVE 响应过大，已停止读取', 502);
    }
    let data; try { data = JSON.parse(content); } catch { failure('AVE_SCHEMA', 'AVE 返回内容无法解析', 502); }
    validateAveCheck(kind, data);
    return { status: 'connected', checkedAt: now(), message: kind === 'data'
      ? '行情接口测试通过；本次查询约 5 CU，不代表可下单'
      : '交易服务只读测试通过；未验证下单权限，未发送订单' };
  }
  async function configure(body, checkAuthority = () => {}) {
    if (!object(body) || Object.keys(body).some(k => k !== 'key')) failure('AVE_INPUT', 'AVE 配置格式错误，请刷新页面');
    const candidate = body.key === '' || body.key === undefined ? key : keyValue(body.key);
    if (!candidate) failure('AVE_KEY', requiresReentry ? '旧配置有两把不同 Key，请重新填写一个 AVE API Key' : '请先填写 AVE API Key');
    if (busy) failure('AVE_BUSY', 'AVE 测试正在进行，请稍候', 409);
    if (nextAt > now()) failure('AVE_COOLDOWN', 'AVE 请求冷却中，请稍后再试', 429);
    checkAuthority();
    busy = true; nextAt = now() + 2000;
    const results = {};
    try {
      for (const kind of ['data', 'trade']) {
        // Respect 1 request/sec across the two services; stop on rate limiting.
        if (kind === 'trade') {
          if (results.data.code === 'AVE_RATE_LIMIT') {
            results.trade = { status: 'untested', message: '行情接口限流，本次未测试交易服务' };
            break;
          }
          await pause(1100);
        }
        checkAuthority();
        try { results[kind] = await check(kind, candidate); }
        catch (e) {
          const safe = safeError(e);
          results[kind] = { status: 'error', checkedAt: now(), message: safe.message, code: safe.code };
        }
      }
      checkAuthority();
      if (!Object.values(results).some(result => result.status === 'connected')) {
        // These results only describe the saved key if the attempted key matches.
        if (candidate === key) health = results;
        const limited = results.data.code === 'AVE_RATE_LIMIT' || results.trade?.code === 'AVE_RATE_LIMIT';
        failure(limited ? 'AVE_RATE_LIMIT' : 'AVE_CHECK_FAILED', 'AVE 测试未通过，原 Key 保留；请检查 Key、权限和网络', limited ? 429 : 502);
      }
      // One credential, one atomic commit, two independently verified capabilities.
      try { save(candidate); } catch { failure('AVE_STORAGE', 'AVE 本机保存失败，原 Key 保留', 503); }
      health = results;
      return snapshot();
    } finally { busy = false; }
  }
  function remove(body) {
    if (!object(body) || Object.keys(body).length) failure('AVE_INPUT', 'AVE 配置格式错误，请刷新页面');
    if (busy) failure('AVE_BUSY', '请等待当前 AVE 测试结束再移除', 409);
    save(''); health = {};
    return snapshot();
  }
  return { snapshot, configure, remove };
}
