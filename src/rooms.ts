/**
 * Shared-room gateway.
 *
 * Humans and agents use the same routes. Membership and the timeline live in
 * Core's SharedRoom. Runtime resolves the durable actor first, so a suspended
 * or revoked agent cannot enter, and the tenant header is the room's tenant.
 * Posting still does not authorize execution.
 */
import type { IncomingMessage } from 'node:http';
import {
  Actor,
  RoomId,
  registryAllowsExecution,
  type AgentActor,
  type RoomPost,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import type { Principal } from './auth/types.js';
import { assertPrincipalTenantAccess } from './auth/authenticate.js';
import { resolveDurableActor } from './auth/resolve-actor.js';

export interface RoomGatewayResponse {
  status: number;
  body: unknown;
}

function jsonError(status: number, code: string, message: string): RoomGatewayResponse {
  return { status, body: { error: code, message } };
}

function callerTenantId(req: IncomingMessage): string | undefined {
  const header = req.headers['x-aion-tenant-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireTenant(
  req: IncomingMessage,
  principal: Principal | null,
): { ok: true; tenantId: string } | { ok: false; response: RoomGatewayResponse } {
  const tenantId = callerTenantId(req);
  if (!tenantId) {
    return {
      ok: false,
      response: jsonError(403, 'tenant_required', 'x-aion-tenant-id header is required'),
    };
  }
  const denied = assertPrincipalTenantAccess(principal, tenantId, { requireTenant: true });
  if (denied) return { ok: false, response: jsonError(denied.status, denied.code, denied.message) };
  return { ok: true, tenantId };
}

function parseRoomId(roomId: string): { ok: true; roomId: ReturnType<typeof RoomId.parse> } | { ok: false; response: RoomGatewayResponse } {
  const parsed = RoomId.safeParse(roomId);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(400, 'validation', 'room id must start with rom_'),
    };
  }
  return { ok: true, roomId: parsed.data };
}

async function resolveActor(
  cp: ControlPlane,
  raw: unknown,
  principal: Principal | null,
): Promise<{ ok: true; actor: ReturnType<typeof Actor.parse> } | { ok: false; response: RoomGatewayResponse }> {
  const parsed = Actor.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: jsonError(400, 'validation', 'actor must be an Actor') };
  }
  const resolved = await resolveDurableActor(cp, parsed.data, principal, cp.auth.mode);
  if (!resolved.ok) return { ok: false, response: jsonError(resolved.status, resolved.code, resolved.message) };
  return { ok: true, actor: resolved.actor };
}

function actorIdFromUrl(url: string): string | undefined {
  const query = url.split('?')[1] ?? '';
  const value = new URLSearchParams(query).get('actorId');
  return value && value.length > 0 ? value : undefined;
}

async function reader(
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
  url: string,
): Promise<{ ok: true; actor: ReturnType<typeof Actor.parse>; tenantId: string } | { ok: false; response: RoomGatewayResponse }> {
  const tenant = requireTenant(req, principal);
  if (!tenant.ok) return tenant;
  let actorId = actorIdFromUrl(url);
  if (principal) {
    if (actorId && actorId !== principal.actorId) {
      return {
        ok: false,
        response: jsonError(403, 'actor_forbidden', 'actorId must match the authenticated principal'),
      };
    }
    actorId = principal.actorId;
  }
  if (!actorId) {
    return { ok: false, response: jsonError(400, 'validation', 'actorId query is required') };
  }
  const actor = await cp.dataLayer.actors.get(actorId as never);
  if (!actor) {
    return {
      ok: false,
      response: jsonError(403, 'actor_not_registered', `actor ${actorId} is not registered`),
    };
  }
  if (actor.actorType === 'agent' && !registryAllowsExecution(actor as AgentActor)) {
    return {
      ok: false,
      response: jsonError(
        403,
        'agent_revoked',
        `agent ${actor.actorId} revocation_state=${(actor as AgentActor).revocationState ?? 'active'} — registry denies the room`,
      ),
    };
  }
  return { ok: true, actor, tenantId: tenant.tenantId };
}

function isResponse(value: RoomPost | RoomGatewayResponse): value is RoomGatewayResponse {
  return 'body' in value && 'status' in value;
}

function agentOutsideTenant(
  actor: { actorType: string; tenantId?: string },
  tenantId: string,
): RoomGatewayResponse | undefined {
  if (actor.actorType === 'agent' && actor.tenantId !== tenantId) {
    return jsonError(403, 'tenant_forbidden', 'agent tenant does not match the caller tenant');
  }
  return undefined;
}

function parsePost(raw: unknown): RoomPost | RoomGatewayResponse {
  const post = asRecord(raw);
  if (!post || (post.kind !== 'say' && post.kind !== 'handoff' && post.kind !== 'decision')) {
    return jsonError(400, 'validation', 'post.kind must be say, handoff, or decision');
  }
  if (post.kind === 'handoff') {
    return { kind: 'handoff', handoff: post.handoff } as RoomPost;
  }
  if (typeof post.statement !== 'string') {
    return jsonError(400, 'validation', 'statement is required');
  }
  if (post.kind === 'decision') return { kind: 'decision', statement: post.statement };
  const mentions = Array.isArray(post.mentions)
    ? post.mentions.filter((id): id is string => typeof id === 'string')
    : [];
  return { kind: 'say', statement: post.statement, mentions } as RoomPost;
}

