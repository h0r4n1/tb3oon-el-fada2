import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../src/ui/api-client.js';
test('preserves backend unavailable codes without substituting demo routes',async()=>{
 const api=createApiClient(async()=>Response.json({error:{code:'ENGINE_NOT_READY',message:'Engine pending'}},{status:503}));
 await assert.rejects(api.planRoutes({requestId:'r',dataVersion:'v'}),e=>e.code==='ENGINE_NOT_READY');
});
test('posts same-origin contract and rejects stale response versions',async()=>{
 const api=createApiClient(async(path,options)=>{assert.equal(path,'/api/routes');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).requestId,'r');return Response.json({requestId:'r',dataVersion:'old',candidates:[]})});
 await assert.rejects(api.planRoutes({requestId:'r',dataVersion:'v'}),e=>e.code==='STALE_RESULT');
});
test('discards older concurrent route responses',async()=>{
 const pending=[];const api=createApiClient(()=>new Promise(resolve=>pending.push(resolve)));
 const first=api.planRoutes({requestId:'a',dataVersion:'v'});const second=api.planRoutes({requestId:'b',dataVersion:'v'});
 pending[1](Response.json({requestId:'b',dataVersion:'v',candidates:[]}));assert.equal((await second).requestId,'b');
 pending[0](Response.json({requestId:'a',dataVersion:'v',candidates:[]}));assert.equal(await first,null);
});
