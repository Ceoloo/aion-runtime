/**
 * AIO-FORGE-73: fail-closed, AUDIT-ONLY bridge inside the existing Runtime
 * Execution Gateway. No Forge service, worker or execution capability is
 * registered by this code. This handler NEVER calls Orchestrator.submit.
 *
 * Forge may supply a request ID and workspace hints; trust is derived entirely
 * from the *already verified* Sentinel Principal and a fresh AION Data Actor.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ForgeAuditRecord } from '@aion/data';
import type { ControlPlane } from '../control-plane.js';
import type { Principal } from '../auth/types.js';

const CAPABILITY = 'forge.session.launch';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^forge-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE = new Set(['implementer','reviewer']);
const BODY_FIELDS = new Set(['requestId','name','serviceKey','actor','payload','metadata','environment']);

type Response = { status: number; body: { error: string; message: string; requestId?: string; auditEventId?: string } };
const reject = (status:number,error:string):Response =>
  ({status,body:{error,message:'Forge session execution is unavailable; no work was started'}});

export function isForgeCommand(body:unknown):boolean {
  if(!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const row=body as Record<string,unknown>;
  return row.serviceKey === CAPABILITY || row.serviceKey === CAPABILITY+'@1' ||
    row.capability === CAPABILITY;
}

function eventIdFor(fields:Record<string,string>):string {
  // Exact immutable Forge v0.2 client event-id contract, keyed to server-owned
  // identifiers. Replayed requests have the same ID; mismatched payloads fail
  // the Data repository's content fingerprint / tenant checks.
  const canonical=JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map(k=>[k,fields[k]])));
  const hex=createHash('sha256').update('aion-forge:audit:v1:'+canonical).digest('hex');
  return [hex.slice(0,8),hex.slice(8,12),'5'+hex.slice(13,16),
    'a'+hex.slice(17,20),hex.slice(20,32)].join('-');
}

/**
 * Called ONLY after authenticateGatewayRequest, on POST /v1/commands.
 * The caller's bearer has already been signature-, issuer-, audience-,
 * client- and durable binding-verified by Sentinel. This bridge independently
 * reloads the Actor and never uses the body as an authority source.
 */
export async function handleForgeSessionAttestation(
  body:unknown, cp:ControlPlane, principal:Principal|null, req:IncomingMessage
):Promise<Response>{
  if(cp.auth.provider !== 'keycloak' || cp.auth.mode !== 'required' ||
      !cp.keycloakVerifier || !principal) return reject(403,'forge_identity_required');
  const header=req.headers['x-aion-tenant-id'];
  const tenantId=typeof header==='string' && ID.test(header) ? header : null;
  if(!tenantId || !principal.tenantIds.includes(tenantId))
    return reject(403,'forge_tenant_forbidden');
  if(!principal.roles.includes('invoke'))
    return reject(403,'forge_invoke_forbidden');
  if(!body || typeof body!=='object'||Array.isArray(body))
    return reject(400,'forge_invalid_request');

  const raw=body as Record<string,unknown>;
  if(Object.keys(raw).some(k=>!BODY_FIELDS.has(k)) ||
     !REQUEST_ID.test(raw.requestId as string) ||
     raw.name!=='ForgeSessionLaunch' ||
     ![CAPABILITY,CAPABILITY+'@1'].includes(raw.serviceKey as string) ||
     raw.environment!=='staging' ||
     !raw.actor || typeof raw.actor!=='object' || Array.isArray(raw.actor) ||
     (raw.actor as Record<string,unknown>).actorId!==principal.actorId ||
     !raw.payload || typeof raw.payload!=='object'||Array.isArray(raw.payload) ||
     !raw.metadata || typeof raw.metadata!=='object'||Array.isArray(raw.metadata))
    return reject(400,'forge_invalid_request');

  const payload=raw.payload as Record<string,unknown>;
  const metadata=raw.metadata as Record<string,unknown>;
  if(Object.keys(payload).length!==2 ||
      !ID.test(payload.workspaceId as string) ||
      !TEMPLATE.has(payload.template as string) ||
      Object.keys(metadata).length!==2 ||
      metadata.forgeRequestId!==raw.requestId ||
      metadata.source!=='aion-forge')
    return reject(400,'forge_invalid_request');

  let actor:Awaited<ReturnType<typeof cp.dataLayer.actors.get>>;
  try { actor=await cp.dataLayer.actors.get(principal.actorId as never); }
  catch {return reject(503,'forge_identity_store_unavailable');}
  if(!actor || actor.actorId!==principal.actorId) return reject(403,'forge_actor_forbidden');
  const kindMap={operator:'human',service:'service','agent-worker':'agent'} as const;
  if(actor.actorType!==kindMap[principal.kind])return reject(403,'forge_actor_forbidden');
  if(actor.actorType==='agent' &&
      (actor.revocationState!=='active' || actor.tenantId!==tenantId))
    return reject(403,'forge_actor_forbidden');
  const allowed=actor.permissions.map(String);
  const forbidden=actor.forbiddenCapabilities.map(String);
  if(actor.maxRiskLevel!=='R3' || !allowed.includes(CAPABILITY) || forbidden.includes(CAPABILITY))
    return reject(403,'forge_permission_forbidden');

  // The only persistent metadata comes from server-bound Principal and Actor.
  // No browser-provided grants, opaque shell arguments, secrets, paths or
  // transcript content may reach the audit store.
  const fields={
    type:'forge.session.requested',
    requestId:raw.requestId as string,
    tenantId,
    principalId:principal.principalId,
    actorId:actor.actorId,
    workspaceId:payload.workspaceId as string,
    template:payload.template as 'implementer'|'reviewer',
  };
  const record:ForgeAuditRecord={
    ...fields,
    eventId:eventIdFor(fields),
    schemaVersion:'forge.audit.v1',
    recordedAt:new Date().toISOString(),
  };
  try {
    const ack=await cp.dataLayer.forgeAudit.append(record);
    if(ack.committed!==true || ack.eventId!==record.eventId)
      return reject(503,'forge_audit_unavailable');
  } catch {return reject(503,'forge_audit_unavailable');}

  // Explicitly NO execution. A future service activation must be separately
  // reviewed, have a Runtime-owned worker, and preserve Core's R3 human gate.
  return {status:409,body:{
    error:'forge_execution_disabled',
    message:'Forge request durably attested; session launch remains disabled',
    requestId:fields.requestId,
    auditEventId:record.eventId,
  }};
}
