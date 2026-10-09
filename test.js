'use strict';
/** Integration tests, no third-party packages. Run: node --test test.js */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
let proc, tmp, origin, port, alice, bob, carol, privateFile, sharedFile;
const code = 'TEST-12345678';
const contents = crypto.randomBytes(9 * 1024 * 1024 + 123);
const CHUNK = 4 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function request(url, options = {}, cookie) {
  return fetch(`${origin}${url}`, {
    ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    signal: AbortSignal.timeout(15000),
  });
}
async function jsonRequest(url, method, data, cookie) {
  return request(url, { method, headers: { 'X-LanDrop': '1', 'Content-Type': 'application/json' },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }, cookie);
}
async function join(name) {
  const r = await jsonRequest('/api/join', 'POST', { code, name, kind:'desktop' });
  assert.equal(r.status, 200, await r.clone().text());
  return { cookie:r.headers.get('set-cookie').split(';')[0], state:await r.json() };
}
async function create(name, size, receiverId = '*', sender = alice) {
  const r = await jsonRequest('/api/transfers', 'POST', { name, size, receiverId }, sender.cookie);
  assert.equal(r.status, 201, await r.clone().text()); return r.json();
}
async function chunk(t, content, offset, cookie = alice.cookie) {
  return request(`/api/transfers/${t.id}/chunk?offset=${offset}`, {
    method:'PUT', headers:{'X-LanDrop':'1','Content-Type':'application/octet-stream'}, body:content,
  }, cookie);
}
async function send(t, content) {
  if (!content.length) { const r = await chunk(t, content, 0); assert.equal(r.status, 200); return r.json(); }
  let latest;
  for (let offset=0; offset<content.length; offset+=CHUNK) {
    const r=await chunk(t, content.subarray(offset, Math.min(content.length, offset+CHUNK)), offset);
    assert.equal(r.status,200,await r.clone().text()); latest=await r.json();
  }
  assert.equal(latest.status,'ready'); assert.equal(latest.received,content.length); return latest;
}
before(async () => {
  const probe=net.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  tmp=await fs.mkdtemp(path.join(os.tmpdir(),'landrop-test-'));
  origin=`http://127.0.0.1:${port}`;
  proc=spawn(process.execPath,[path.join(__dirname,'server.js')],{
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),ACCESS_CODE:code,DATA_DIR:tmp,MAX_TOTAL_GB:'0.02'},stdio:['ignore','pipe','pipe'],
  });
  let log=''; proc.stdout.on('data',x=>log+=x); proc.stderr.on('data',x=>log+=x);
  for (let i=0;i<80;i++) {
    try { if ((await request('/api/health')).ok) return; } catch {}
    if (proc.exitCode !== null) throw new Error(`Test server exited: ${log}`);
    await sleep(50);
  }
  throw new Error(`Server did not start: ${log}`);
});
after(async () => {
  if (proc && proc.exitCode===null) { proc.kill('SIGTERM'); await once(proc,'exit'); }
  if (tmp) {
    const leftover=await fs.readdir(tmp); assert.equal(leftover.length,0,'Normal shutdown should remove this run’s cache');
    await fs.rm(tmp,{recursive:true,force:true});
  }
});

