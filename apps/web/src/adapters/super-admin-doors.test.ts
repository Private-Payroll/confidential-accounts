import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * WHAT A SUPER ADMIN'S DEVICE HANDS THE SERVICE FROM THIS PAGE: each ask of a change goes through the super admins' asks
 * of the company, and carries the signed request when the person acts, or reads with their key. The service is stood in
 * for; what it does with each ask is src/server/one-super-admin-change-lands-on-every-contract.test.ts.
 */
const st = vi.hoisted(() => ({ calls: [] as { path: string; method: string; headers: unknown; body: unknown }[] }));
const SIGNED = { 'x-signed': 'by the super admin' };
vi.mock('vaults-web-shared/super-admin-ask.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/super-admin-ask.js')>()),
  superAdminSigned: async () => ({ headers: SIGNED }),
}));
vi.mock('vaults-web-shared/service-transport.js', async (real) => {
  const call = async (path: string, init?: RequestInit) => {
    st.calls.push({ path, method: String(init?.method ?? 'GET'), headers: init?.headers, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return { changes: [{ chainId: 'kept' }], signatures: [] };
  };
  return { ...(await real<typeof import('vaults-web-shared/service-transport.js')>()), api: call, serviceCall: call };
});

const { superAdminService } = await import('./super-admin-doors.js');
const K = { tag: 'schnorr', value: '01'.repeat(32) };
const reach = (asSuperAdmin: boolean) => ({ company: { accountId: 'c-1', label: 'co', account: 'a0' }, asSuperAdmin }) as never;

beforeEach(() => { st.calls = []; });

describe('a super admin\'s asks of a change', () => {
  /* RED WHEN: an ask that acts goes without the signed request, or reaches a route other than the change's own. */
  it('raises, joins and keeps signatures with the signed request, at the change\'s own routes', async () => {
    const service = superAdminService(reach(false));
    await service.raise({ company: 'co', salt: 's', change: {} as never, raisedBy: { key: K, signature: 'ab' } });
    await service.join({ chainId: 'c', joined: { key: K, signature: 'ab' } });
    await service.keepSignatures({ to: { committee: [K], threshold: 1 }, signatures: [] });
    expect(st.calls.map((c) => [c.path, c.method, c.headers])).toEqual([
      ['/api/accounts/c-1/committee-change/raise', 'POST', SIGNED],
      ['/api/accounts/c-1/committee-change/join', 'POST', SIGNED],
      ['/api/accounts/c-1/committee-change/signatures', 'POST', SIGNED],
    ]);
    expect(st.calls[2]!.body).toEqual({ to: { committee: [K], threshold: 1 }, signatures: [] });
  });

  /* RED WHEN: a signer reading as a member is made to sign a request, or a super admin by a link reads without one. */
  it('reads the kept changes as a member unless the person reads with their key', async () => {
    expect(await superAdminService(reach(false)).kept()).toEqual([{ chainId: 'kept' }]);
    await superAdminService(reach(true)).kept();
    expect(st.calls.map((c) => [c.path, c.method, c.headers])).toEqual([
      ['/api/accounts/c-1/committee-change/signatures', 'GET', {}],
      ['/api/accounts/c-1/committee-change/signatures', 'GET', SIGNED],
    ]);
  });
});
