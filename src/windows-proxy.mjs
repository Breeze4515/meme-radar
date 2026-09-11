import { execFileSync } from 'node:child_process';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const GMGN_ORIGIN = 'https://openapi.gmgn.ai/';

export function normalizeProxyUrl(value) {
  let candidate = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!candidate || /^(?:direct|none)$/i.test(candidate)) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) return '';
    return parsed.href;
  } catch { return ''; }
}

export function parseWindowsProxyServer(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const entries = Object.fromEntries(raw.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const split = part.indexOf('=');
    return split < 0 ? ['default', part] : [part.slice(0, split).toLowerCase(), part.slice(split + 1)];
  }));
  return normalizeProxyUrl(entries.https || entries.http || entries.default || '');
}

function registryValue(output, type) {
  const line = String(output || '').split(/\r?\n/).find(row => row.includes(type));
  return line ? line.slice(line.indexOf(type) + type.length).trim() : '';
}

export function detectWindowsSystemProxy({ platform = process.platform, env = process.env, run = execFileSync } = {}) {
  const existing = PROXY_ENV_KEYS.map(key => env[key]).find(Boolean);
  if (existing) return { proxy: normalizeProxyUrl(existing), source: 'environment' };
  if (platform !== 'win32') return { proxy: '', source: 'not-windows' };

  // Resolve the effective WinINET proxy first. This covers ordinary manual
  // proxies and most PAC configurations used by desktop VPN applications.
  try {
    const script = "$u=[Uri]'https://openapi.gmgn.ai/';$p=[System.Net.WebRequest]::GetSystemWebProxy().GetProxy($u);if($p -and $p.AbsoluteUri -ne $u.AbsoluteUri){[Console]::Out.Write($p.AbsoluteUri)}";
    const proxy = normalizeProxyUrl(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    }));
    if (proxy) return { proxy, source: 'windows-system' };
  } catch {}

  // PowerShell can be disabled by policy, so retain a registry fallback for
  // the common ProxyEnable + ProxyServer configuration.
  try {
    const enabled = registryValue(run('reg.exe', ['query', INTERNET_SETTINGS, '/v', 'ProxyEnable'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000
    }), 'REG_DWORD');
    if (!/(?:0x)?1$/i.test(enabled)) return { proxy: '', source: 'windows-direct' };
    const value = registryValue(run('reg.exe', ['query', INTERNET_SETTINGS, '/v', 'ProxyServer'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000
    }), 'REG_SZ');
    const proxy = parseWindowsProxyServer(value);
    return { proxy, source: proxy ? 'windows-registry' : 'windows-direct' };
  } catch { return { proxy: '', source: 'windows-unknown' }; }
}

export function configureWindowsSystemProxy(options = {}) {
  const env = options.env || process.env;
  const detected = detectWindowsSystemProxy({ ...options, env });
  if (!detected.proxy || detected.source === 'environment') return detected;
  env.HTTPS_PROXY = detected.proxy;
  env.HTTP_PROXY = detected.proxy;
  if (!env.NO_PROXY && !env.no_proxy) env.NO_PROXY = '127.0.0.1,localhost';
  return detected;
}
