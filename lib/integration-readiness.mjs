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
export const notConnectedMessage=name=>`“${String(name || 'This integration').slice(0,100)}” is not connected yet. The owner connects it in the card in this chat or in Settings → Integrations.`;
