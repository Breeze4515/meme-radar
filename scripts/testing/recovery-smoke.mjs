import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-recovery-'));
let supervisorPid;
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = (route, body) => new Promise((resolve, reject) => {
  const req = http.request(base+route, { method: body ? 'POST':'GET', timeout:3000,
    headers:{Origin:base,'Content-Type':'application/json'} }, res => {
      let text=''; res.on('data',chunk=>{text+=chunk;});res.on('end',()=>{try{resolve(JSON.parse(text));}catch(error){reject(error);}});
    });
  req.on('error',reject); req.on('timeout',()=>req.destroy(new Error('timeout')));
  req.end(body?JSON.stringify(body):undefined);
});
try {
  for (const item of ['src','public','scripts/setup.mjs','scripts/open.mjs','scripts/supervise.mjs','package.json']) {
    const target=path.join(temporary,item); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.cpSync(path.join(root,item),target,{recursive:true});
  }
  fs.symlinkSync(path.join(root,'node_modules'),path.join(temporary,'node_modules'),'dir');
  fs.mkdirSync(path.join(temporary,'state'));
  fs.writeFileSync(path.join(temporary,'state/gmgn-disconnected'),'disconnected\n');
  const env={...process.env,RADAR_PORT:String(port)};
  for(const key of Object.keys(env)) if(key.startsWith('GMGN_')) delete env[key];
  await exec(process.execPath,[path.join(temporary,'scripts/open.mjs'),'--no-open'],{cwd:temporary,env,timeout:25000});
  supervisorPid=Number(fs.readFileSync(path.join(temporary,`.runtime/supervisor-${port}.lock/pid`),'utf8'));
  assert.equal((await request('/api/status')).gmgnConnection.configured,false);
  await request('/api/scan-chains',{chains:['bsc','sol']});
  await request('/api/annotation',{chain:'bsc',address:'0x'+'1'.repeat(40),favorite:true,note:'recovery test'});
  const listener=async()=>Number((await exec('lsof',['-t','-iTCP:'+port,'-sTCP:LISTEN'])).stdout.trim());
  const before=await listener();
  const command=(await exec('ps',['-p',String(before),'-o','command='])).stdout;
  assert.ok(command.includes(temporary+'/src/main.mjs'));
  process.kill(before,'SIGKILL');
  let after=0;
  for(let i=0;i<60;i++) {
    await delay(250);
    try { after=await listener(); if(after && after!==before) break; } catch {}
  }
  assert.ok(after && after!==before,'supervisor must replace crashed child');
  const recovered=await request('/api/status');
  assert.deepEqual(recovered.scheduler.enabledChains,['bsc','sol']);
  assert.equal(Object.values(recovered.annotations)[0].note,'recovery test');
  assert.equal(recovered.gmgnConnection.configured,false);
  console.log('隔离恢复实测通过：后台进程崩溃后自动拉起；多链设置、备注和断开状态均保留。');
} finally {
  if(supervisorPid) { try{process.kill(supervisorPid,'SIGTERM');}catch{} await delay(1500); }
  fs.rmSync(temporary,{recursive:true,force:true});
}