export async function openRoom(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RoomGatewayResponse> {
  const tenant = requireTenant(req, principal);
  if (!tenant.ok) return tenant.response;
  const raw = asRecord(body);
  if (!raw) return jsonError(400, 'validation', 'body must be an object');
  if (typeof raw.name !== 'string' || typeof raw.purpose !== 'string') {
    return jsonError(400, 'validation', 'name and purpose are required');
  }
  if (raw.visibility !== undefined && raw.visibility !== 'open' && raw.visibility !== 'private') {
    return jsonError(400, 'validation', 'visibility must be open or private');
  }
  const founder = await resolveActor(cp, raw.founder, principal);
  if (!founder.ok) return founder.response;
  const outside = agentOutsideTenant(founder.actor, tenant.tenantId);
  if (outside) return outside;
  const opened = cp.rooms.open({
    tenantId: tenant.tenantId,
    name: raw.name,
    purpose: raw.purpose,
    founder: founder.actor,
    visibility: raw.visibility === 'open' ? 'open' : 'private',
  });
  return { status: 201, body: opened };
}

export async function joinRoom(
  roomId: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RoomGatewayResponse> {
  const tenant = requireTenant(req, principal);
  if (!tenant.ok) return tenant.response;
  const id = parseRoomId(roomId);
  if (!id.ok) return id.response;
  const actor = await resolveActor(cp, asRecord(body)?.actor, principal);
  if (!actor.ok) return actor.response;
  const outside = agentOutsideTenant(actor.actor, tenant.tenantId);
  if (outside) return outside;
  return { status: 200, body: cp.rooms.join(id.roomId, actor.actor, tenant.tenantId) };
}

export async function admitRoomMember(
  roomId: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RoomGatewayResponse> {
  const tenant = requireTenant(req, principal);
  if (!tenant.ok) return tenant.response;
  const id = parseRoomId(roomId);
  if (!id.ok) return id.response;
  const raw = asRecord(body);
  const by = await resolveActor(cp, raw?.by, principal);
  if (!by.ok) return by.response;
  const actor = await resolveActor(cp, raw?.actor, principal);
  if (!actor.ok) return actor.response;
  const byOutside = agentOutsideTenant(by.actor, tenant.tenantId);
  if (byOutside) return byOutside;
  const actorOutside = agentOutsideTenant(actor.actor, tenant.tenantId);
  if (actorOutside) return actorOutside;
  return { status: 200, body: cp.rooms.admit(id.roomId, by.actor, actor.actor) };
}

export async function enterRoom(
  roomId: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RoomGatewayResponse> {
  return presence(roomId, body, cp, req, principal, 'enter');
}

export async function leaveRoom(
  roomId: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RoomGatewayResponse> {
  return presence(roomId, body, cp, req, principal, 'leave');
}

async function presence(
  roomId: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
  action: 'enter' | 'leave',
): Promise<RoomGatewayResponse> {
  const tenant = requireTenant(req, principal);
  if (!tenant.ok) return tenant.response;
  const id = parseRoomId(roomId);
  if (!id.ok) return id.response;
  const actor = await resolveActor(cp, asRecord(body)?.actor, principal);
  if (!actor.ok) return actor.response;
  const outside = agentOutsideTenant(actor.actor, tenant.tenantId);
  if (outside) return outside;
  const entry =
    action === 'enter'
      ? cp.rooms.enter(id.roomId, actor.actor)
      : cp.rooms.leave(id.roomId, actor.actor);
  return { status: 200, body: entry };
}

export async function postToRoom(
  roomId: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RoomGatewayResponse> {
  const tenant = requireTenant(req, principal);
  if (!tenant.ok) return tenant.response;
  const id = parseRoomId(roomId);
  if (!id.ok) return id.response;
  const raw = asRecord(body);
  const actor = await resolveActor(cp, raw?.actor, principal);
  if (!actor.ok) return actor.response;
  const outside = agentOutsideTenant(actor.actor, tenant.tenantId);
  if (outside) return outside;
  const post = parsePost(raw?.post);
  if (isResponse(post)) return post;
  return { status: 201, body: cp.rooms.post(id.roomId, actor.actor, post) };
}

export async function readRoom(
  roomId: string,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
  url: string,
): Promise<RoomGatewayResponse> {
  const id = parseRoomId(roomId);
  if (!id.ok) return id.response;
  const who = await reader(cp, req, principal, url);
  if (!who.ok) return who.response;
  const room = cp.rooms.get(id.roomId, who.actor);
  if (room.tenantId !== who.tenantId) {
    return jsonError(403, 'tenant_forbidden', 'room is outside the caller tenant');
  }
  return {
    status: 200,
    body: {
      room,
      members: cp.rooms.members(id.roomId, who.actor),
      present: cp.rooms.present(id.roomId, who.actor),
      timeline: cp.rooms.timeline(id.roomId, who.actor),
    },
  };
}

export async function roomAttention(
  roomId: string,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
  url: string,
): Promise<RoomGatewayResponse> {
  const id = parseRoomId(roomId);
  if (!id.ok) return id.response;
  const who = await reader(cp, req, principal, url);
  if (!who.ok) return who.response;
  const room = cp.rooms.get(id.roomId, who.actor);
  if (room.tenantId !== who.tenantId) {
    return jsonError(403, 'tenant_forbidden', 'room is outside the caller tenant');
  }
  return { status: 200, body: { attention: cp.rooms.attention(id.roomId, who.actor) } };
}
