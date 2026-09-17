export function routingEconomics(baselineUsd:number,downstreamUsd:number,inputTokens:number,outputTokens:number,inputUsdPerMillion:number,outputUsdPerMillion:number){
 const values=[baselineUsd,downstreamUsd,inputTokens,outputTokens,inputUsdPerMillion,outputUsdPerMillion];
 if(values.some(x=>!Number.isFinite(x)||x<0)||!Number.isSafeInteger(inputTokens)||!Number.isSafeInteger(outputTokens))throw Error('invalid_economics');
 const classifierEstimateUsd=(inputTokens*inputUsdPerMillion+outputTokens*outputUsdPerMillion)/1e6;
 const grossDifferenceUsd=baselineUsd-downstreamUsd;
 return {basis:'configured_list_price_estimate_not_invoice',classifierEstimateUsd,totalEstimateUsd:downstreamUsd+classifierEstimateUsd,grossDifferenceUsd,netDifferenceEstimateUsd:grossDifferenceUsd-classifierEstimateUsd,netSavingsPercent:baselineUsd?100*(grossDifferenceUsd-classifierEstimateUsd)/baselineUsd:null,breakEvenInputTokens:inputUsdPerMillion>0?Math.max(0,(grossDifferenceUsd-outputTokens*outputUsdPerMillion/1e6)*1e6/inputUsdPerMillion):null};
}
