export interface ValidatedAttempt {model:string;content:string;costUsd:number|null;}
/** Buffered application-level helper, never use after committing streamed output. */
export async function validatedFallback(options:{primary:string;fallback:string;eligible:string[];budgetUsd:number;reserveUsd:(model:string)=>number;execute:(model:string)=>Promise<ValidatedAttempt>;validate:(content:string)=>boolean;signal?:AbortSignal}){
 const attempts:ValidatedAttempt[]=[];let spent=0;
 if(!Number.isFinite(options.budgetUsd)||options.budgetUsd<0)throw Error('invalid_budget');
 for(const model of [options.primary,options.fallback]){
  options.signal?.throwIfAborted();
  if(!options.eligible.includes(model))throw Error('ineligible_model');
  const reserve=options.reserveUsd(model);
  if(!Number.isFinite(reserve)||reserve<0||spent+reserve>options.budgetUsd)return {success:false,reason:'budget',attempts};
  const result=await options.execute(model);attempts.push(result);
  if(result.model!==model)throw Error('model_substitution');
  if(result.costUsd!==null&&(!Number.isFinite(result.costUsd)||result.costUsd<0))throw Error('invalid_cost');
  spent+=result.costUsd??reserve;
  const valid=options.validate(result.content);
  if(valid)return {success:true,reason:'validated',attempts};
  if(result.costUsd===null)return {success:false,reason:'unknown_cost',attempts};
 }
 return {success:false,reason:'validation_failed',attempts};
}
