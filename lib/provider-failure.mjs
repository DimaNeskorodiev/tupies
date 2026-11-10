// Only static diagnostic categories and numeric statuses cross this boundary. Never retain an error/body.
const CODES=new Set(['timeout','dns_error','tls_error','transport_error','redirect_refused','response_limit','invalid_json','invalid_stream','authentication','rate_limit','quota_exhausted','http_400','http_rejected','upstream_unavailable','http_error','namespace_rejected','arguments_rejected','tool_call_invalid','stream_interrupted','empty_response','response_failed','protocol_error']);
const TIMEOUT_PHASES=new Set(['dns','total','idle']);
const trusted=new WeakMap();
const status=value=>Number.isInteger(value)&&value>=400&&value<=599?value:null;
const upstreamStatus=value=>Number.isInteger(value)&&value>=100&&value<=599?value:null;
export function sanitizeProviderFailure(value){return value?.origin==='provider'&&CODES.has(value.code)?{origin:'provider',code:value.code,status:status(value.status),upstreamStatus:upstreamStatus(value.upstreamStatus),...(value.code==='timeout'&&TIMEOUT_PHASES.has(value.timeoutPhase)?{timeoutPhase:value.timeoutPhase}:{})}:null;}
export function markProviderFailure(error,code,{status:localStatus=error?.status,upstreamStatus=null,timeoutPhase}={}){
  if(error&&(typeof error==='object'||typeof error==='function')&&CODES.has(code)&&!trusted.has(error))trusted.set(error,sanitizeProviderFailure({origin:'provider',code,status:localStatus,upstreamStatus,timeoutPhase}));return error;
}
export function providerFailure(error){const value=error&&(typeof error==='object'||typeof error==='function')?trusted.get(error):null;return value?sanitizeProviderFailure(value):null;}
export function clearProviderFailure(error){if(error&&(typeof error==='object'||typeof error==='function'))trusted.delete(error);}
export function carryProviderFailure(source,target){const value=providerFailure(source);if(value)trusted.set(target,value);return target;}
export function transportFailureCode(error){return ['ETIMEDOUT','ESOCKETTIMEDOUT'].includes(error?.code)||error?.name==='TimeoutError'?'timeout':['ENOTFOUND','EAI_AGAIN','EAI_FAIL'].includes(error?.code)?'dns_error':/^ERR_TLS_|^CERT_|^UNABLE_TO_VERIFY_/.test(typeof error?.code==='string'?error.code:'')?'tls_error':'transport_error';}
// A spent balance, a used-up plan window or a billing limit does not clear within a retry backoff, unlike a request-rate throttle.
// Structured error codes are read first; wording is only the fallback. The text itself never leaves this function.
const QUOTA_CODES=new Set(['insufficient_quota','billing_hard_limit_reached','billing_not_active','usage_limit_reached','usage_not_included','insufficient_balance','insufficient_credits','credit_balance_too_low','payment_required','quota_exceeded']);
const QUOTA_TEXT=/insufficient (balance|credits?|quota|funds)|exceeded your current quota|credit balance is too low|out of credits|more credits|billing (hard )?limit|payment required|usage limit (has been )?reached|you('ve| have) (hit|reached) your usage limit|quota (has been )?exceeded/i;
/** Whether an HTTP error body names a spent quota or balance; only 402, 403 and 429 responses are considered. */
export function quotaExhausted(status,data) {
  if(status===402)return true;
  if(status!==429 && status!==403)return false;
  const error=data && typeof data==='object'?(data.error && typeof data.error==='object'?data.error:data):null;
  const codes=[error?.code,error?.type,data?.code,data?.type].filter(value=>typeof value==='string').map(value=>value.toLowerCase());
  if(codes.some(code=>QUOTA_CODES.has(code)))return true;
  const message=typeof data?.error==='string'?data.error:typeof error?.message==='string'?error.message:'';
  return status===429 && QUOTA_TEXT.test(message.slice(0,2000));
}
/** When a provider states its usage window's reset (`resets_in_seconds`, `resets_at`), the wait in milliseconds; otherwise 0. */
export function quotaResetMs(data,nowMs=Date.now()) {
  const error=data && typeof data==='object'?(data.error && typeof data.error==='object'?data.error:data):null;
  const seconds=Number(error?.resets_in_seconds);
  if(Number.isFinite(seconds) && seconds>0)return Math.min(30*86_400_000,Math.round(seconds*1000));
  const at=Number(error?.resets_at);
  if(Number.isFinite(at) && at>0){const ms=(at<1e12?at*1000:at)-nowMs;return ms>0?Math.min(30*86_400_000,Math.round(ms)):0;}
  return 0;
}
export function httpFailureCode(value){return value===401||value===403?'authentication':value===429?'rate_limit':value===400?'http_400':value>=500?'upstream_unavailable':value>=400?'http_rejected':'http_error';}
