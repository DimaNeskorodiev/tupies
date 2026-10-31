// Only static diagnostic categories and numeric statuses cross this boundary. Never retain an error/body.
const CODES=new Set(['timeout','dns_error','tls_error','transport_error','redirect_refused','response_limit','invalid_json','invalid_stream','authentication','rate_limit','http_400','http_rejected','upstream_unavailable','http_error','namespace_rejected','arguments_rejected','tool_call_invalid','stream_interrupted','empty_response','response_failed','protocol_error']);
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
export function httpFailureCode(value){return value===401||value===403?'authentication':value===429?'rate_limit':value===400?'http_400':value>=500?'upstream_unavailable':value>=400?'http_rejected':'http_error';}
