import test from 'node:test';
import assert from 'node:assert/strict';
import { SecondaryValidator, secondaryChainSupport } from '../src/secondary.mjs';

const evmAddress = '0x1111111111111111111111111111111111111111';
const otherEvmAddress = '0x2222222222222222222222222222222222222222';
const solAddress = 'So11111111111111111111111111111111111111112';

function jsonResponse(value, { status = 200, contentType = 'application/json', contentLength } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const headers = new Map([
    ['content-type', contentType],
    ['content-length', String(contentLength ?? Buffer.byteLength(body, 'utf8'))]
  ]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => body
  };
}

function safeEvmSecurity(overrides = {}) {
  return {
    is_honeypot: '0',
    is_open_source: '1',
    is_mintable: '0',
    owner_change_balance: '0',
    hidden_owner: '0',
    cannot_sell_all: '0',
    selfdestruct: '0',
    external_call: '0',
    slippage_modifiable: '0',
    personal_slippage_modifiable: '0',
    transfer_pausable: '0',
    is_blacklisted: '0',
    trading_cooldown: '0',
    buy_tax: '0.01',
    sell_tax: '0.02',
    ...overrides
  };
}

function completeDexPair(overrides = {}) {
  return {
    chainId: 'bsc',
    dexId: 'pancakeswap',
    pairAddress: '0x3333333333333333333333333333333333333333',
    url: 'https://dexscreener.com/bsc/pair',
    baseToken: { address: evmAddress, symbol: 'DOG', name: 'Test Dog' },
    priceUsd: '0.000012',
    marketCap: 50_000,
    fdv: 52_000,
    liquidity: { usd: 12_000 },
    info: {
      websites: [
        { url: 'https://dog.example' },
        { url: 'javascript:alert(1)' },
        { url: 'https://dog.example' }
      ]
    },
    upstream_private_field: 'must-not-leak',
    ...overrides
  };
}

test('BSC validation selects the highest-liquidity matching pair and exposes only allowlisted fields', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.includes('dexscreener.com')) {
      return jsonResponse([
        completeDexPair({ liquidity: { usd: 8_000 }, pairAddress: 'low-liquidity' }),
        completeDexPair({ liquidity: { usd: 18_000 }, pairAddress: 'chosen-pair' }),
        completeDexPair({ baseToken: { address: otherEvmAddress }, liquidity: { usd: 999_999 } }),
        completeDexPair({ chainId: 'ethereum', liquidity: { usd: 999_999 } })
      ]);
    }
    return jsonResponse({
      code: 1,
      result: { [evmAddress.toUpperCase()]: { ...safeEvmSecurity(), untrusted_blob: 'must-not-leak' } }
    });
  };
  const validator = new SecondaryValidator({ fetchImpl, now: () => 1234 });
  const result = await validator.validate({ chain: 'bsc', tokenAddress: evmAddress });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.complete, true);
  assert.equal(result.checkedAt, 1234);
  assert.equal(result.sources.dexScreener.status, 'OK');
  assert.equal(result.sources.goPlus.status, 'OK');
  assert.equal(result.market.pairAddress, 'chosen-pair');
  assert.equal(result.market.liquidityUsd, 18_000);
  assert.deepEqual(result.market.websites, ['https://dog.example/']);
  assert.equal(result.security.verdict, 'NO_FATAL_FLAGS');
  assert.equal(result.security.buyTax, 0.01);
  assert.equal(result.security.sellTax, 0.02);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.deepEqual(urls.sort(), [
    `https://api.dexscreener.com/token-pairs/v1/bsc/${evmAddress}`,
    `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${evmAddress}`
  ].sort());
});

test('GoPlus fatal flags are not softened, and conflicting primary market/security data is reported', async () => {
  const fetchImpl = async url => url.includes('dexscreener.com')
    ? jsonResponse([completeDexPair({ priceUsd: '2', marketCap: 80_000, liquidity: { usd: 20_000 }, info: { websites: [{ url: 'https://secondary.example' }] } })])
    : jsonResponse({ code: 1, result: { [evmAddress]: safeEvmSecurity({ is_honeypot: '1', is_open_source: '0' }) } });
  const result = await new SecondaryValidator({ fetchImpl }).validate({
    chain: 'bsc',
    tokenAddress: evmAddress,
    primary: {
      market: { priceUsd: 1, marketCap: 50_000, liquidityUsd: 10_000, website: 'https://primary.example' },
      security: { is_honeypot: false, is_open_source: true }
    }
  });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.security.verdict, 'FATAL');
  assert.deepEqual(result.security.fatal.map(row => row.field).sort(), ['isHoneypot', 'openSource']);
  assert.ok(result.conflicts.some(row => row.type === 'MARKET_MISMATCH' && row.field === 'priceUsd'));
  assert.ok(result.conflicts.some(row => row.type === 'WEBSITE_MISMATCH'));
  assert.ok(result.conflicts.some(row => row.type === 'SECURITY_MISMATCH' && row.field === 'isHoneypot'));
});

