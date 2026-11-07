#!/usr/bin/env node
/**
 * AIO-FORGE-73 — isolated CI trust proof with actual RS256-signed JWTs
 * and a disposable PostgreSQL 16 instance.
 *
 * NOTE: The issuer and signer below are SYNTHETIC; this is cryptographic
 * interoperability with Sentinel, not a live Keycloak deployment or release
 * authorization. A staging Keycloak realm, JWKS rotation and HA/prod outage
 * checks remain human-operated gates.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
import { createDataLayer } from '@aion/data';
import { createKeycloakVerifier, createRuntimePrincipalLookup } from '@aion/sentinel';
import { handleGatewayRequest } from '../dist/gateway.js';
import { currentTenantId } from '../dist/tenant-context.js';
import { Logger } from '../dist/logger.js';

const adminUrl=process.env.MIGRATION_DATABASE_URL;
const appUrl=process.env.DATABASE_URL;
if(!process.env.GITHUB_ACTIONS || process.env.AION_PROOF_DB_DISPOSABLE!=='1' ||
   !adminUrl || !appUrl || adminUrl===appUrl ||
   /production|cloudsql|supabase\.co|amazonaws\.com|neon\.tech/i.test(adminUrl+' '+appUrl))
  throw Error('Forge proof requires explicit isolated GitHub Actions disposable DB and distinct role URLs');

const admin=new pg.Pool({connectionString:adminUrl, max:2});
const app=createDataLayer({connectionString:appUrl,tenantContext:currentTenantId,
  applicationName:'forge-ci-proof'});
const issuer='https://auth.example.invalid/realms/aion-forge-proof';
const audience='aion-runtime';
const client='forge-ephemeral-ci';
const tenant='forge-proof-a';
const principalId='principal-forge-'+randomUUID();
const actorId='act_forge_'+randomUUID();
const subject=randomUUID();
const requestId='forge-'+randomUUID();
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const wrongKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
const logger=new Logger({service:'forge-ci-proof',environment:'test',
  gitSha:'synthetic',serviceVersion:'0'},'error');
const now=()=>Math.floor(Date.now()/1000);
function signed(payload={},key=privateKey){
  const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'ci-local-rsa-1',typ:'JWT'})).toString('base64url');
  const data=Buffer.from(JSON.stringify({iss:issuer,aud:audience,azp:client,
    sub:subject,typ:'Bearer',iat:now(),exp:now()+120,...payload})).toString('base64url');
  const text=head+'.'+data;
  return text+'.'+sign('RSA-SHA256',Buffer.from(text),key).toString('base64url');
}
function mockRequest(token,body,tenantHeader=tenant){
  return {headers:{authorization:'Bearer '+token,'x-aion-tenant-id':tenantHeader},
    async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}};
}
const body={requestId,name:'ForgeSessionLaunch',serviceKey:'forge.session.launch',
  actor:{actorId},payload:{workspaceId:'forge-staging-example',template:'reviewer'},
  metadata:{source:'aion-forge',forgeRequestId:requestId},environment:'staging'};
const verifier=createKeycloakVerifier({issuer,audience,allowedClients:[client],
  jwks:async()=>publicKey,
  lookupPrincipal:createRuntimePrincipalLookup({
    getBinding:(id)=>app.identityBindings.getActive(id),
    getActor:(id)=>app.actors.get(id)
  })
});
const cp={auth:{mode:'required',provider:'keycloak',apiKeys:[],
  keycloak:{issuer,audience,allowedClients:[client]}},
  keycloakVerifier:verifier,dataLayer:app,
  orchestrator:{submit:()=>{throw Error('FORGE_PROOF_EXECUTION_BYPASS');}}};
let evidenceId=null;let inserted=false;
async function hit(token,content=body,tenantHeader=tenant,controlPlane=cp){
  return handleGatewayRequest('POST','/v1/commands',
    mockRequest(token,content,tenantHeader),controlPlane,logger);
}
async function scopedRead(activeTenant,query,values=[]){
  const client=await admin.connect();
  try {
    await client.query("SELECT set_config($1,$2,false)",['aion.tenant_id',activeTenant]);
    return await client.query(query,values);
  } finally { client.release(); }
}

try{
  // Only the disposable CI migration role provisions a synthetic Actor and
  // auth binding. The runtime app role cannot create trusted identity mappings.
  await admin.query(
    "INSERT INTO public.actors (actor_id,actor_type,name,permissions,allowed_tools,forbidden_capabilities,max_risk_level) VALUES ($1,'human',$2,$3::jsonb,'[]'::jsonb,'[]'::jsonb,'R3')",
    [actorId,'Forge isolated CI human',JSON.stringify(['forge.session.launch'])]
  );
  await admin.query(
    "INSERT INTO aion_auth.principal_bindings (issuer,subject,client_id,principal_id,actor_id,kind,tenant_ids,roles,status,provisioned_by,changed_by) VALUES ($1,$2,$3,$4,$5,'operator',$6::text[],$7::text[],'active','forge-ci-migrator','forge-ci-migrator')",
    [issuer,subject,client,principalId,actorId,[tenant],['invoke']]
  );
  inserted=true;
  console.log('[forge-proof] provisioned synthetic durable Principal+Actor in disposable PostgreSQL');

  const validToken=signed();
  const answer=await hit(validToken);
  assert.equal(answer?.status,409,'audited signed identity must still be execution-disabled');
  assert.equal(answer?.body?.error,'forge_execution_disabled');
  evidenceId=answer.body.auditEventId;
  assert.match(evidenceId,/^[0-9a-f-]{36}$/);
  const saved=await scopedRead(tenant,
    'SELECT event_id,tenant_id,principal_id,actor_id,request_id,event_type,workspace_id,template FROM public.forge_audit_events WHERE event_id=$1',
    [evidenceId]);
  assert.equal(saved.rows.length,1,'committed audit readback missing');
  assert.deepEqual({
    tenant:saved.rows[0].tenant_id,principal:saved.rows[0].principal_id,actor:saved.rows[0].actor_id,
    request:saved.rows[0].request_id
  },{tenant,principal:principalId,actor:actorId,request:requestId});
  console.log('[forge-proof] RS256 JWT verified via Sentinel; durable AION Data audit readback PASS');

  const replay=await hit(validToken);
  assert.equal(replay?.status,409);
  assert.equal(replay?.body?.auditEventId,evidenceId);
  const count=await scopedRead(tenant,
    'SELECT count(*)::int AS n FROM public.forge_audit_events WHERE event_id=$1',[evidenceId]);
  assert.equal(count.rows[0].n,1);
  console.log('[forge-proof] deterministic replay produced exactly one durable row');

  for(const [scenario,token] of [
    ['bad signature',signed({},wrongKey)],
    ['wrong issuer',signed({iss:'https://evil.example.invalid/realms/other'})],
    ['wrong audience',signed({aud:'unauthorized'})],
    ['wrong client',signed({azp:'unknown-client'})],
    ['expired',signed({exp:now()-90})]
  ]){
    const failed=await hit(token);
    assert.equal(failed?.status,401,scenario);
  }
  assert.equal((await hit(validToken,body,'forge-proof-other'))?.status,403);
  console.log('[forge-proof] invalid signed claims and cross-tenant gateway requests DENIED');

  const otherTenant=await admin.connect();
  try {
    await otherTenant.query("SELECT set_config($1,$2,false)",['aion.tenant_id','forge-proof-other']);
    const invisible=await otherTenant.query(
      'SELECT event_id FROM public.forge_audit_events WHERE event_id=$1',[evidenceId]);
    assert.equal(invisible.rows.length,0,'cross-tenant RLS leaked an audit row');
  } finally {otherTenant.release();}
  const priv=await admin.query(
    "SELECT has_table_privilege('aion_app','public.forge_audit_events','UPDATE') AS upd, has_table_privilege('aion_app','public.forge_audit_events','DELETE') AS del");
  assert.equal(priv.rows[0].upd,false,'Runtime grants accidentally restored UPDATE');
  assert.equal(priv.rows[0].del,false,'Runtime grants accidentally restored DELETE');
  console.log('[forge-proof] tenant RLS and post-migration app-role UPDATE/DELETE denial PASS');

  await admin.query(
    "UPDATE aion_auth.principal_bindings SET status='revoked' WHERE issuer=$1 AND subject=$2 AND client_id=$3",
    [issuer,subject,client]);
  assert.equal((await hit(validToken))?.status,401);
  await admin.query(
    "UPDATE aion_auth.principal_bindings SET status='active' WHERE issuer=$1 AND subject=$2 AND client_id=$3",
    [issuer,subject,client]);
  await admin.query('UPDATE public.actors SET permissions=$2::jsonb WHERE actor_id=$1',
    [actorId,'[]']);
  assert.equal((await hit(validToken))?.status,403);
  await admin.query('UPDATE public.actors SET permissions=$2::jsonb WHERE actor_id=$1',
    [actorId,JSON.stringify(['forge.session.launch'])]);
  console.log('[forge-proof] live revoked-binding and missing-durable-grant DENY PASS');

  const broken={...cp,dataLayer:{...app,forgeAudit:{append:async()=>{
    throw Error('simulated_database_outage_secret');
  }}}};
  const outage=await hit(validToken,body,tenant,broken);
  assert.equal(outage?.status,503);
  assert.ok(!JSON.stringify(outage).includes('secret'));
  console.log('[forge-proof] audit sink outage denies before execution; error redacted');

  const final=await scopedRead(tenant,
    'SELECT count(*)::int AS n FROM forge_audit_events WHERE request_id=$1',[requestId]);
  assert.equal(final.rows[0].n,1);
  console.log('[forge-proof] PASS — signed-token + PostgreSQL evidence, NO sessions or workers started');
}catch(err){
  console.error('[forge-proof] FAIL',err instanceof Error ? err.message:'unknown');
  process.exitCode=1;
}finally{
  try{
    if(inserted){
      await scopedRead(tenant,'DELETE FROM public.forge_audit_events WHERE request_id=$1',[requestId]);
      await admin.query('DELETE FROM aion_auth.principal_bindings WHERE issuer=$1 AND subject=$2 AND client_id=$3',
        [issuer,subject,client]);
      await admin.query('DELETE FROM public.actors WHERE actor_id=$1',[actorId]);
    }
  }catch{console.error('[forge-proof] failed to clean disposable CI fixtures');process.exitCode=1;}
  await app.close();await admin.end();
}
