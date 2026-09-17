import test from 'node:test';import assert from 'node:assert/strict';import {jevEvents,recordJev,jevSummary} from '../src/jev-metrics.js';
test('matches real metric sample shape, includes abstentions, never invents net savings',()=>{
jevEvents.length=0;recordJev({id:'a',status:'selected',ms:100,input:20,output:5});recordJev({id:'b',status:'failed_or_abstained',ms:200,input:10,output:2});
const history=[{requestId:'a',status:200,inputTokens:10,outputTokens:20,costUsd:.001}];
const s=jevSummary(history,.0001,.0002);assert.equal(s.comparison.compared,1);assert.equal(s.comparison.grossDifferenceUsd,.004);assert.equal(s.comparison.netSavingsUsd,null);assert.equal(s.meanClassifierMs,150);assert.equal(s.inputTokens,30);assert.equal(jevSummary(history).comparison.grossDifferenceUsd,null);
jevEvents.length=0;
});