test('missing or malformed GoPlus safety fields stay UNKNOWN and degrade the result', async () => {
  const fetchImpl = async url => url.includes('dexscreener.com')
    ? jsonResponse([completeDexPair()])
    : jsonResponse({ code: 1, result: { [evmAddress]: { is_honeypot: 'unknown', is_open_source: '1' } } });
  const result = await new SecondaryValidator({ fetchImpl }).validate({ chain: 'bsc', tokenAddress: evmAddress });

  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.complete, false);
  assert.equal(result.sources.goPlus.status, 'OK');
  assert.equal(result.security.verdict, 'UNKNOWN');
  assert.equal(result.security.fields.isHoneypot, null);
  assert.ok(result.security.unknownFields.includes('isHoneypot'));
  assert.ok(result.security.unknownFields.includes('buyTax'));
});

test('unsupported chains never make external requests', async () => {
  for (const chain of ['robinhood', 'arc', 'stable']) {
    let calls = 0;
    const result = await new SecondaryValidator({ fetchImpl: async () => { calls += 1; throw new Error('must not be called'); } })
      .validate({ chain, tokenAddress: evmAddress });
    assert.equal(calls, 0);
    assert.equal(result.status, 'DEGRADED');
    assert.equal(result.sources.dexScreener.status, 'UNSUPPORTED');
    assert.equal(result.sources.goPlus.status, 'UNSUPPORTED');
  }
});

test('invalid addresses fail before either supported source is called', async () => {
  let calls = 0;
  const result = await new SecondaryValidator({ fetchImpl: async () => { calls += 1; return jsonResponse({}); } })
    .validate({ chain: 'base', tokenAddress: 'not-an-address' });
  assert.equal(calls, 0);
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.sources.dexScreener.errorCode, 'INVALID_ADDRESS');
  assert.equal(result.sources.goPlus.errorCode, 'INVALID_ADDRESS');
});

test('timeouts and upstream parse failures degrade without rejecting the validation call', async () => {
  const neverFetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const timeoutResult = await new SecondaryValidator({ fetchImpl: neverFetch, timeoutMs: 5 })
    .validate({ chain: 'eth', tokenAddress: evmAddress });
  assert.equal(timeoutResult.status, 'DEGRADED');
  assert.equal(timeoutResult.sources.dexScreener.errorCode, 'TIMEOUT');
  assert.equal(timeoutResult.sources.goPlus.errorCode, 'TIMEOUT');

  const malformedFetch = async url => url.includes('dexscreener.com')
    ? jsonResponse('[]', { contentLength: 2_000 })
    : jsonResponse('{ definitely-not-json');
  const malformed = await new SecondaryValidator({ fetchImpl: malformedFetch, maxResponseBytes: 1_024 })
    .validate({ chain: 'eth', tokenAddress: evmAddress });
  assert.equal(malformed.sources.dexScreener.errorCode, 'RESPONSE_TOO_LARGE');
  assert.equal(malformed.sources.goPlus.errorCode, 'INVALID_JSON');
});

test('Solana uses its verified endpoints, preserves address case, and evaluates mint/freeze authority', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.includes('dexscreener.com')) {
      return jsonResponse([
        {
          chainId: 'solana', dexId: 'raydium', pairAddress: 'sol-pair', url: 'https://dexscreener.com/solana/pair',
          baseToken: { address: solAddress, symbol: 'DOG', name: 'Sol Dog' }, priceUsd: '0.01',
          marketCap: 40_000, fdv: 40_000, liquidity: { usd: 9_000 }, info: { websites: [] }
        },
        {
          chainId: 'solana', dexId: 'raydium', pairAddress: 'wrong-case',
          baseToken: { address: solAddress.replace(/^S/, 's') }, priceUsd: '1', marketCap: 9_999_999,
          liquidity: { usd: 9_999_999 }
        }
      ]);
    }
    return jsonResponse({
      code: 1,
      result: {
        mintable: { status: '0' },
        freezable: { status: '0' },
        closable: { status: '0' },
        balance_mutable_authority: { status: '0' },
        transfer_fee_upgradable: { status: '0' },
        non_transferable: { status: '0' }
      }
    });
  };
  const result = await new SecondaryValidator({ fetchImpl }).validate({ chain: 'sol', tokenAddress: solAddress });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.market.pairAddress, 'sol-pair');
  assert.equal(result.security.verdict, 'NO_FATAL_FLAGS');
  assert.equal(result.security.fields.mintable, false);
  assert.equal(result.security.fields.freezable, false);
  assert.equal(result.security.buyTax, null);
  assert.deepEqual(urls.sort(), [
    `https://api.dexscreener.com/token-pairs/v1/solana/${solAddress}`,
    `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${solAddress}`
  ].sort());
});

test('exported support map contains only verified chain identifiers', () => {
  assert.deepEqual(secondaryChainSupport.dexScreener, {
    sol: 'solana', bsc: 'bsc', base: 'base', eth: 'ethereum'
  });
  assert.deepEqual(secondaryChainSupport.goPlus, {
    sol: 'solana', eth: '1', bsc: '56', base: '8453'
  });
});
