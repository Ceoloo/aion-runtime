#!/usr/bin/env node
/**
 * AIO-73 real Keycloak process interoperability.
 * PR-only disposable GitHub Actions, TLS loopback, synthetic identities,
 * real Keycloak-issued access tokens, remote HTTPS JWKS, Runtime HTTP and
 * non-owner AION Data PostgreSQL audit evidence. NEVER production.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createServer } from '../dist/server.js';
import { buildControlPlane } from '../dist/control-plane.js';
import { loadConfig } from '../dist/config.js';
import { runWithTenant } from '../dist/tenant-context.js';
import { Logger } from '../dist/logger.js';
import { createHumanActor, capability } from '@aion/core';

const required=['GITHUB_ACTIONS','AION_PROOF_DB_DISPOSABLE','FORGE_CI_ADMIN_PASSWORD',
  'FORGE_CI_CLIENT_SECRET','FORGE_CI_USER_PASSWORD','MIGRATION_DATABASE_URL',
  'DATABASE_URL','NODE_EXTRA_CA_CERTS','GITHUB_EVENT_NAME','RUNNER_TEMP'];
for(const name of required) if(!process.env[name])throw Error('missing isolated proof guard '+name);
if(process.env.GITHUB_ACTIONS!=='true' ||
   process.env.GITHUB_EVENT_NAME!=='pull_request' ||
   process.env.AION_PROOF_DB_DISPOSABLE!=='1' ||
   process.env.DATABASE_URL===process.env.MIGRATION_DATABASE_URL)
  throw Error('CI-only disposable proof, separate least-privilege DB roles required');
if(/supabase\.co|cloudsql|neon\.tech|amazonaws\.com|production/i.test(
  process.env.MIGRATION_DATABASE_URL+' '+process.env.DATABASE_URL))
  throw Error('remote or production database forbidden');
const issuer='https://localhost:18443/realms/aion-forge-ci';
const keycloakOrigin='https://localhost:18443';
const runtimeUrl='http://127.0.0.1:18111';
const tenant='forge-keycloak-ci-a';
const rogueTenant='forge-keycloak-ci-other';
const clientId='forge-ci-client';
const otherClientId='forge-ci-other';
const adminUsername='forge-proof-admin';
const username='forge-ci-operator';
const requestId='forge-'+randomUUID();
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
const logger=new Logger({service:'forge-keycloak-proof',environment:'test',
  gitSha:'local-ephemeral',serviceVersion:'proof'},'error');
const checks=[];
let cp=null,server=null,actor=null;
function ok(name){checks.push({name,result:'pass'});console.log('[keycloak-proof] PASS '+name);}
function parseJwt(accessToken){
  const parts=accessToken.split('.');
  assert.equal(parts.length,3,'Keycloak did not return a JWT');
  return JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
}
async function requestJson(path,options={}){
  const res=await fetch(keycloakOrigin+path,options);
  let parsed=null;const txt=await res.text();
  try{if(txt)parsed=JSON.parse(txt);}catch{}
  if(!res.ok){
    const code=typeof parsed?.error==='string'?parsed.error.slice(0,50):'none';
    const detail=typeof parsed?.error_description==='string'?
      parsed.error_description.replace(/[^A-Za-z0-9 ._-]/g,'').slice(0,120):'unavailable';
    throw Error('Keycloak API status '+res.status+' error='+code+' detail='+detail+' for '+path);
  }
  return parsed;
}
async function adminAccess(){
  const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',
    username:adminUsername,password:process.env.FORGE_CI_ADMIN_PASSWORD});
  const p=await requestJson('/realms/master/protocol/openid-connect/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:form
  });
  assert.equal(typeof p.access_token,'string');
  return p.access_token;
}
function bearerHeader(t){return {Authorization:'Bearer '+t,'content-type':'application/json'};}
async function createRealm(adminToken){
  const client=(id,audience)=>{
    const mappers=audience?[{name:'forge-runtime-audience',protocol:'openid-connect',
      protocolMapper:'oidc-audience-mapper',consentRequired:false,config:{
      'included.custom.audience':'aion-runtime',
      'access.token.claim':'true','id.token.claim':'false'
    }}]:[];
    return {clientId:id,name:id,enabled:true,protocol:'openid-connect',
      publicClient:false,clientAuthenticatorType:'client-secret',
      secret:process.env.FORGE_CI_CLIENT_SECRET,
      directAccessGrantsEnabled:true,
      standardFlowEnabled:false,
      implicitFlowEnabled:false,
      serviceAccountsEnabled:false,
      protocolMappers:mappers};
  };
  await requestJson('/admin/realms',{
    method:'POST',headers:bearerHeader(adminToken),
    body:JSON.stringify({
      realm:'aion-forge-ci',displayName:'Ephemeral Forge proof realm',
      enabled:true,sslRequired:'all',accessTokenLifespan:180,
      clients:[client(clientId,true),client(otherClientId,false)],
      users:[{
        username,enabled:true,email:'operator@forge-ci.invalid',
        firstName:'Forge',lastName:'Proof',emailVerified:true,
        credentials:[{type:'password',value:process.env.FORGE_CI_USER_PASSWORD,
          temporary:false}],
        requiredActions:[],
      }],
    })
  });
}
async function tokenFor(client){
  const form=new URLSearchParams({
    grant_type:'password',client_id:client,
    client_secret:process.env.FORGE_CI_CLIENT_SECRET,
    username,password:process.env.FORGE_CI_USER_PASSWORD,
  });
  const t=await requestJson('/realms/aion-forge-ci/protocol/openid-connect/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form
  });
  assert.equal(typeof t.access_token,'string','Keycloak access token missing');
  return t.access_token;
}
async function runtimePost(token,body,tenantHeader=tenant){
  const headers={'content-type':'application/json',
    'x-aion-tenant-id':tenantHeader};
  if(token)headers.authorization='Bearer '+token;
  const resp=await fetch(runtimeUrl+'/v1/commands',{method:'POST',headers,
    body:JSON.stringify(body)});
  return {status:resp.status,body:await resp.json()};
}
function command(actorId){
  return {requestId,name:'ForgeSessionLaunch',
    serviceKey:'forge.session.launch',
    actor:{actorId},
    payload:{workspaceId:'forge-keycloak-ci-work',template:'reviewer'},
    metadata:{source:'aion-forge',forgeRequestId:requestId},
    environment:'staging'};
}
async function appQuery(scope,sql,params=[]){
  return runWithTenant(scope,()=>cp.dataLayer.pool.query(sql,params));
}
const evidence={
  schema:'aion.forge.real-keycloak-ci.v1',
  proofEnvironment:'ephemeral-GitHub-Actions-PR-only',
  approvedDeployment:false,
  realStagingDeployment:false,
  keycloak:{versionImage:'quay.io/keycloak/keycloak:26.8.2',
    issuer,
    keyMaterial:'ephemeral TLS certificate; real Keycloak realm signing key',
    jwks:'remote HTTPS (no mock resolver)'},
  runtimeSha:process.env.GITHUB_SHA||'unknown',
  checks,
  note:'Contains no bearer values, passwords, keys, customer identities or environment secrets',
  pending:['authorized persistent staging endpoint and operator approval',
    'remote key rollover, JWKS outage and logout-session policy probes',
    'MFA, privileged review, rollback digest and independent security signature'],
};
try {
  const discovery=await requestJson('/realms/master/.well-known/openid-configuration');
  assert.match(discovery.issuer,/^https:\/\/localhost:18443\/realms\/master$/);
  const token=await adminAccess();
  await createRealm(token);
  ok('real Keycloak realm provisioned through HTTPS Admin API');

  const metadata=await requestJson('/realms/aion-forge-ci/.well-known/openid-configuration');
  assert.equal(metadata.issuer,issuer);
  assert.equal(metadata.jwks_uri,issuer+'/protocol/openid-connect/certs');
  const jwks=await requestJson('/realms/aion-forge-ci/protocol/openid-connect/certs');
  assert.ok(Array.isArray(jwks.keys)&&jwks.keys.some(k=>k.kty==='RSA'));
  ok('OIDC discovery, trusted HTTPS issuer and published RS256 JWKS');

  const accessToken=await tokenFor(clientId);
  const claims=parseJwt(accessToken);
  assert.equal(claims.iss,issuer);
  assert.equal(claims.azp,clientId);
  assert.equal(claims.typ,'Bearer');
  assert.ok([claims.aud].flat().includes('aion-runtime'));
  assert.equal(claims.preferred_username,username);
  ok('Keycloak actually issued an audience-bound OAuth2 access token');
  const subject=claims.sub;
  actor=createHumanActor({name:'Ephemeral forge proof operator',
    permissions:[capability('forge.session.launch')],allowedTools:[]});
  await admin.query(
    "INSERT INTO public.actors (actor_id,actor_type,name,permissions,allowed_tools,forbidden_capabilities,max_risk_level) VALUES ($1,'human',$2,$3::jsonb,'[]'::jsonb,'[]'::jsonb,'R3')",
    [actor.actorId,actor.name,JSON.stringify(actor.permissions)]
  );
  const principalId='principal-forge-proof-'+randomUUID();
  await admin.query(
    "INSERT INTO aion_auth.principal_bindings (issuer,subject,client_id,principal_id,actor_id,kind,tenant_ids,roles,status,provisioned_by,changed_by) VALUES ($1,$2,$3,$4,$5,'operator',$6::text[],$7::text[],'active','ci-disposable-provisioner','ci-disposable-provisioner')",
    [issuer,subject,clientId,principalId,actor.actorId,[tenant],['invoke']]
  );
  ok('canonical AION Data Principal binding and durable Actor provisioned by migrator');

  const config=loadConfig({
    ...process.env,
    AION_ENVIRONMENT:'local',
    AION_AUTH_MODE:'required',
    AION_AUTH_PROVIDER:'keycloak',
    AION_GATEWAY_API_KEYS:'',
    AION_KEYCLOAK_ISSUER:issuer,
    AION_KEYCLOAK_AUDIENCE:'aion-runtime',
    AION_KEYCLOAK_ALLOWED_CLIENTS:clientId,
    DATABASE_SSL:'false',
    PORT:'18111',RUN_SMOKE_ON_BOOT:'false',GIT_SHA:'ci-proof',
  });
  cp=buildControlPlane(config);
  server=createServer(config,cp,logger);
  await server.listen();
  const body=command(actor.actorId);
  const valid=await runtimePost(accessToken,body);
  assert.equal(valid.status,409);
  assert.equal(valid.body.error,'forge_execution_disabled');
  assert.equal(valid.body.requestId,requestId);
  const eventId=valid.body.auditEventId;
  assert.match(eventId,/^[a-f0-9-]{36}$/);
  const readback=await appQuery(tenant,
    'SELECT tenant_id,principal_id,actor_id,request_id,event_id,event_type FROM forge_audit_events WHERE event_id=$1',[eventId]);
  assert.equal(readback.rows.length,1);
  assert.equal(readback.rows[0].principal_id,principalId);
  assert.equal(readback.rows[0].actor_id,actor.actorId);
  assert.equal(readback.rows[0].tenant_id,tenant);
  assert.equal(readback.rows[0].request_id,requestId);
  assert.equal(readback.rows[0].event_type,'forge.session.requested');
  evidence.auditReadback={
    requestId,eventId,principalId,actorId:actor.actorId,tenantId:tenant,
    result:'committed-and-reloaded'
  };
  ok('real Keycloak token → Runtime HTTP → Sentinel remote JWKS → Data durable readback (409 no execution)');

  const replay=await runtimePost(accessToken,body);
  assert.equal(replay.status,409);
  assert.equal(replay.body.auditEventId,eventId);
  const count=await appQuery(tenant,
    'SELECT COUNT(*)::int AS n FROM forge_audit_events WHERE event_id=$1',[eventId]);
  assert.equal(count.rows[0].n,1);
  ok('idempotent replay produces exactly one durable event');

  const invisible=await appQuery(rogueTenant,
    'SELECT event_id FROM forge_audit_events WHERE event_id=$1',[eventId]);
  assert.equal(invisible.rows.length,0);
  assert.equal((await runtimePost(accessToken,body,rogueTenant)).status,403);
  ok('cross-tenant HTTP selector and non-owner PostgreSQL RLS read denied');

  assert.equal((await runtimePost(null,body)).status,401);
  const otherClientToken=await tokenFor(otherClientId);
  assert.equal((await runtimePost(otherClientToken,body)).status,401);
  const tampered=accessToken.slice(0,-3)+'AAA';
  assert.equal((await runtimePost(tampered,body)).status,401);
  ok('missing bearer, wrong-client/wrong-audience Keycloak token and bad signature denied');

  await admin.query(
    "UPDATE aion_auth.principal_bindings SET status='disabled' WHERE issuer=$1 AND subject=$2 AND client_id=$3",
    [issuer,subject,clientId]);
  assert.equal((await runtimePost(accessToken,body)).status,401);
  await admin.query(
    "UPDATE aion_auth.principal_bindings SET status='active' WHERE issuer=$1 AND subject=$2 AND client_id=$3",
    [issuer,subject,clientId]);
  await admin.query("UPDATE public.actors SET permissions='[]'::jsonb WHERE actor_id=$1",[actor.actorId]);
  assert.equal((await runtimePost(accessToken,body)).status,403);
  await admin.query("UPDATE public.actors SET permissions=$2::jsonb WHERE actor_id=$1",
    [actor.actorId,JSON.stringify(actor.permissions)]);
  ok('disabled binding and removed durable Actor permission deny without relying on JWT roles');

  const priv=await admin.query(
    "SELECT has_table_privilege('aion_app','public.forge_audit_events','UPDATE') AS update_allowed, has_table_privilege('aion_app','public.forge_audit_events','DELETE') AS delete_allowed, has_table_privilege('aion_app','aion_auth.principal_bindings','INSERT') AS binding_insert");
  assert.equal(priv.rows[0].update_allowed,false);
  assert.equal(priv.rows[0].delete_allowed,false);
  assert.equal(priv.rows[0].binding_insert,false);
  ok('effective app-role audit UPDATE/DELETE and trust binding INSERT denied');

  await admin.query('REVOKE INSERT ON public.forge_audit_events FROM aion_app');
  // New request ID avoids successfully-replayed audit case.
  const newId='forge-'+randomUUID();
  const denied=await runtimePost(accessToken,{
    ...body,requestId:newId,
    metadata:{source:'aion-forge',forgeRequestId:newId}
  });
  assert.equal(denied.status,503);
  assert.equal(denied.body.error,'forge_audit_unavailable');
  await admin.query('GRANT INSERT ON public.forge_audit_events TO aion_app');
  ok('actual PostgreSQL audit-writer outage fails closed with redacted HTTP 503');
  evidence.approvedDeployment=false;
  evidence.realStagingDeployment=false;
  evidence.summary='CI interoperability passed; NO agent or terminal started; no staging approval issued';
  console.log('[keycloak-proof] PASS — real Keycloak on isolated HTTPS loopback with durable DB readback, Forge launch disabled');
} catch(err){
  evidence.summary='FAILED — no staging approval';
  evidence.failure=err instanceof Error ? err.message.replace(/(password|secret|token)=\S+/ig,'$1=[REDACTED]'):'unknown';
  console.error('[keycloak-proof] FAILED',evidence.failure);
  process.exitCode=1;
} finally {
  evidence.generatedAt=new Date().toISOString();
  try{
    await writeFile(process.env.RUNNER_TEMP+'/forge-keycloak-evidence.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  }catch{process.exitCode=1;}
  try{if(server)await server.close();}catch{process.exitCode=1;}
  try{if(cp)await cp.close();}catch{process.exitCode=1;}
  await admin.end();
}
