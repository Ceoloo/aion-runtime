import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { capability, createHumanActor, type Actor } from '@aion/core';
import { createKeycloakVerifier, createRuntimePrincipalLookup } from '@aion/sentinel';
import type { ControlPlane } from '../control-plane.js';
import type { GatewayAuthConfig } from '../auth/types.js';
import { handleGatewayRequest } from '../gateway.js';
import { Logger } from '../logger.js';

const issuer='https://auth.example.test/realms/aion-forge-proof';
const audience='aion-runtime';
const clientId='aion-forge-test';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
const logger=new Logger({service:'runtime-forge-test',environment:'test',
  gitSha:'fake-test',serviceVersion:'0'},'error');

function jwt(overrides:Record<string,unknown>={},key=privateKey){
  const now=Math.floor(Date.now()/1000);
  const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'ephemeral-test-1'}))
    .toString('base64url');
  const payload=Buffer.from(JSON.stringify({
    iss:issuer,aud:audience,sub:'subject-proof-1',azp:clientId,
    typ:'Bearer',iat:now,exp:now+120,...overrides
  })).toString('base64url');
  const input=header+'.'+payload;
  return input+'.'+sign('RSA-SHA256',Buffer.from(input),key).toString('base64url');
}

function request(body:unknown,token=jwt(),tenantId='tenant-a'):IncomingMessage{
  const raw=JSON.stringify(body);
  return {headers:{authorization:'Bearer '+token,'x-aion-tenant-id':tenantId},
    async *[Symbol.asyncIterator](){yield Buffer.from(raw);}} as unknown as IncomingMessage;
}
const requestId='forge-12345678-1234-4234-a234-123456789abc';
function forgeBody(overrides:Record<string,unknown>={}){
  return {requestId,name:'ForgeSessionLaunch',serviceKey:'forge.session.launch',
    actor:{actorId:'ignored-by-test'},payload:{workspaceId:'work-a',template:'reviewer'},
    metadata:{source:'aion-forge',forgeRequestId:requestId},environment:'staging',...overrides};
}
function harness({
  bindingActive=true,permissions=true, auditFails=false, role='invoke',
  mode='keycloak' as 'keycloak'|'api-key',actorOverride,
}:{
  bindingActive?:boolean;permissions?:boolean;auditFails?:boolean;
  role?:'invoke';mode?:'keycloak'|'api-key';actorOverride?:Partial<Actor>;
}={}){
  const actor=createHumanActor({name:'Synthetic Security Operator',
    permissions:permissions?[capability('forge.session.launch')]:[],allowedTools:[]});
  const durableActor={...actor,...actorOverride} as Actor;
  const binding={issuer,subject:'subject-proof-1',clientId,
    principalId:'principal-proof-1',actorId:actor.actorId,kind:'operator' as const,
    tenantIds:['tenant-a'],roles:[role],status:'active' as const};
  const records:unknown[]=[];let submits=0,lookupCalls=0;
  const lookup=createRuntimePrincipalLookup({
    getBinding:async()=>bindingActive?binding:undefined,
    getActor:async()=>{lookupCalls++;return durableActor;}
  });
  const verifier=createKeycloakVerifier({issuer,audience,allowedClients:[clientId],
    lookupPrincipal:lookup,jwks:async()=>publicKey});
  const config:GatewayAuthConfig={
    mode:'required',provider:mode,
    apiKeys:mode==='api-key'?[{token:'legacy-bearer-forge',principal:{
      principalId:'principal-proof-1',actorId:actor.actorId,kind:'operator',
      tenantIds:['tenant-a'],roles:['invoke']}}]:[],
    ...(mode==='keycloak'?{keycloak:{issuer,audience,allowedClients:[clientId]}}:{})
  };
  const cp={
    auth:config,keycloakVerifier:verifier,
    dataLayer:{
      actors:{get:async()=>durableActor},
      forgeAudit:{append:async(e:unknown)=>{
        if(auditFails)throw new Error('NEVER_LOG_DATABASE_PASSWORD');
        records.push(e);
        const id=(e as {eventId:string}).eventId;
        return {eventId:id,committed:true};
      }}
    },
    orchestrator:{submit:async()=>{submits++;throw Error('never execute!');}},
  } as unknown as ControlPlane;
  return {cp,actor,records,submitCount:()=>submits,lookupCalls:()=>lookupCalls};
}
async function call(h:ReturnType<typeof harness>,body:Record<string,unknown>,token?:string,tenant='tenant-a'){
  return handleGatewayRequest('POST','/v1/commands',request({...body,actor:{actorId:h.actor.actorId}},
    token??jwt(),tenant),h.cp,logger);
}

