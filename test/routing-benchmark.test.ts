import test from 'node:test';import assert from 'node:assert/strict';import {evidenceChoice,summarize,wilson} from '../src/routing-benchmark.js';
test('quality gates reject tiny samples, retain allowlists and select cheaper qualified model',()=>{
 assert(wilson(1,1)<.8);assert(wilson(100,100)>.95);
 const rows=[{model:'cheap',family:'coding',passed:1,total:1,meanTotalUsd:.001},{model:'strong',family:'coding',passed:100,total:100,meanTotalUsd:.01}];
 assert.equal(evidenceChoice('coding',['cheap','strong'],rows,.9),'strong');
 assert.equal(evidenceChoice('coding',['cheap'],rows,.9),undefined);
 assert.equal(evidenceChoice('writing',['strong'],rows,.9),undefined);
});
test('refusals lower coverage and success; unknown classifier bill prevents net-cost claim',()=>{
 const base={task:'x',split:'heldout' as const,family:'coding',route:'jev',latencyMs:20,downstreamUsd:0,classifierUsd:null};
 const result=summarize([{...base,answered:true,success:true},{...base,answered:false,success:false}])['heldout:jev'];
 assert(result);
 assert.equal(result.coverage,.5);assert.equal(result.successRate,.5);assert.equal(result.totalUsd,null);assert.equal(result.costPerSuccessfulTask,null);
 assert.throws(()=>summarize([{...base,answered:false,success:true}]));
});
