export interface JevEvent { id: string; ms: number; status: string; selected?: string; input?: number; output?: number; family?: string; }
export const jevEvents: JevEvent[]=[];
export function recordJev(event:JevEvent):void { jevEvents.push(event);if(jevEvents.length>500)jevEvents.shift(); }
export function jevSummary(history: any[], baselineInput?:number, baselineOutput?:number) {
 const priced=[baselineInput,baselineOutput].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
 let actual=0,estimated=0,compared=0;
 for(const e of jevEvents){const r=history.find(r=>r.requestId===e.id);if(!r||r.status!==200)continue;
 const u={input:r.inputTokens,output:r.outputTokens,estimatedCostUsd:r.costUsd};if(![u.input,u.output,u.estimatedCostUsd].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0))continue;
 if(priced){actual+=u.estimatedCostUsd;estimated+=u.input*baselineInput!+u.output*baselineOutput!;compared++;}}
 return {scope:'last_500_classifier_attempts_since_restart',attempts:jevEvents.length,selected:jevEvents.filter(x=>x.status==='selected').length,failedOrAbstained:jevEvents.filter(x=>x.status!=='selected').length,inputTokens:jevEvents.reduce((s,x)=>s+(x.input??0),0),outputTokens:jevEvents.reduce((s,x)=>s+(x.output??0),0),meanClassifierMs:jevEvents.length?jevEvents.reduce((s,x)=>s+x.ms,0)/jevEvents.length:null,comparison:{kind:'same_token_repricing_not_measured_counterfactual',baseline:'deepseek/deepseek-v4.1-flash',compared,downstreamCostUsd:priced?actual:null,baselineEstimateUsd:priced?estimated:null,grossDifferenceUsd:priced?estimated-actual:null,netSavingsUsd:null,reason:'Jev dollar cost and actual DeepSeek output length unknown'},recent:jevEvents.slice(-20).reverse()};
}
