/**
 * Request tenant context (ADR-005 follow-on: tenant RLS wiring).
 *
 * aion-data's tenant RLS policies (migration 0010) bind the non-owner app role
 * (`aion_app`) to `aion.tenant_id`. AION Data sets that setting on every
 * connection it hands out, from the getter this module supplies
 * (`DataLayerConfig.tenantContext`). Runtime decides WHICH tenant: the
 * principal-authorised `x-aion-tenant-id` at request entry, re-bound to the
 * durable agent's tenant once the gateway has resolved the actor.
 *
 * RLS is defence in depth, not authority: the PolicyEngine and the gateway's
 * tenant checks still decide what is allowed. Outside any request (boot smoke,
 * background work) there is no tenant unless {@link runWithTenant} provides
 * one — the database then fails closed to tenant-less rows only.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantScope {
  tenantId: string | undefined;
}

const tenantScope = new AsyncLocalStorage<TenantScope>();

/** The tenant of the unit of work currently executing, if any. */
export function currentTenantId(): string | undefined {
  return tenantScope.getStore()?.tenantId;
}

/** Starts the tenant scope for the rest of the current request. */
export function enterRequestTenant(tenantId: string | undefined): void {
  tenantScope.enterWith({ tenantId });
}

/**
 * Re-binds the current request's tenant (e.g. to a durable agent's tenant
 * after actor resolution). A no-op outside a request scope.
 */
export function bindRequestTenant(tenantId: string | undefined): void {
  const scope = tenantScope.getStore();
  if (scope) scope.tenantId = tenantId;
}

/** Runs `fn` with an explicit tenant (non-request work such as the boot smoke). */
export function runWithTenant<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return tenantScope.run({ tenantId }, fn);
}