test('actual RS256-signed Sentinel JWT + durable Actor -> audited, never executed',async()=>{
  const h=harness();const response=await call(h,forgeBody());
  assert.equal(response?.status,409);
  assert.equal((response?.body as {error:string}).error,'forge_execution_disabled');
  assert.equal(h.records.length,1);
  assert.equal(h.submitCount(),0);
  assert.ok(h.lookupCalls()>=1);
  const evidence=h.records[0] as Record<string,unknown>;
  assert.equal(evidence.principalId,'principal-proof-1');
  assert.equal(evidence.actorId,h.actor.actorId);
  assert.equal(evidence.tenantId,'tenant-a');
  assert.equal(evidence.workspaceId,'work-a');
  assert.equal(evidence.type,'forge.session.requested');
  assert.equal(JSON.stringify(evidence).includes('Bearer'),false);
  assert.equal(JSON.stringify(evidence).includes('signature'),false);
});

test('duplicate signed request yields deterministic audit event id and zero executions',async()=>{
  const h=harness();const body=forgeBody();
  const a=await call(h,body),b=await call(h,body);
  assert.equal(a?.status,409);assert.equal(b?.status,409);
  assert.equal((h.records[0] as {eventId:string}).eventId,(h.records[1] as {eventId:string}).eventId);
  assert.equal(h.submitCount(),0);
});

test('signature, issuer, audience, client, expired token and disabled binding fail closed',async()=>{
  const invalid=[jwt({},otherKey),jwt({iss:'https://evil.example/realms/aion'}),
    jwt({aud:'wrong'}),jwt({azp:'wrong'}),jwt({exp:Math.floor(Date.now()/1000)-60})];
  for(const token of invalid){
    const h=harness();const result=await call(h,forgeBody(),token);
    assert.equal(result?.status,401);assert.equal(h.records.length,0);assert.equal(h.submitCount(),0);
  }
  const disabled=harness({bindingActive:false});
  const resp=await call(disabled,forgeBody());
  assert.equal(resp?.status,401);assert.equal(disabled.records.length,0);
});

test('cross-tenant header, absent capability, revoked Actor kind and body spoof deny',async()=>{
  const h=harness();assert.equal((await call(h,forgeBody(),jwt(),'tenant-b'))?.status,403);
  assert.equal(h.records.length,0);
  const noGrant=harness({permissions:false});
  assert.equal((await call(noGrant,forgeBody()))?.status,403);
  const wrongKind=harness({actorOverride:{actorType:'service'} as Partial<Actor>});
  // Sentinel checks durable Actor kind before Runtime's Forge handler; mismatch is 401.
  assert.equal((await call(wrongKind,forgeBody()))?.status,401);
  const spoof=harness();
  const raw=forgeBody({actor:{actorId:'attacker',permissions:['forge.session.launch'],maxRiskLevel:'R3'}});
  const resp=await handleGatewayRequest('POST','/v1/commands',request(raw),spoof.cp,logger);
  assert.equal(resp?.status,400);assert.equal(spoof.records.length,0);
});

test('audit unavailable or unknown runtime auth provider blocks without execution',async()=>{
  const broken=harness({auditFails:true});
  const r=await call(broken,forgeBody());
  assert.equal(r?.status,503);assert.equal(broken.submitCount(),0);
  assert.equal(JSON.stringify(r).includes('NEVER_LOG'),false);
  const legacy=harness({mode:'api-key'});
  const r2=await call(legacy,forgeBody(),'legacy-bearer-forge');
  assert.equal(r2?.status,403);assert.equal(legacy.records.length,0);
});

test('payload rejects arbitrary commands, forged metadata, templates, and execution bypass',async()=>{
  for(const mutation of [
    {payload:{workspaceId:'../etc',template:'reviewer'}},
    {payload:{workspaceId:'work-a',template:'sh -c whoami'}},
    {metadata:{source:'aion-forge',forgeRequestId:'forge-wrong'}},
    {shell:'rm -rf /'}, {capability:'forge.session.launch'},
    {environment:'production'}, {name:'ArbitraryCommand'},
    {serviceKey:'forge.session.launch@1',command:'id'}
  ]){
    const h=harness();const r=await call(h,forgeBody(mutation));
    assert.equal(r?.status,400,JSON.stringify(mutation));
    assert.equal(h.records.length,0);assert.equal(h.submitCount(),0);
  }
});
