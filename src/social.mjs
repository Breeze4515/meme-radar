import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function xCapability() {
  try {
    const { stdout } = await execFileAsync('agent-reach', ['doctor', '--json'], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout)?.twitter || {};
    return {
      available: result.status === 'ok' && Boolean(result.active_backend),
      backend: result.active_backend || '',
      reason: result.active_backend ? result.message || '' : '未配置可用的X只读后端'
    };
  } catch {
    return { available: false, backend: '', reason: 'X只读检查暂时不可用，候选只能进入人工复核' };
  }
}

export function socialGate({ twitter, followerCount = 0, duplicateSocial = null, capability }) {
  if (!twitter) return { status: 'FAIL', score: 0, reason: '没有X账号' };
  if (duplicateSocial === true) return { status: 'FAIL', score: 0, reason: '社媒链接疑似复用' };
  if (!capability?.available) {
    return { status: 'UNVERIFIED', score: 0, reason: capability?.reason || '无法读取X评论，不能确认真人社区' };
  }
  return {
    status: 'UNVERIFIED', score: 0,
    reason: `已检测到X后端${capability.backend}，评论真实性解析器尚未完成联调`
  };
}