test('static page, unauthenticated API, host/origin/CSRF checks',async()=>{
  const page=await request('/'); assert.equal(page.status,200); assert.match(await page.text(),/邻传/);
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/join',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,403);
  assert.equal((await request('/api/join',{method:'POST',body:'{}',headers:{'X-LanDrop':'1','Content-Type':'application/json',Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await jsonRequest('/api/join','POST',{code:'bad',name:'x'})).status,403);
  assert.equal((await jsonRequest('/api/join','POST',null)).status,400);
});
test('three separate authenticated devices discover each other',async()=>{
  alice=await join('发送端'); bob=await join('接收端'); carol=await join('无关第三台');
  const r=await request('/api/state',{},alice.cookie); const s=await r.json();
  assert.equal(s.devices.length,2); assert.notEqual(alice.state.me.id,bob.state.me.id);
  assert.match(alice.cookie,/^landrop=/); assert.ok(!JSON.stringify(s).includes(code));
});
test('Chinese/arbitrary extension: upload 9 MiB in chunks; invalid offset is rejected',async()=>{
  privateFile=await create('中文文件.任意扩展名',contents.length,bob.state.me.id);
  const bad=await chunk(privateFile,contents.subarray(0,100),10); assert.equal(bad.status,409);
  const current=await (await request(`/api/transfers/${privateFile.id}`,{},alice.cookie)).json(); assert.equal(current.received,0);
  const unauthorized=await chunk(privateFile,contents.subarray(0,10),0,bob.cookie); assert.equal(unauthorized.status,403);
  await send(privateFile,contents);
});
test('receiver downloads exact bytes; third device is isolated',async()=>{
  const r=await request(`/api/files/${privateFile.id}`,{},bob.cookie); assert.equal(r.status,200);
  const received=Buffer.from(await r.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(received).digest('hex'),crypto.createHash('sha256').update(contents).digest('hex'));
  assert.match(r.headers.get('content-disposition'),/^attachment;/);
  assert.match(r.headers.get('content-disposition'),/filename\*=UTF-8''/);
  assert.equal(r.headers.get('content-type'),'application/octet-stream');
  assert.equal((await request(`/api/files/${privateFile.id}`,{},carol.cookie)).status,404);
  assert.equal((await request(`/api/files/${privateFile.id}`)).status,401);
  const state=await (await request('/api/state',{},carol.cookie)).json(); assert.ok(!state.transfers.some(x=>x.id===privateFile.id));
});
test('download HEAD, byte ranges, suffix ranges, invalid ranges and If-Range',async()=>{
  let r=await request(`/api/files/${privateFile.id}`,{method:'HEAD'},bob.cookie);
  assert.equal(r.status,200); assert.equal(Number(r.headers.get('content-length')),contents.length); assert.equal((await r.arrayBuffer()).byteLength,0);
  const tag=r.headers.get('etag');
  r=await request(`/api/files/${privateFile.id}`,{headers:{Range:'bytes=7-1023','If-Range':tag}},bob.cookie);
  assert.equal(r.status,206); assert.deepEqual(Buffer.from(await r.arrayBuffer()),contents.subarray(7,1024));
  r=await request(`/api/files/${privateFile.id}`,{headers:{Range:'bytes=-16'}},bob.cookie);
  assert.equal(r.status,206); assert.deepEqual(Buffer.from(await r.arrayBuffer()),contents.subarray(-16));
  r=await request(`/api/files/${privateFile.id}`,{headers:{Range:`bytes=${contents.length-5}-`}},bob.cookie);
  assert.equal(r.status,206); assert.deepEqual(Buffer.from(await r.arrayBuffer()),contents.subarray(-5));
  r=await request(`/api/files/${privateFile.id}`,{headers:{Range:`bytes=${contents.length}-`}},bob.cookie);
  assert.equal(r.status,416); assert.equal(r.headers.get('content-range'),`bytes */${contents.length}`);
  assert.equal((await request(`/api/files/${privateFile.id}`,{headers:{Range:'bytes=0-5,9-10'}},bob.cookie)).status,416);
  r=await request(`/api/files/${privateFile.id}`,{headers:{Range:'bytes=0-5','If-Range':'"different"'}},bob.cookie);
  assert.equal(r.status,200); assert.equal((await r.arrayBuffer()).byteLength,contents.length);
});
test('empty files, binary HTML payload and traversal-like filenames stay attachments',async()=>{
  const empty=await create('零字节.empty',0,bob.state.me.id); await send(empty,Buffer.alloc(0));
  const r=await request(`/api/files/${empty.id}`,{},bob.cookie); assert.equal(r.status,200); assert.equal((await r.arrayBuffer()).byteLength,0);
  const html=Buffer.from('<script>alert("not executed")</script>');
  sharedFile=await create('../../<evil>\\测试\r\n文件.html',html.length); await send(sharedFile,html);
  const info=await (await request(`/api/transfers/${sharedFile.id}`,{},alice.cookie)).json();
  assert.equal(info.name,'测试文件.html'); assert.ok(!info.name.includes('/'));
  const dl=await request(`/api/files/${sharedFile.id}`,{},carol.cookie); assert.equal(dl.status,200); assert.equal(dl.headers.get('x-content-type-options'),'nosniff');
  assert.match(dl.headers.get('content-security-policy'),/sandbox/); assert.deepEqual(Buffer.from(await dl.arrayBuffer()),html);
});
test('shared files are available to later joiners, but only sender deletes shared cache',async()=>{
  const later=await join('稍后加入');
  const s=await (await request('/api/state',{},later.cookie)).json(); assert.ok(s.transfers.some(t=>t.id===sharedFile.id));
  assert.ok(!s.transfers.some(t=>t.id===privateFile.id));
  assert.equal((await jsonRequest(`/api/transfers/${sharedFile.id}`,'DELETE',undefined,carol.cookie)).status,403);
});
test('cache quota, nonexistent receiver, and chunk size limits are enforced',async()=>{
  assert.equal((await jsonRequest('/api/transfers','POST',{name:'large',size:30*1024*1024,receiverId:'*'},alice.cookie)).status,507);
  assert.equal((await jsonRequest('/api/transfers','POST',{name:'x',size:1,receiverId:crypto.randomUUID()},alice.cookie)).status,409);
  const t=await create('too-big-chunk.bin',CHUNK+1);
  assert.equal((await chunk(t,Buffer.alloc(CHUNK+1),0)).status,413);
  assert.equal((await jsonRequest(`/api/transfers/${t.id}`,'DELETE',undefined,alice.cookie)).status,200);
});
test('aborted partial chunk rolls back and can resume without duplicate bytes',async()=>{
  const t=await create('resume.bin',256*1024);
  const socket=net.createConnection({host:'127.0.0.1',port}); await once(socket,'connect');
  socket.on('error',()=>{});
  socket.write(`PUT /api/transfers/${t.id}/chunk?offset=0 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${alice.cookie}\r\nX-LanDrop: 1\r\nContent-Type: application/octet-stream\r\nContent-Length: 262144\r\n\r\n`);
  socket.write(Buffer.alloc(64000,123)); await sleep(70); socket.destroy(); await sleep(200);
  const state=await (await request(`/api/transfers/${t.id}`,{},alice.cookie)).json(); assert.equal(state.received,0);
  const payload=crypto.randomBytes(t.size); await send(t,payload);
  const r=await request(`/api/files/${t.id}`,{},bob.cookie); assert.deepEqual(Buffer.from(await r.arrayBuffer()),payload);
});
test('download unavailable until complete; cancelling an active upload removes cache',async()=>{
  const t=await create('cancel.bin',256*1024,bob.state.me.id);
  assert.equal((await request(`/api/files/${t.id}`,{},bob.cookie)).status,409);
  const socket=net.createConnection({host:'127.0.0.1',port}); await once(socket,'connect'); socket.on('error',()=>{});
  socket.write(`PUT /api/transfers/${t.id}/chunk?offset=0 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${alice.cookie}\r\nX-LanDrop: 1\r\nContent-Length: 262144\r\n\r\n`);
  socket.write(Buffer.alloc(1024)); await sleep(70);
  assert.equal((await jsonRequest(`/api/transfers/${t.id}`,'DELETE',undefined,bob.cookie)).status,200);
  socket.destroy(); await sleep(100);
  assert.equal((await request(`/api/transfers/${t.id}`,{},alice.cookie)).status,404);
});
test('recipient deletion is scoped and releases the reservation',async()=>{
  const before=await (await request('/api/state',{},alice.cookie)).json();
  const r=await jsonRequest(`/api/transfers/${privateFile.id}`,'DELETE',undefined,bob.cookie); assert.equal(r.status,200);
  const after=await (await request('/api/state',{},alice.cookie)).json();
  assert.equal(before.server.reservedBytes-after.server.reservedBytes,contents.length);
  assert.equal((await request(`/api/files/${privateFile.id}`,{},alice.cookie)).status,404);
});
test('wrong-code attempts are rate-limited per client IP',async()=>{
  for (let i=0;i<12;i++) assert.equal((await jsonRequest('/api/join','POST',{code:'WRONG',name:'x'})).status,403);
  assert.equal((await jsonRequest('/api/join','POST',{code,name:'x'})).status,429);
});
