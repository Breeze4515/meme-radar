import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', '.runtime', 'node_modules']);
const forbiddenEntries = ['state', 'logs', '.env', '.npmrc'];
const textExtensions = new Set(['', '.bat', '.command', '.css', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.txt']);
const findings = [];

for (const entry of forbiddenEntries) {
  if (fs.existsSync(path.join(root, entry))) findings.push(`不应出现在发布包中：${entry}`);
}

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) { visit(absolute); continue; }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name === 'package-lock.json') continue;
    const relative = path.relative(root, absolute);
    const content = fs.readFileSync(absolute, 'utf8');
    if (/\/(?:Users|home)\/[^/\s'"`]+\//.test(content) || /[A-Z]:\\Users\\[^\\\s'"`]+\\/i.test(content)) {
      findings.push(`包含个人电脑绝对路径：${relative}`);
    }
    if (/gmgn_[a-z0-9]{20,}/i.test(content)) findings.push(`疑似包含 GMGN API Key：${relative}`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{40,}/.test(content)) findings.push(`疑似包含私钥：${relative}`);
  }
}

visit(root);

if (findings.length) {
  console.error('发布审计未通过：');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log('发布内容审计通过：未发现运行状态、日志、个人绝对路径、GMGN Key 或私钥。');
}
