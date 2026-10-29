import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {promises as fs} from 'node:fs';
import {Store} from '../lib/store.mjs';
import {controlSocketPath,prepareControlDirectory} from '../lib/control.mjs';
import {homeSubscriptionGrantReader,subscriptionProvider} from '../eval/subscription-provider.mjs';
import {evaluationOptions,EvaluationBudget,runEvaluation} from '../eval/runner.mjs';

const token='synthetic-access-token-never-live',replacement='synthetic-replacement-access-token',refresh='synthetic-refresh-token-never-live';
const grant=changes=>({accessToken:token,expiresAt:Date.now()+300_000,scopes:['resource.invoke','chatgpt.tokens.use.direct'],planEnabled:true,needsLogin:false,endpoint:'https://api.openai.com/v1',identity:'synthetic-owner',models:[{id:'fixture-model',contextWindow:16000}],...changes});
async function temporary(t,prefix='tupies-subscription-eval-') {
  const directory=await fs.mkdtemp(path.join(tmpdir(),prefix)),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,store};
}

test('subscription evaluation requires explicit owner opt-in and leaves cost unknown',()=>{
  assert.throws(()=>evaluationOptions({mode:'live',provider:'chatgpt',model:'fixture-model'}),/authorized-subscription/);
  assert.throws(()=>evaluationOptions({mode:'live',provider:'chatgpt',model:'fixture-model',authorizedSubscription:true,baseUrl:'https://example.com'}),/official endpoint/);
  const options=evaluationOptions({mode:'live',provider:'chatgpt',model:'fixture-model',authorizedSubscription:true}),budget=new EvaluationBudget(options);
  budget.settle(budget.reserve({messages:[{role:'user',content:'Fixture'}],tools:[]},0),{input_tokens:8,output_tokens:4});
  assert.equal(budget.metrics().reportedCostUsd,null);assert.equal(budget.metrics().costReservationUsd,null);assert.equal(budget.metrics().reportedInputTokens,8);
});

test('adapter rereads only current access grant per request, never renews or persists it, and redacts all used tokens',async t=>{
  const {store,directory}=await temporary(t),beforeRedact=store.redact;let reads=0;
  const {providers,connection}=await subscriptionProvider(store,{authorized:true,model:'fixture-model',readGrant:async()=>grant({accessToken:++reads<3?token:replacement})});
  t.after(()=>providers.close());providers.oauth.bearer=()=>{throw new Error('OAuth must never be used.');};providers.oauth.request=()=>{throw new Error('Renewal must never be used.');};
  await store.mutate(state=>{state.connections=[connection];});
  assert.equal((await providers.headers(connection)).Authorization,`Bearer ${token}`);
  assert.equal((await providers.headers(connection)).Authorization,`Bearer ${replacement}`);assert.equal(reads,3);
  assert.equal(store.redact(`${token} ${replacement}`),'[redacted] [redacted]');
  const saved=await fs.readFile(path.join(directory,'state.json'),'utf8');for(const value of [token,replacement,refresh,'oauthSecret','oauthAccount'])assert.ok(!saved.includes(value));
  assert.equal(connection.models[0].id,'fixture-model');assert.equal(connection.defaultModel,'fixture-model');
  await assert.rejects(providers.headers({...connection,baseUrl:'https://example.com'}),/unavailable or changed/);
  await providers.close();assert.equal(store.redact,beforeRedact);
});

for(const [name,changes] of Object.entries({expired:{expiresAt:Date.now()},renewing:{refreshState:'in_progress'},unconfirmed:{needsLogin:true},noPlan:{planEnabled:false},missingScope:{scopes:['resource.invoke']},wrongDestination:{endpoint:'https://example.com/v1'},headerInjection:{accessToken:'bad-token-with\nheader'},missingIdentity:{identity:''}}))test(`subscription adapter refuses ${name} without any refresh`,async t=>{
  const {store}=await temporary(t);await assert.rejects(subscriptionProvider(store,{authorized:true,model:'fixture-model',readGrant:async()=>grant(changes)}),/unavailable or changed/);
});

test('adapter rejects account replacement, sanitizes reader failures and obeys the case deadline',async t=>{
  const {store}=await temporary(t);let reads=0;
  const {providers,connection}=await subscriptionProvider(store,{authorized:true,model:'fixture-model',readGrant:async()=>grant({identity:++reads===1?'first':'second'})});
  await assert.rejects(providers.headers(connection),/unavailable or changed/);await providers.close();
  await assert.rejects(subscriptionProvider(store,{authorized:true,model:'fixture-model',readGrant:async()=>{throw new Error(token);}}),error=>!error.message.includes(token));
  const controller=new AbortController(),pending=subscriptionProvider(store,{authorized:true,model:'fixture-model',signal:controller.signal,readGrant:()=>new Promise(()=>{})});
  controller.abort(new Error('Synthetic deadline.'));await assert.rejects(pending,/Synthetic deadline/);
});

