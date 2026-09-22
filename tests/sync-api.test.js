import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../api/portfolio.js',import.meta.url),'utf8').replace(/^import .*\n/,'').replace('export default async function handler','async function handler');
function api({get=async()=>null,put=async()=>({etag:'"new"'})}={}) {
 const ctx=vm.createContext({get,put,Response,process:{env:{PORTFOLIO_KEY:'key',BLOB_STORE_ID:'store'}}});vm.runInContext(source,ctx);
 return async(method,headers={},body={holdings:[]})=>{
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(d){this.body=d;},send(d){this.body=d;}};
  await ctx.handler({method,headers:{authorization:'Bearer key',...headers},body},res);return res;
 };
}
test('server rejects legacy unconditional writes',async()=>{
 const request=api({put:()=>{throw new Error('must not write');}});
 assert.equal((await request('PUT')).code,428);
 assert.equal((await request('PUT',{'if-match':'*'})).code,428);
});
test('server forwards exact version preconditions and returns receipt',async()=>{
 let options;const request=api({put:async(p,b,o)=>{options=o;return {etag:'"new"'};}});
 const r=await request('PUT',{'if-match':'"old"'});assert.equal(r.code,200);
 assert.equal(options.ifMatch,'"old"');assert.equal(r.body.etag,'"new"');
 await request('PUT',{'if-none-match':'*'});assert.equal(options.allowOverwrite,false);
});
test('storage contention returns conflict instead of success',async()=>{
 class BlobPreconditionFailedError extends Error {}
 const r=await api({put:async()=>{throw new BlobPreconditionFailedError();}})('PUT',{'if-match':'"old"'});
 assert.equal(r.code,409);
});
test('reads bypass blob cache and expose the actual version',async()=>{
 let options;const r=await api({get:async(p,o)=>{options=o;return {blob:{etag:'"v1"'},stream:new Response('{"holdings":[]}').body};}})('GET');
 assert.equal(options.useCache,false);assert.equal(r.headers.ETag,'"v1"');assert.equal(r.headers['Cache-Control'],'no-store');
});
test('storage read failure cannot masquerade as an empty cloud',async()=>{
 const r=await api({get:async()=>{throw new Error('storage unavailable');}})('GET');assert.equal(r.code,503);
});
