// Whether an integration has what it needs to call its service. Dependency-free so the store's public view, the
// integration service and the engine can share it. A bot can propose an integration without credentials; only the
// owner supplies them (an API key through the integration API, or an OAuth sign-in).
export function integrationReady(integration) {
  if(!integration || typeof integration!=='object')return false;
  if(integration.authType==='none')return true;
  if(integration.authType==='oauth2')return integration.oauth?.connected===true;
  return Boolean(integration.secret);
}
export const INTEGRATION_NOT_CONNECTED='integration_not_connected';
/** A sign-in the service stopped accepting (needs_reauth) reads differently from one the owner has not made yet. */
export const notConnectedMessage=(name,status)=>{const label=`“${String(name || 'This integration').slice(0,100)}”`;return status==='needs_reauth'?`${label} needs the owner to sign in again in Settings → Integrations.`:`${label} is not connected yet. The owner connects it in the card in this chat or in Settings → Integrations.`;};
