import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import { REGISTRY_STATE, registryWorld } from '../chain/registry-entries.test-support.js';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent, ActIntentName } from 'midnight-identity/profile/request';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { KINDS_IN_THE_WALLET } from '../../../../packages/web-shared/src/proposal-kinds-in-the-wallet.js';
import EN from '../locales/en.json' with { type: 'json' };
import { HEAD_REFUSALS } from './company-reach-head.js';
import { StepRefused, type StepContext } from './definition.js';
import { stepOverItsCall } from './step-views.test-support.js';

/*
 * **A PAGE NAMING ANOTHER ACCOUNT UNDER A LABEL THIS WALLET PINNED IS REFUSED IN EVERY ACTION THAT REACHES A COMPANY**,
 * before anything is read for it, and the refusal has words for every action. The actions that reach no company, or
 * hold or write the pin themselves, are named; every other action in the registry is run here.
 */

/* The person acting. With no pin for the label, the head looks the person's companies up in the network's registries
 * before it refuses: here that lookup reads one registry that holds no entry of this person's, never the live chain. */
const SECRET = new Uint8Array(32).fill(7);
const PERSON = identityFromSecret(SECRET as never);
const lookedUp = vi.hoisted(() => ({ states: [] as string[] }));
vi.mock('../chain/private-registry-on-chain.js', async (real) => {
  const actual = await real<typeof import('../chain/private-registry-on-chain.js')>();
  return {
    ...actual,
    liveRegistryReads: () => {
      const world = registryWorld(PERSON, { registries: { ['e1'.repeat(32)]: { state: REGISTRY_STATE, held: {} } }, accounts: {} });
      lookedUp.states = world.asked.states;
      return world.reads;
    },
  };
});

/* The wallet's settings read the page's address as they load. */
const g = globalThis as { window?: unknown };
const hadAWindow = 'window' in g;
if (!hadAWindow) g.window = { location: { hostname: 'wallet.example', origin: 'https://wallet.example' } };
const { ACTIONS } = await import('./registry.js');
if (!hadAWindow) delete g.window;

/* Actions that reach no company through the head: they move nothing for one, or hold or write the pin themselves. */
const OUTSIDE_THE_HEAD = new Set<string>(['finish-company', 'claim-by-address', 'join-by-code', 'reader-keys', 'drop-role-change']);
/* The seating writes the pin itself and refuses a label pinned to another account before it derives anything. */
const THE_SEATING = 'act.seat-invited';

const LABEL = drawCompanyLabel();
const PINNED = 'c0'.repeat(32);
const NAMED = 'c1'.repeat(32);
const words = EN as Readonly<Record<string, string>>;

/* What an ask names besides the company: enough of each field for the ask's own shape checks to pass. */
const FIELDS = { leaf: 'ab'.repeat(32), address: 'mn_addr_test1', personName: 'Ada', role: 'admin', proposal: 'prp_1', token: 'ab'.repeat(32) };

const ctxFor = (name: string, kind?: string, pinned = true): StepContext => {
  const kept: Keyring = pinned ? { accounts: {}, pins: { [LABEL]: { account: PINNED, from: 'created', at: 'then' } } } : { accounts: {} };
  return stepOverItsCall({
    intent: { name, fields: { ...FIELDS, record: 'acc_1', company: LABEL, account: NAMED, ...(kind === undefined ? {} : { kind }) } } as unknown as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity: PERSON, secret: SECRET as never, account: 0 },
    at: { step: 1, steps: 1 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('nothing is relayed for a refused account'); },
    call: async () => { throw new Error('nothing is asked of the service for a refused account'); },
    tell: () => {}, show: () => {}, confirm: async () => {}, releaseReadKeys: () => {}, sentByTheWallet: () => {}, seenOnTheChain: () => {},
    keyring: { open: () => ({ read: () => structuredClone(kept) }) as never, keep: async () => { throw new Error('nothing is kept for a refused account'); } },
  }) as unknown as StepContext;
};

/** The words the first step that reaches the company stops with. */
const refusedWith = async (name: ActIntentName, kind?: string, pinned = true): Promise<string> => {
  const ctx = ctxFor(name, kind, pinned);
  const steps = ACTIONS[name].steps(ctx.intent);
  if (steps.length === 0) return 'no steps';
  for (const step of steps) {
    try {
      await step.run(ctx);
    } catch (e) {
      if (e instanceof StepRefused) return e.words.key;
      return `threw: ${String((e as Error)?.message ?? e)}`;
    }
  }
  return 'ran';
};

/* Every ask run here: one per action, and one per kind of proposal for the actions that run a proposal by its kind. */
const BY_KIND = new Set<string>(['approve-proposal', 'withdraw-proposal']);
const reaching = (Object.keys(ACTIONS) as ActIntentName[]).filter((name) => !OUTSIDE_THE_HEAD.has(name))
  .flatMap((name): { readonly name: ActIntentName; readonly kind?: string }[] => (BY_KIND.has(name) ? Object.keys(KINDS_IN_THE_WALLET).map((kind) => ({ name, kind })) : [{ name }]));

describe('another account under a pinned label', () => {
  it('is refused in every action that reaches a company, before anything is read, with words for each', async () => {
    const notRefused: string[] = [];
    const unsaid: string[] = [];
    for (const { name, kind } of reaching) {
      const key = await refusedWith(name, kind);
      if (key === 'no steps' && kind !== undefined) continue;
      if (!/^act\.[a-z-]+\.why\.pinned-elsewhere$/u.test(key)) notRefused.push(`${name}${kind === undefined ? '' : ` (${kind})`}: ${key}`);
      else if (typeof words[key] !== 'string') unsaid.push(key);
    }
    /* RED WHEN: an action reaches a company the page names under a label this wallet pinned to another account. */
    expect(notRefused).toEqual([]);
    /* RED WHEN: the refusal has no words in the wallet's language file. */
    expect(unsaid).toEqual([]);
  });

  it('with no pin for the label, is refused in every action that reaches a company, the seating apart', async () => {
    const notRefused: string[] = [];
    for (const { name, kind } of reaching) {
      if (name === 'seat-invited') continue;
      const key = await refusedWith(name, kind, false);
      if (key === 'no steps' && kind !== undefined) continue;
      if (!/^act\.[a-z-]+\.why\.no-pin$/u.test(key)) notRefused.push(`${name}${kind === undefined ? '' : ` (${kind})`}: ${key}`);
    }
    /* RED WHEN: an action acts on a seat whose company this wallet never pinned, through a reach of its own or the head. */
    expect(notRefused).toEqual([]);
    /* RED WHEN: the head refuses for the missing pin without first looking the person's companies up. */
    expect(lookedUp.states.length).toBeGreaterThan(0);
  });

  it('has words for every refusal the head raises, in every action that reaches through it', async () => {
    const prefixes = new Set<string>();
    for (const { name, kind } of reaching) {
      const key = await refusedWith(name, kind);
      if (key !== 'no steps') prefixes.add(key.replace(/\.why\.[a-z-]+$/u, ''));
    }
    prefixes.delete(THE_SEATING);
    const unsaid = [...prefixes].flatMap((prefix) => HEAD_REFUSALS.map((refusal) => `${prefix}.why.${refusal}`)).filter((key) => typeof words[key] !== 'string');
    /* RED WHEN: a refusal the head can raise for an action shows the person a bare key. */
    expect(unsaid).toEqual([]);
  });
});