test('home reader uses a live source read-only, observes source renewal and refuses replicas, account changes and stopped sources',async t=>{
  const {store,directory}=await temporary(t,'tupies-home-grant-'),socket=controlSocketPath(directory);await prepareControlDirectory(socket);
  const server=net.createServer(connection=>connection.end());await new Promise(resolve=>server.listen(socket,resolve));let stopped=false;
  t.after(async()=>{if(!stopped)await new Promise(resolve=>server.close(resolve));});
  const save=access=>store.mutate(state=>{state.connections=[{id:'source-connection',type:'chatgpt',baseUrl:'https://api.openai.com/v1',oauthSecret:store.seal(JSON.stringify({access_token:access,refresh_token:refresh,subject:'synthetic-subject',client_id:'fixture-client',expiresAt:Date.now()+300000,scopes:['resource.invoke','chatgpt.tokens.use.direct']})),oauthAccount:{planEnabled:true,subject:'synthetic-subject',email:'private-account-canary'},models:[{id:'fixture-model',contextWindow:16000,label:'private-label-canary'}]}];state.conversations.bot_atlas=[{role:'user',content:'private-transcript-canary'}];});
  await save(token);const before=await fs.readFile(path.join(directory,'state.json')),readGrant=homeSubscriptionGrantReader({directory,connectionId:'source-connection',authorized:true});
  const first=await readGrant();assert.equal(first.accessToken,token);assert.equal(first.models[0].id,'fixture-model');assert.ok(!JSON.stringify(first).includes('private-'));assert.ok(!JSON.stringify(first).includes(refresh));assert.deepEqual(await fs.readFile(path.join(directory,'state.json')),before);
  await save(replacement);assert.equal((await readGrant()).accessToken,replacement);
  const alias=directory+'-alias';await fs.symlink(directory,alias);t.after(()=>fs.rm(alias,{force:true}));const aliasReader=homeSubscriptionGrantReader({directory:alias,authorized:true});assert.equal((await aliasReader()).accessToken,replacement);
  await fs.rm(alias);await fs.symlink(tmpdir(),alias);await assert.rejects(aliasReader(),/unavailable or changed/);
  for(const field of ['subject','client_id']) {
    await store.mutate(state=>{const value=JSON.parse(store.unseal(state.connections[0].oauthSecret));value[field]='';state.connections[0].oauthSecret=store.seal(JSON.stringify(value));});
    await assert.rejects(homeSubscriptionGrantReader({directory,authorized:true})(),/unavailable or changed/);await save(replacement);
  }
  await store.mutate(state=>{state.connections[0].oauthAccount.subject='inconsistent-account';});await assert.rejects(homeSubscriptionGrantReader({directory,authorized:true})(),/unavailable or changed/);await save(replacement);
  await fs.mkdir(path.join(directory,'sync'),{recursive:true});await fs.writeFile(path.join(directory,'sync/config.json'),JSON.stringify({hub:'https://synthetic.invalid'}));await assert.rejects(readGrant(),/unavailable or changed/);await fs.rm(path.join(directory,'sync/config.json'));
  await fs.writeFile(path.join(directory,'sync/config.json'),JSON.stringify({hub:null,automationSuspended:true,detachedOAuth:['source-connection']}));await assert.rejects(readGrant(),/unavailable or changed/);await fs.rm(path.join(directory,'sync/config.json'));
  await store.mutate(state=>{const value=JSON.parse(store.unseal(state.connections[0].oauthSecret));value.subject='different-owner';state.connections[0].oauthSecret=store.seal(JSON.stringify(value));});await assert.rejects(readGrant(),/unavailable or changed/);
  await new Promise(resolve=>server.close(resolve));stopped=true;await assert.rejects(homeSubscriptionGrantReader({directory,authorized:true})(),/unavailable or changed/);
  assert.throws(()=>homeSubscriptionGrantReader({directory}),/unavailable or changed/);
});

test('live subscription setup failures report only sanitized metadata, without a secret or source account path',async()=>{
  const secretPath='/private/source-account-canary',secretConnection='private-connection-canary';let reads=0;
  const report=await runEvaluation({mode:'live',provider:'chatgpt',model:'fixture-model',authorizedSubscription:true,subscriptionSource:secretPath,subscriptionConnection:secretConnection,cases:['research-document'],maxMs:2000},{subscriptionGrantReader:async()=>{reads++;throw new Error(token);}});
  assert.equal(reads,1);assert.equal(report.results[0].status,'failed');assert.equal(report.usage.reportedCostUsd,null);assert.equal(report.configuration.outputTokenLimitEnforcedByProvider,false);assert.deepEqual(report.configuration.subscriptionSource,{configured:true});
  for(const privateValue of [token,secretPath,secretConnection])assert.ok(!JSON.stringify(report).includes(privateValue));
});
