import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { normalizeGmgnApiKey } from './gmgn-key-store.mjs';

const CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
const RANGE_OPTIONS = ['min-created', 'max-created', 'min-marketcap', 'max-marketcap', 'min-liquidity'];
const READS = Object.freeze({ info: 'getTokenInfo', security: 'getTokenSecurity', pool: 'getTokenPoolInfo' });

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--raw') continue;
    const key = args[index]?.slice(2);
    if (!args[index]?.startsWith('--') || !allowed.includes(key) || options[key] !== undefined
      || args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error('Unsupported radar read');
    options[key] = args[++index];
  }
  if (!CHAINS.has(options.chain)) throw new Error('Unsupported chain');
  return options;
}

function ranges(options) {
  return Object.fromEntries(RANGE_OPTIONS.filter(key => options[key] !== undefined).map(key => {
    const value = key.endsWith('created') ? options[key] : Number(options[key]);
    if (typeof value === 'number' ? !Number.isFinite(value) || value < 0 : !/^\d+(?:\.\d+)?[sm]$/.test(value)) {
      throw new Error('Invalid radar range');
    }
    return [key.replaceAll('-', '_'), value];
  }));
}

// This allowlist covers only the existing scanner reads. There is deliberately
// no generic client-method dispatcher, wallet operation or transaction route.
export async function executeReadOnly(client, args) {
  const [group, command, ...rest] = args;
  if (group === 'auth' && command === 'verify-read') {
    if (rest.length && !(rest.length === 1 && rest[0] === '--raw')) throw new Error('Unsupported radar read');
    // The radar only needs read access. Do not use follow-wallet here: that is
    // a signed /trade route with a heavier, separate limiter and is unrelated
    // to the market scanner. The Agent public-key pairing still happens when
    // the user creates the API key; this call only proves the key can read.
    await client.getUserInfo();
    return { verified: true };
  }
  if (group === 'token' && [...Object.keys(READS), 'holders', 'traders'].includes(command)) {
    const opts = parseOptions(rest, ['chain', 'address', 'limit']);
    const valid = opts.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-f0-9]{40}$/i;
    if (!valid.test(opts.address || '')) throw new Error('Invalid address');
    if (READS[command]) return client[READS[command]](opts.chain, opts.address);
    const limit = Number(opts.limit || 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
    const method = command === 'holders' ? 'getTokenTopHolders' : 'getTokenTopTraders';
    return client[method](opts.chain, opts.address, { limit, order_by: 'amount_percentage', direction: 'desc' });
  }
  if (group === 'market' && command === 'kline') {
    const opts = parseOptions(rest, ['chain', 'address', 'resolution', 'from', 'to']);
    const valid = opts.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-f0-9]{40}$/i;
    if (!valid.test(opts.address || '') || opts.resolution !== '1m') throw new Error('Invalid candle request');
    const from = Number(opts.from), to = Number(opts.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw new Error('Invalid candle range');
    return client.getTokenKline(opts.chain, opts.address, opts.resolution, from * 1000, to * 1000);
  }
  if (group === 'market' && command === 'trending') {
    const opts = parseOptions(rest, ['chain', 'interval', 'limit', 'order-by', 'direction', ...RANGE_OPTIONS]);
    const limit = Number(opts.limit || 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !['1m', '5m'].includes(opts.interval)) throw new Error('Invalid discovery request');
    return client.getTrendingSwaps(opts.chain, opts.interval, {
      limit, ...(opts['order-by'] ? { order_by: opts['order-by'] } : {}),
      ...(opts.direction ? { direction: opts.direction } : {}), ...ranges(opts)
    });
  }
  if (group === 'market' && command === 'trenches') {
    const opts = parseOptions(rest, ['chain', 'type', 'limit', 'filter-preset', 'sort-by', 'direction', ...RANGE_OPTIONS]);
    const limit = Number(opts.limit || 80);
    if (!Number.isInteger(limit) || limit < 1 || limit > 80 || opts.type !== 'completed'
      || opts['filter-preset'] !== 'safe' || opts['sort-by'] !== 'volume_1h' || opts.direction !== 'desc') throw new Error('Invalid discovery request');
    const data = await client.getTrenches(opts.chain, ['completed'], undefined, limit, {
      max_rug_ratio: 0.3, max_bundler_rate: 0.3, max_insider_ratio: 0.3, ...ranges(opts)
    });
    return Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key,
      Array.isArray(value) ? [...value].sort((a, b) => Number(b.volume_1h || 0) - Number(a.volume_1h || 0)) : value
    ]));
  }
  throw new Error('Unsupported radar read');
}

async function main() {
  try {
    // Import the official client, never its global configuration or CLI entry.
    // Pinning the package makes this internal client interface reproducible.
    const { OpenApiClient } = await import('gmgn-cli/dist/client/OpenApiClient.js');
    const { printResult } = await import('gmgn-cli/dist/output.js');
    const apiKey = normalizeGmgnApiKey(process.env.GMGN_API_KEY);
    if (!apiKey) throw new Error('invalid api key');
    const privateKeyPem = String(process.env.GMGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    delete process.env.GMGN_DEBUG;
    delete process.env.GMGN_PRIVATE_KEY;
    const client = new OpenApiClient({ apiKey, privateKeyPem: privateKeyPem || undefined, host: 'https://openapi.gmgn.ai' });
    const execute = client.executePreparedRequest.bind(client);
    client.executePreparedRequest = prepare => execute(prepare, false);
    const data = await executeReadOnly(client, process.argv.slice(2));
    printResult(data, true);
  } catch (error) {
    const { translateGmgnError } = await import('./gmgn.mjs');
    const safe = translateGmgnError(error);
    process.stderr.write(JSON.stringify({ code: safe.code, retryAfterMs: safe.retryAfterMs }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
