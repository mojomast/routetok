export interface Trial {task:string; split:'development'|'heldout'; family:string; route:string; success:boolean; answered:boolean; latencyMs:number; downstreamUsd:number|null; classifierUsd:number|null;}
export function wilson(successes:number,n:number):number {
 if(!n)return 0;const z=1.96,p=successes/n;return (p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n);
}
export function summarize(trials:Trial[]) {
 for(const t of trials)if(!Number.isFinite(t.latencyMs)||t.latencyMs<0||[t.downstreamUsd,t.classifierUsd].some(x=>x!==null&&(!Number.isFinite(x)||x<0))||t.success&&!t.answered)throw Error('invalid_trial');
 const groups:Record<string,Trial[]>={};for(const t of trials)(groups[`${t.split}:${t.route}`]??=[]).push(t);
 return Object.fromEntries(Object.entries(groups).map(([key,ts])=>{
 const success=ts.filter(t=>t.success).length,answered=ts.filter(t=>t.answered).length;
 const latencies=ts.map(t=>t.latencyMs).sort((a,b)=>a-b);
 const costKnown=ts.every(t=>t.downstreamUsd!==null&&t.classifierUsd!==null);
 const total=costKnown?ts.reduce((s,t)=>s+t.downstreamUsd!+t.classifierUsd!,0):null;
 return [key,{attempts:ts.length,successes:success,coverage:answered/ts.length,successRate:success/ts.length,successLower95:wilson(success,ts.length),selectiveFailureRate:answered?(answered-success)/answered:null,p50Ms:latencies[Math.ceil(ts.length*.5)-1],p95Ms:latencies[Math.ceil(ts.length*.95)-1],totalUsd:total,costPerSuccessfulTask:total!==null&&success?total/success:null}];
 }));
}
export interface Evidence {model:string;family:string;passed:number;total:number;meanTotalUsd:number;}
export function evidenceChoice(family:string,eligible:string[],rows:Evidence[],qualityFloor:number):string|undefined {
 if(!Number.isFinite(qualityFloor)||qualityFloor<0||qualityFloor>1)throw Error('invalid_quality_floor');
 return rows.filter(r=>r.family===family&&eligible.includes(r.model)&&Number.isSafeInteger(r.total)&&r.total>0&&Number.isSafeInteger(r.passed)&&r.passed>=0&&r.passed<=r.total&&Number.isFinite(r.meanTotalUsd)&&r.meanTotalUsd>=0&&wilson(r.passed,r.total)>=qualityFloor).sort((a,b)=>a.meanTotalUsd-b.meanTotalUsd||a.model.localeCompare(b.model))[0]?.model;
}
