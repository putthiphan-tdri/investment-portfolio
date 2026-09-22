import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\ninitDates();')[0];
const KEY = 'myFundsPortfolio.v1';
const payload = (n) => ({holdings:[{symbol:'TEST',units:n}],activities:[],portfolioSnapshots:[],savedAt:'2026-09-22T00:00:00Z'});
function session(local, server) {
  const storage = new Map([[KEY,JSON.stringify(local)],['myFundsPortfolio.syncKey','test-key']]);
  const ctx = vm.createContext({console, fetch:server, localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    window:{clearTimeout(){},setTimeout(){return 1;}},document:{querySelector(){return null;}}});
  vm.runInContext(source,ctx);
  vm.runInContext(`applyStoredPayload = p => { holdings.splice(0,holdings.length,...p.holdings); };
    renderAll = () => {}; applyPrivacyMode = () => {}; showToast = () => {};
    buildExportPayload = () => ({holdings:JSON.parse(localStorage.getItem(storageKey)).holdings});
    loadPortfolio();`,ctx);
  return {storage,run:c=>vm.runInContext(c,ctx),local:()=>JSON.parse(storage.get(KEY)),sync:options=>vm.runInContext(`pullPortfolioFromCloud(${JSON.stringify(options||{})})`,ctx)};
}
function cloud(initial) {
  let data=initial, version=initial ? 1 : 0; const writes=[];
  return {writes,get data(){return data;},get etag(){return `"v${version}"`;},
    fetch:async (_,o)=>{
      if(o.method==='GET') return data ? new Response(JSON.stringify(data),{headers:{ETag:`"v${version}"`}}) : new Response('{}',{status:404});
      if ((data && o.headers['If-Match']!==`"v${version}"`) || (!data && o.headers['If-None-Match']!=='*')) return new Response('{}',{status:409});
      data=JSON.parse(o.body);version++;writes.push(data);
      return new Response(JSON.stringify({etag:`"v${version}"`}));
    }};
}
test('legacy local copy cannot overwrite or silently replace a different cloud copy',async()=>{
  const c=cloud(payload(2)),s=session(payload(1),c.fetch);await s.sync();
  assert.equal(c.writes.length,0);assert.equal(s.local().holdings[0].units,1);
  assert.match(s.run('cloudState.status'),/Copies differ/);
});
test('clean clients download a newer version without uploading it back',async()=>{
 const c=cloud(payload(2)),s=session({...payload(1),sync:{etag:'"old"',dirty:false}},c.fetch);
 await s.sync();assert.equal(s.local().holdings[0].units,2);assert.equal(c.writes.length,0);
 assert.equal(s.local().sync.dirty,false);assert.ok(s.storage.get(KEY+'.beforeCloudRestore'));
});
test('two devices converge after one edits, then stale concurrent edits are preserved as conflict',async()=>{
 const c=cloud(payload(1));const a=session({...payload(3),sync:{etag:c.etag,dirty:true}},c.fetch);
 const b=session({...payload(1),sync:{etag:c.etag,dirty:false}},c.fetch);
 await a.sync();await b.sync();assert.equal(b.local().holdings[0].units,3);assert.equal(c.writes.length,1);
 const stale=session({...payload(9),sync:{etag:'"v1"',dirty:true}},c.fetch);
 await stale.sync();assert.equal(c.data.holdings[0].units,3);assert.equal(stale.local().holdings[0].units,9);
});
test('simultaneous uploads use conditional writes: only one wins',async()=>{
 const c=cloud(payload(1));const a=session({...payload(2),sync:{etag:c.etag,dirty:true}},c.fetch);
 const b=session({...payload(3),sync:{etag:c.etag,dirty:true}},c.fetch);
 await Promise.all([a.sync(),b.sync()]);assert.equal(c.writes.length,1);
 assert.equal([a,b].filter(s=>s.local().sync.dirty).length,1);
});
test('offline failures keep pending edits for retry',async()=>{
 const s=session({...payload(2),sync:{etag:'"v1"',dirty:true}},async()=>{throw new Error('offline');});
 await s.sync();assert.equal(s.local().sync.dirty,true);assert.equal(s.local().holdings[0].units,2);
});
test('explicit migration choices keep backup on download and permit conditional upload',async()=>{
 const c=cloud(payload(2)),s=session(payload(1),c.fetch);
 await s.sync({resolution:'upload'});assert.equal(c.data.holdings[0].units,1);
 const b=session(payload(5),c.fetch);await b.sync({resolution:'download'});
 assert.equal(b.local().holdings[0].units,1);assert.equal(JSON.parse(b.storage.get(KEY+'.beforeCloudRestore')).holdings[0].units,5);
});
test('local edits made during download prevent replacing the local copy',async()=>{
 const c=cloud(payload(2));let release;const gate=new Promise(r=>release=r);
 const s=session({...payload(1),sync:{etag:'"old"',dirty:false}},async(...args)=>{await gate;return c.fetch(...args);});
 const job=s.sync();s.storage.set(KEY,JSON.stringify({...payload(8),sync:{etag:'"old"',dirty:true}}));release();await job;
 assert.equal(s.local().holdings[0].units,8);assert.equal(c.writes.length,0);
});
test('display preferences preserve timestamps and do not schedule uploads',()=>{
 const c=cloud(payload(1)),s=session({...payload(1),sync:{etag:c.etag,dirty:false}},c.fetch);
 s.run('scheduleCloudPush = () => { throw new Error("unexpected upload"); }; savePortfolio({captureSnapshot:false,dataChanged:false});');
 assert.equal(s.local().savedAt,'2026-09-22T00:00:00Z');assert.equal(s.local().sync.dirty,false);
});
test('startup and unload do not save or upload the local portfolio',()=>{
 const startup=readFileSync(new URL('../app.js',import.meta.url),'utf8').split('\ninitDates();')[1];
 assert.doesNotMatch(startup,/savePortfolio|beforeunload/);
});
test('edits during an upload remain pending against the newly acknowledged version',async()=>{
 const c=cloud(payload(1));let release;const gate=new Promise(r=>release=r);
 const s=session({...payload(2),sync:{etag:c.etag,dirty:true}},async(...args)=>{
  if(args[1].method==='PUT') await gate;return c.fetch(...args);
 });
 const job=s.sync();await new Promise(r=>setTimeout(r,0));
 s.storage.set(KEY,JSON.stringify({...payload(3),sync:{etag:'"v1"',dirty:true}}));release();await job;
 assert.equal(c.data.holdings[0].units,2);assert.equal(s.local().holdings[0].units,3);
 assert.equal(s.local().sync.dirty,true);assert.equal(s.local().sync.etag,c.etag);
 await s.sync();assert.equal(c.data.holdings[0].units,3);
});
test('changing the sync key during download discards the old response',async()=>{
 const c=cloud(payload(2));let release;const gate=new Promise(r=>release=r);
 const s=session({...payload(1),sync:{etag:'"old"',dirty:false}},async(...args)=>{await gate;return c.fetch(...args);});
 const job=s.sync();s.storage.set('myFundsPortfolio.syncKey','different-key');release();await job;
 assert.equal(s.local().holdings[0].units,1);assert.equal(c.writes.length,0);
});
test('failed upload keeps pending changes and reports failure',async()=>{
 const c=cloud(payload(1)),s=session({...payload(2),sync:{etag:c.etag,dirty:true}},async(...args)=>args[1].method==='PUT'?new Response('{}',{status:503}):c.fetch(...args));
 await s.sync();assert.equal(s.local().sync.dirty,true);assert.match(s.run('cloudState.status'),/Upload failed/);
});
