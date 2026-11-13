// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { mayInvite, READER_PURPOSES, RIGHTS_PRESET, ROLES, SIGNER_ROLES } from '../../../../src/core/roles.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * THE ROLES LIST ON THE ROLES AND PERMISSIONS PAGE, DRAWN with only the reads of the seats and the readers, and the asks of the wallet,
 * stood in for: the five roles and what each may do as the one list of roles gives it, who holds each, what a role change asks of the
 * wallet and what the page says it makes public, and the words after each answer.
 */
const st = vi.hoisted(() => ({
  roles: null as unknown, readers: null as unknown, changes: [] as unknown[][], continues: [] as unknown[][], drops: [] as unknown[][], dropped: null as unknown, changed: null as unknown, continued: null as unknown, begun: [] as unknown[], reads: 0, hold: null as Promise<unknown> | null,
}));
vi.mock('../adapters/roles-here.js', async (real) => ({
  ...(await real<typeof import('../adapters/roles-here.js')>()),
  readRoles: async () => { st.reads += 1; return st.roles; },
  changeRole: async (...a: unknown[]) => { st.changes.push(a); return st.hold ?? st.changed; },
  continueRoleChange: async (...a: unknown[]) => { st.continues.push(a); return st.continued; },
  dropRoleChange: async (...a: unknown[]) => { st.drops.push(a); return st.dropped; },
  startedRoleChanges: () => st.begun,
}));
vi.mock('../adapters/grants-here.js', async (real) => ({
  ...(await real<typeof import('../adapters/grants-here.js')>()),
  readGrants: async () => st.readers,
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { RolesList } = await import('../records/roles-list.js');
const { SessionProvider } = await import('../session.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const words = (key: string, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key] ?? key);
const leaf = (n: number): string => n.toString(16).padStart(64, '0');
const PRIVATE = 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u';
const seatOf = (n: number, over: Record<string, unknown> = {}) => ({ leaf: leaf(n), name: `Name ${n}`, role: 'approver', you: false, leaving: false, ...over });
const HOLDERS = { approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 2, seated: 3 };
const readOf = (seats: unknown[], holders: unknown = HOLDERS) => ({ of: 'read', seats, holders });
const SEATS = [seatOf(1, { role: 'admin' }), seatOf(2, { you: true }), seatOf(3, { role: 'initiator' })];
const READERS = { of: 'read', readers: [{ recipient: leaf(5), person: 'rhea', role: 'accountant' }, { recipient: leaf(6), person: 'abe', role: 'limited' }], waiting: null };
const turn = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { await act(async () => { await turn(); await turn(); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const all = (s: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(s)];
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const type = async (selector: string, value: string) => { fireEvent.change(q(selector)!, { target: { value } }); await settle(); };
const text = (): string => document.body.textContent ?? '';
const draw = async () => {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={{
        person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
        chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
      }}
      >
        <div data-screen="roles"><RolesList /></div>
      </SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await settle();
};
const choose = async (seat: number, role: string, address = PRIVATE) => {
  await press(`[data-seat="${leaf(seat)}"]`);
  await press(`[data-field="role"] [data-role="${role}"]`);
  await type('[data-field="address"]', address);
};

beforeEach(() => { st.roles = readOf(SEATS); st.readers = READERS; st.changes = []; st.continues = []; st.drops = []; st.dropped = null; st.changed = { of: 'done', stage: 'remove', state: 'waiting-for-approvals', approvals: 1, needed: 2 }; st.continued = null; st.begun = []; st.reads = 0; st.hold = null; });
afterEach(() => { cleanup(); });

describe('the five roles and what each may do', () => {
  /* RED WHEN: a role the company has is not on the page, or the page shows a role it does not have, or the roles are not in the one list's order. */
  it('shows every role the company has, in order', async () => {
    await draw();
    expect(all('[data-role-row]').map((r) => r.dataset['roleRow'])).toEqual([...ROLES]);
  });

  /* RED WHEN: a role is drawn as raising, approving, holding, inviting or filing what the one list of roles does not give it, or the reverse. */
  it('draws what each role may do from the one list of roles', async () => {
    await draw();
    for (const row of all('[data-role-row]')) {
      const role = row.dataset['roleRow']!;
      const signer = (SIGNER_ROLES as readonly string[]).includes(role);
      const rights = signer ? RIGHTS_PRESET[role as keyof typeof RIGHTS_PRESET] : { mayRaise: false, mayApprove: false, mayHold: false };
      expect(row.dataset['seat']).toBe(String(signer));
      expect([row.dataset['mayRaise'], row.dataset['mayApprove'], row.dataset['mayHold']]).toEqual([String(rights.mayRaise), String(rights.mayApprove), String(rights.mayHold)]);
      expect(row.dataset['mayInvite']).toBe(String(mayInvite({ role: role as never })));
      const says = row.querySelector('[data-may-do]')!.textContent ?? '';
      expect(says.includes(EN['roles.may.raise']!)).toBe(rights.mayRaise);
      expect(says.includes(EN['roles.may.approve']!)).toBe(rights.mayApprove);
      expect(says.includes(EN['roles.may.hold']!)).toBe(rights.mayHold);
    }
  });

  /* RED WHEN: a reader is drawn as reading a purpose its read grant does not name, or not one it does. */
  it('draws what each reader reads from the purposes its grant names', async () => {
    await draw();
    for (const role of ['limited', 'accountant'] as const) {
      const row = q(`[data-role-row="${role}"]`)!;
      expect([...row.querySelectorAll<HTMLElement>('[data-read]')].map((e) => e.dataset['read'])).toEqual([...READER_PURPOSES[role]]);
      for (const purpose of READER_PURPOSES[role]) expect(row.textContent).toContain(EN[`roles.reads.purpose.${purpose}`]!);
    }
    expect(q('[data-role-row="limited"]')!.textContent).not.toContain(EN['roles.reads.purpose.payroll']!);
    expect(q('[data-role-row="admin"]')!.textContent).not.toContain(EN['roles.reads.purpose.payroll']!);
  });

  /* RED WHEN: a hold is said to belong to a person, or to be one that can always be released, or a hold is told of a role that does not hold. */
  it('says a hold is released at once only by the seat that placed it, and only where a role may hold', async () => {
    await draw();
    expect(EN['roles.may.hold']).toMatch(/Only the seat that placed the hold releases it at once/u);
    expect(EN['roles.may.hold']).not.toMatch(/person|always/iu);
    expect(q('[data-role-row="approver"]')!.textContent).toContain(EN['roles.may.hold']!);
    expect(q('[data-role-row="initiator"]')!.textContent).not.toContain(EN['roles.may.hold']!);
  });
});

describe('who holds each role', () => {
  /* RED WHEN: a seat is listed under a role it does not hold, a reader under a signer's role, or the person's own seat is not marked. */
  it('lists the seats and the readers under the role each holds, and marks the person\'s own seat', async () => {
    await draw();
    const held = (role: string) => all(`[data-holders="${role}"] [data-holder]`).map((h) => h.textContent);
    expect(held('admin')).toEqual(['Name 1']);
    expect(held('approver')).toEqual([`Name 2 (${EN['roles.list.you']})`]);
    expect(held('initiator')).toEqual(['Name 3']);
    expect(held('accountant')).toEqual(['rhea']);
    expect(held('limited')).toEqual(['abe']);
  });

  /* RED WHEN: the founding seat, which holds no role, is left off the page or listed as a role of its own, or is not told as the admins'. */
  it('lists the founding seat with the admins and says why', async () => {
    st.roles = readOf([seatOf(1, { role: null }), seatOf(2, { role: 'admin' })]);
    await draw();
    expect(all('[data-holders="admin"] [data-holder]').map((h) => h.textContent)).toEqual([`Name 1 (${EN['roles.list.founding']})`, 'Name 2']);
    expect(q('[data-founding-says]')!.textContent).toBe(EN['roles.list.foundingSays']);
  });

  /* RED WHEN: a role nobody holds is shown as held, or says nothing. */
  it('says when nobody holds a role', async () => {
    st.readers = { of: 'read', readers: [], waiting: null };
    await draw();
    expect(q('[data-holders="accountant"]')!.textContent).toContain(EN['roles.list.nobody']!);
  });

  /* RED WHEN: a seat being removed is shown as one that stays. */
  it('marks a seat that is being removed', async () => {
    st.roles = readOf([seatOf(1, { role: 'admin' }), seatOf(2, { leaving: true })]);
    await draw();
    expect(q('[data-holders="approver"]')!.textContent).toContain(`(${EN['roles.list.leaving']})`);
  });

  /* RED WHEN: who holds what is shown for a company the wallet has not opened, or the page does not say it could not be read, or offers a change. */
  it('says who holds each role cannot be read, and offers no change, until the wallet opens the company', async () => {
    st.roles = { of: 'refused', why: 'no-keys-here' };
    st.readers = { of: 'refused', why: 'no-keys-here' };
    await draw();
    expect(q('[data-roles-unread]')!.textContent).toBe(EN['roles.list.unread']);
    expect(all('[data-holders]')).toEqual([]);
    expect(q('[data-change-role]')).toBeNull();
    expect(all('[data-role-row]')).toHaveLength(ROLES.length);
  });
});

describe('changing a signer\'s role', () => {
  /* RED WHEN: the change asks for another seat, role or address than the ones chosen, or leaves out the roster's name or the seat's current role. */
  it('asks for the seat, the new role and the typed address, with the seat\'s name and current role', async () => {
    await draw();
    await choose(3, 'approver');
    await press('[data-action="change-role"]');
    expect(st.changes).toHaveLength(1);
    expect(st.changes[0]!.slice(0, 3)).toEqual(['u1', 'c-1', { leaf: leaf(3), current: 'initiator', role: 'approver', address: PRIVATE, name: 'Name 3' }]);
  });

  /* RED WHEN: a seat that is being removed is offered for a change, or only signer roles are not the roles offered. */
  it('offers the seats that stay and the three signer roles, never a reader role', async () => {
    st.roles = readOf([seatOf(1, { role: 'admin' }), seatOf(2, { leaving: true })]);
    await draw();
    expect(all('[data-field="seat"] [data-seat]').map((s) => s.dataset['seat'])).toEqual([leaf(1)]);
    expect(all('[data-field="role"] [data-role]').map((r) => r.dataset['role'])).toEqual([...SIGNER_ROLES]);
  });

  /* RED WHEN: the page says a role change makes nothing public, or leaves out the approvals each step needs, or the number is not the seat bar. */
  it('says a seat leaving and a seat joining are public, and how many approvals each step needs', async () => {
    st.roles = readOf(SEATS, { ...HOLDERS, approvals: 3, seatBar: 3 });
    await draw();
    expect(q('[data-change-public]')!.textContent).toBe(EN['roles.change.public']);
    expect(EN['roles.change.public']).toMatch(/seat leaving and a seat joining are public/u);
    expect(q('[data-change-says]')!.textContent).toContain(words('roles.change.needs', { needed: 3 }));
    expect(q('[data-change-says]')!.textContent).toContain(EN['roles.change.forgets']!);
  });

  /* RED WHEN: the page offers to drop a seat from the roles page, or any act other than a change of role, its continuation and dropping a change begun. */
  it('offers no way to drop a seat, only to drop a change begun', async () => {
    st.begun = [{ leaf: leaf(3), name: 'Name 3', role: 'approver', address: PRIVATE }];
    await draw();
    expect(all('[data-action]').map((a) => a.dataset['action']).sort()).toEqual(['change-role', 'continue-role', 'drop-role-change']);
    expect(text()).not.toMatch(/\b(remove this seat|delete|drop (this|a) seat)\b/iu);
  });

  /* RED WHEN: the words after the first step do not name the person, the new role and the approvals, or a finished invitation is told as the first step. */
  it('says where the first step stands and what the second does', async () => {
    await draw();
    await choose(3, 'approver');
    await press('[data-action="change-role"]');
    expect(q('[data-change-done="remove"]')!.textContent).toBe(words('roles.change.done.remove', { name: 'Name 3', role: EN['invite.role.approver']!, approvals: 1, needed: 2 }));
    st.changed = { of: 'done', stage: 'invite', state: 'waiting-for-approvals', approvals: 0, needed: 2 };
    await press('[data-action="change-role"]');
    expect(q('[data-change-done="invite"]')!.textContent).toBe(words('roles.change.done.invite', { name: 'Name 3', role: EN['invite.role.approver']! }));
    st.changed = { of: 'done', stage: 'remove', state: null, approvals: null, needed: null };
    await press('[data-action="change-role"]');
    expect(q('[data-change-done="remove"]')!.textContent).toBe(words('roles.change.done.remove.unknown', { name: 'Name 3', role: EN['invite.role.approver']! }));
  });

  /* RED WHEN: a problem the page found is shown as a different one, or as a wallet's stop. */
  it('says what the page found wrong before it asked', async () => {
    await draw();
    for (const [problem, key] of [['no-seat', 'roles.change.problem.no-seat'], ['no-name', 'roles.change.problem.no-name'], ['bad-address', 'roles.change.problem.bad-address'],
      ['no-role', 'roles.change.problem.no-role'], ['same-role', 'roles.change.problem.same-role']] as const) {
      st.changed = { of: 'problem', problem };
      await press('[data-action="change-role"]');
      expect(q(`[data-change-problem="${problem}"]`)!.textContent).toBe(EN[key]);
    }
  });

  /* RED WHEN: a wallet's stop is shown as another reason, or a stop that may have part gone through is not told so. */
  it('says why the wallet stopped, and when part of it may have gone through', async () => {
    await draw();
    const WHYS = ['seat', 'removal-under-way', 'fewer-approvals-first', 'not-as-started', 'not-started-here', 'not-an-address', 'not-as-asked', 'stopped', 'other'];
    for (const why of WHYS) {
      st.changed = { of: 'stopped', why, partial: false, handedOver: false };
      await press('[data-action="change-role"]');
      expect(q(`[data-change-stopped="${why}"]`)!.textContent).toBe(EN[`roles.change.why.${why}`]);
      expect(q('[data-partial]')).toBeNull();
    }
    st.changed = { of: 'stopped', why: 'other', partial: true, handedOver: true };
    await press('[data-action="change-role"]');
    expect(q('[data-partial]')!.textContent).toBe(EN['roles.change.partial']);
    st.changed = { of: 'stopped', why: 'stopped', partial: false, handedOver: true };
    await press('[data-action="change-role"]');
    expect(q('[data-change-stopped]')!.textContent).toBe(EN['roles.change.sent']);
  });
});

describe('asking the wallet', () => {
  /* RED WHEN: a second ask is made while the first is still with the wallet, or the form can still be changed while it is. */
  it('asks once at a time, and locks the form while the wallet has it', async () => {
    let release: (v: unknown) => void = () => {};
    st.hold = new Promise((r) => { release = r; });
    await draw();
    await choose(3, 'approver');
    await press('[data-action="change-role"]');
    await press('[data-action="change-role"]');
    expect(st.changes).toHaveLength(1);
    expect(q('[data-action="change-role"]')!.hasAttribute('disabled')).toBe(true);
    expect(q('[data-field="address"]')!.hasAttribute('disabled')).toBe(true);
    await act(async () => { release(st.changed); await turn(); });
    expect(q('[data-action="change-role"]')!.hasAttribute('disabled')).toBe(false);
  });

  /* RED WHEN: the seats are not read again after a step that changed them, or after a stop that may have, or they are read again after a refusal that sent nothing. */
  it('reads the seats again after a change or a stop that may have changed them, and not after a refusal', async () => {
    await draw();
    await choose(3, 'approver');
    const before = st.reads;
    st.changed = { of: 'stopped', why: 'seat', partial: false, handedOver: false };
    await press('[data-action="change-role"]');
    expect(st.reads).toBe(before);
    st.changed = { of: 'stopped', why: 'other', partial: true, handedOver: false };
    await press('[data-action="change-role"]');
    expect(st.reads).toBe(before + 1);
    st.changed = { of: 'stopped', why: 'stopped', partial: false, handedOver: true };
    await press('[data-action="change-role"]');
    expect(st.reads).toBe(before + 2);
    st.changed = { of: 'done', stage: 'remove', state: null, approvals: null, needed: null };
    await press('[data-action="change-role"]');
    expect(st.reads).toBe(before + 3);
  });
});

describe('a change begun on this visit', () => {
  /* RED WHEN: a change begun cannot be continued from the page, or the continue names another seat. */
  it('lists a begun change and continues it by its seat', async () => {
    st.begun = [{ leaf: leaf(3), name: 'Name 3', role: 'approver', address: PRIVATE }];
    st.continued = { of: 'done', stage: 'invite', state: null, approvals: null, needed: null };
    await draw();
    expect(q('[data-begun]')!.textContent).toContain(words('roles.continue.says', { name: 'Name 3', role: EN['invite.role.approver']! }));
    await press('[data-action="continue-role"]');
    expect(st.continues[0]!.slice(0, 3)).toEqual(['u1', 'c-1', leaf(3)]);
    expect(q('[data-change-done="invite"]')).not.toBeNull();
  });

  /* RED WHEN: a change begun cannot be dropped by its seat, a drop is told in the words of a change sent, or the page reads the seats again after a stop that sent nothing. */
  it('drops a begun change by its seat, says what dropping does, and reads again only once it is dropped', async () => {
    st.begun = [{ leaf: leaf(3), name: 'Name 3', role: 'approver', address: PRIVATE }];
    st.dropped = { of: 'dropped', state: 'dropped' };
    await draw();
    expect(q('[data-drop-says]')!.textContent).toBe(EN['roles.drop.says']);
    const reads = st.reads;
    await press('[data-action="drop-role-change"]');
    expect(st.drops[0]!.slice(0, 3)).toEqual(['u1', 'c-1', leaf(3)]);
    expect(q('[data-change-dropped="dropped"]')!.textContent).toBe(words('roles.drop.done.dropped', { name: 'Name 3' }));
    expect(st.reads).toBeGreaterThan(reads);
    cleanup();
    st.dropped = { of: 'dropped', state: 'not-kept' };
    await draw();
    await press('[data-action="drop-role-change"]');
    expect(q('[data-change-dropped="not-kept"]')!.textContent).toBe(words('roles.drop.done.not-kept', { name: 'Name 3' }));
    cleanup();
    st.dropped = { of: 'stopped', why: 'other', partial: false, handedOver: false };
    await draw();
    const before = st.reads;
    await press('[data-action="drop-role-change"]');
    expect(q('[data-change-stopped="other"]')!.textContent).toBe(EN['roles.change.why.other']);
    expect(q('[data-partial]')).toBeNull();
    expect(st.reads).toBe(before);
  });

  /* RED WHEN: nothing is said when a seat is being removed that this page did not begin, or it is said of one it did begin. */
  it('says to invite the person with Invite when a seat is leaving that this page cannot continue', async () => {
    st.roles = readOf([seatOf(1, { role: 'admin' }), seatOf(3, { leaving: true })]);
    await draw();
    expect(q('[data-leaving-note]')!.textContent).toBe(EN['roles.leaving.note']);
    expect(EN['roles.leaving.note']).toMatch(/invite the person at the new role with Invite/u);
    cleanup();
    st.begun = [{ leaf: leaf(3), name: 'Name 3', role: 'approver', address: PRIVATE }];
    await draw();
    expect(q('[data-leaving-note]')).toBeNull();
  });
});
