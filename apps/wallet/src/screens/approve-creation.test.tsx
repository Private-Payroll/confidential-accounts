// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk, REQUEST_SCHEMA, type CreationRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { CreationLedger } from 'midnight-identity/profile/creation-sign';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import * as account from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import type { BuiltAccountKeys } from '../chain/this-builds-account-keys.js';
import { ApproveCreation } from './approve-creation.js';
import { builtAccountKeys } from '../chain/this-builds-account-keys.js';
import { Approve } from './approve.js';
import { secretFromWords } from 'midnight-identity/keys/derivation';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { emptyProfile, pinnedAccountOf, recordRelease } from 'midnight-identity/profile/model';
import { load, save } from 'midnight-identity/profile/store';
import { CREATION_SIGNATURE_SCHEMA } from 'midnight-identity/profile/creation-sign';
import { watchedStore } from '../testing/settled-store.js';
import { watchedOpener } from '../testing/settled-channel.js';

/*
 * The screen for the second press of creating a company. It reads the unsent
 * deploy the page built, shows the label this wallet drew, the account the
 * deploy creates and that it is held by this person's own key, and answers
 * only after the press, pinning the account first. The deploy here is a real
 * one, built by the device's own builder.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NET = 'undeployed';
const ORIGIN = 'https://payroll.example';
const LABEL = `co_${'5a'.repeat(32)}` as CompanyLabel;
const identity = identityFromWords(TEST_MNEMONIC);
const KEYS = join(import.meta.dirname, '../../../../contracts/managed/keys');
const keyFile = (c: string) => new Uint8Array(readFileSync(join(KEYS, `${c}.verifier`)));
const b64 = (b: Uint8Array) => PolyfillBuffer.from(b).toString('base64');
const fromHex = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));
const expected = (account as unknown as { expectedVk: Record<string, string> }).expectedVk;
const thisBuilds: BuiltAccountKeys = {
  of: 'built',
  keys: {
    first: new Map(CREATION_STEPS.first.map((c) => [c, fromHex(expected[c]!)] as [string, Uint8Array])),
    second: new Map(CREATION_STEPS.second.map((c) => [c, fromHex(expected[c]!)] as [string, Uint8Array])),
  },
};
const ledger = async () => L as unknown as CreationLedger;

let deploy: { proven: Uint8Array; address: string };
/*
 * The deploy here is built from this build's account keys, which only a full compile of the account produces. Read
 * through the wallet's own build step, which makes this build's digests from those files or says they are missing.
 */
const ON_DISK = builtAccountKeys().of === 'built';

beforeAll(async () => {
  if (!ON_DISK) return;
  setNetworkId(NET as never);
  /*
   * The device's own builder, loaded by a path this app's typecheck does not
   * follow: it reaches the service's modules, which are checked under their own
   * settings and not this app's.
   */
  const builder = '../../../../packages/web-shared/src/vault-builder.js';
  const { buildAccountDeploy } = (await import(/* @vite-ignore */ builder)) as {
    buildAccountDeploy: (deps: unknown, input: unknown) => Promise<{ proven: Uint8Array; address: string }>;
  };
  const built = await buildAccountDeploy({
    ledger: L, runtimeState: (runtime as any).ContractState, contracts: contracts as any, network: NET,
    accountCompiled: CompiledContract.make('ConfidentialAccount', (account as any).Contract).pipe(
      CompiledContract.withWitnesses(witnesses as never)),
    /* The key files read here rather than through the node provider, whose reads fail under this test's DOM. */
    accountKeys: {
      getVerifierKey: async (c: string) => keyFile(c),
      getVerifierKeys: async (cs: readonly string[]) => cs.map((c) => [c, keyFile(c)] as [string, Uint8Array]),
    },
    prove: async (tx: any) => tx.prove({
      check: async () => { throw new Error('asked to check'); }, prove: async () => { throw new Error('asked to prove'); }, lookupKey: async () => undefined,
    } as never, L.CostModel.initialCostModel()),
  } as never, { foundingLeaf: '7c'.repeat(32), label: LABEL, foundingKey: committeeKeyFor(identity, LABEL) });
  deploy = { proven: built.proven, address: built.address };
}, 120_000);

const askOf = (over: Record<string, unknown> = {}) => parseAsk({
  schema: REQUEST_SCHEMA, kind: 'creation', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To finish creating your company.', nonce: 'n-1', expiresAt: Date.now() + 600_000,
  company: LABEL, account: deploy.address, deploy: b64(deploy.proven),
  insert: CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(keyFile(c)) })), ...over,
}, ORIGIN, Date.now()) as CreationRequest;
const channelFor = (log: unknown[], answered = true): Channel => ({
  answer: (a) => { log.push(['answer', a]); return answered; }, refuse: (r) => { log.push(['refused', r]); }, stop: () => {},
} as Channel);
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); }); };
type Over = {
  drewTheLabel?: boolean; built?: () => BuiltAccountKeys; ledger?: () => Promise<CreationLedger>; request?: CreationRequest;
  onPin?: (a: AccountAddress, at: number) => Promise<void>; answered?: boolean;
};
const draw = async (log: unknown[], over: Over = {}) => {
  const r = render(
    <ApproveCreation request={over.request ?? askOf()} identity={identity} channel={channelFor(log, over.answered ?? true)} consent={{ ok: true } as never}
      whoIsAsking={<p>asker</p>} onDecline={() => log.push(['declined'])}
      onPin={over.onPin ?? (async (a, at) => { log.push(['pin', a, at]); })}
      drewTheLabel={over.drewTheLabel ?? true} ledger={over.ledger ?? ledger} built={over.built ?? (() => thisBuilds)} />);
  await settle();
  return r;
};
const button = (c: HTMLElement) => c.querySelector('[data-sign-creation]') as HTMLButtonElement;

afterEach(() => { cleanup(); });

describe.skipIf(!ON_DISK)('THE SCREEN FOR FINISHING A COMPANY\'S ACCOUNT [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  it('SHOWS THE LABEL, THE ACCOUNT IT READ FROM THE DEPLOY AND WHO HOLDS IT, AND ANSWERS ONLY AFTER THE PRESS, PINNING FIRST', async () => {
    const log: unknown[] = [];
    const { container } = await draw(log);
    /* RED WHEN: the screen shows anything but what this wallet read from the deploy, or answers before the press. */
    expect(container.querySelector('[data-label]')?.textContent).toBe(LABEL);
    expect(container.querySelector('[data-account]')?.textContent).toBe(deploy.address);
    expect(container.querySelector('[data-fingerprint]')?.textContent).toBe(companyFingerprint(LABEL, deploy.address as AccountAddress));
    expect(container.querySelector('[data-held-by-you]')).not.toBeNull();
    expect(container.querySelector('[data-circuits]')?.textContent)
      .toContain(`runs ${CREATION_STEPS.first.length} of this build's circuits. This step adds the other ${CREATION_STEPS.second.length}`);
    expect(log).toEqual([]);
    await act(async () => { fireEvent.click(button(container)); });
    /* RED WHEN: the account is not pinned, or is pinned only after the answer has gone. */
    expect(log.map((e) => (e as unknown[])[0])).toEqual(['pin', 'answer']);
    expect((log[0] as unknown[])[1]).toBe(deploy.address);
    expect(((log[1] as unknown[])[1] as { account: string }).account).toBe(deploy.address);
    expect(container.querySelector('[data-pinned-account]')?.textContent).toBe(deploy.address);
  });

  it('STAYS SIGNED WHEN THE PIN TURNS THE LABEL INTO ONE THIS WALLET HAS FINISHED, AS THE WALLET THAT HOSTS IT DOES', async () => {
    const log: unknown[] = [];
    const request = askOf();
    const channel = channelFor(log);
    const built = () => thisBuilds;
    /* The host, as the wallet's approve screen is: pinning makes the label one this wallet has finished, here once the signature has gone. */
    function Host() {
      const [drew, setDrew] = useState(true);
      return (
        <ApproveCreation request={request} identity={identity} channel={channel} consent={{ ok: true } as never}
          whoIsAsking={<p>asker</p>} onDecline={() => {}} onPin={async (a, at) => { log.push(['pin', a, at]); setTimeout(() => setDrew(false), 0); }}
          drewTheLabel={drew} ledger={ledger} built={built} />
      );
    }
    const { container } = render(<Host />);
    await settle();
    await act(async () => { fireEvent.click(button(container)); });
    await settle();
    /* RED WHEN: the screen reads whether this wallet drew the label again after the pin, and tells the person who just signed that nothing was signed. */
    expect(container.querySelector('[data-creation-refused]')).toBeNull();
    expect(container.querySelector('[data-pinned-account]')?.textContent).toBe(deploy.address);
  });

  it('SIGNS NOTHING WHEN THE ACCOUNT COULD NOT BE KEPT, AND SAYS A SIGNATURE THE PAGE NEVER TOOK DID NOT REACH IT', async () => {
    const log: unknown[] = [];
    const { container } = await draw(log, { onPin: async () => { throw new Error('This wallet could not keep the company\'s account, so nothing has been signed. Try again.'); } });
    await act(async () => { fireEvent.click(button(container)); });
    /* RED WHEN: the signature is handed back before the account it is for is kept. */
    expect(log).toEqual([]);
    expect(container.querySelector('[data-creation-refused]')?.textContent).toContain('could not keep the company\'s account');
    const closed: unknown[] = [];
    const late = await draw(closed, { answered: false });
    await act(async () => { fireEvent.click(button(late.container)); });
    /* RED WHEN: a signature the page had stopped waiting for is reported as handed back. */
    expect(late.container.querySelector('[data-signed-heading]')).toBeNull();
    expect(late.container.querySelector('[data-creation-refused]')?.textContent).toContain('did not reach it');
  });

  it.each([
    ['a label this wallet did not draw', { drewTheLabel: false }, 'did not make up this company\'s label'],
    ['a wallet built without the account\'s keys', { built: (): BuiltAccountKeys => ({ of: 'missing', why: 'no keys here' }) }, 'no keys here'],
    ['a ledger that would not load', { ledger: () => Promise.reject(new Error('no')) }, 'could not load what it needs to read the deploy'],
  ])('SIGNS NOTHING FOR %s, AND SAYS SO', async (_what, over, says) => {
    const log: unknown[] = [];
    const { container } = await draw(log, over as never);
    /* RED WHEN: the screen offers the press, or answers, when it could not check what it would sign. */
    expect(container.querySelector('[data-creation-refused]')?.textContent).toContain(says);
    expect(button(container).disabled).toBe(true);
    await act(async () => { fireEvent.click(button(container)); });
    expect(log).toEqual([]);
  });

  it('SIGNS NOTHING WHEN THE PAGE NAMES ANOTHER ACCOUNT THAN THE DEPLOY CREATES', async () => {
    const log: unknown[] = [];
    const { container } = await draw(log, { request: askOf({ account: 'c1'.repeat(32) }) });
    /* RED WHEN: the account is taken from the page rather than worked out from the deploy. */
    expect(container.querySelector('[data-creation-refused]')).not.toBeNull();
    expect(button(container).disabled).toBe(true);
    expect(log).toEqual([]);
  });
});

describe.skipIf(!ON_DISK)('THE APPROVAL SURFACE ROUTES A CREATION TO THIS SCREEN, AND READS WHETHER THIS WALLET DREW THE LABEL FROM ITS OWN RECORD [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  const surface = async (drawn: boolean) => {
    const port = watchedStore();
    const at = Date.now();
    const profile = drawn
      ? recordRelease(emptyProfile(at), {
        at, nonce: 'k-1', recipient: { origin: ORIGIN, name: 'Payroll', rdns: 'example.payroll' }, company: LABEL, account: null,
      } as never, at)
      : emptyProfile(at);
    await save(port, identity, profile);
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    const r = render(<Approve identity={identity} secret={secretFromWords(TEST_MNEMONIC)} port={port} view={view} readLabel={async () => ({ of: 'no-account' })} />);
    await settle();
    const wire = {
      schema: REQUEST_SCHEMA, kind: 'creation', requester: { name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'To finish creating your company.', nonce: 'n-2', expiresAt: Date.now() + 600_000,
      company: LABEL, account: deploy.address, deploy: b64(deploy.proven),
      insert: CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(keyFile(c)) })),
    };
    await act(async () => { for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire } as unknown as MessageEvent); });
    await settle();
    return { ...r, port, opener };
  };

  it('A LABEL THIS WALLET DREW IS SIGNED FOR, AND ITS ACCOUNT IS KEPT IN THE WALLET\'S RECORD BEFORE THE SIGNATURE GOES', async () => {
    const { container, port, opener } = await surface(true);
    expect(button(container).disabled).toBe(false);
    await act(async () => { fireEvent.click(button(container)); });
    await settle();
    /* RED WHEN: the account is not written into the wallet's own record, or the signature does not go back. */
    const kept = await load(port, identity);
    if (kept.of !== 'profile') throw new Error(`the wallet's record did not open: ${kept.of}`);
    expect(pinnedAccountOf(kept.profile, LABEL)).toBe(deploy.address);
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === CREATION_SIGNATURE_SCHEMA)).toHaveLength(1);
  });

  it('A LABEL THIS WALLET NEVER DREW IS NOT SIGNED FOR', async () => {
    const { container, opener } = await surface(false);
    /* RED WHEN: the surface decides the label was drawn from anything but this wallet's own record of releases. */
    expect(container.querySelector('[data-creation-refused]')?.textContent).toContain('did not make up this company\'s label');
    expect(button(container).disabled).toBe(true);
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === CREATION_SIGNATURE_SCHEMA)).toEqual([]);
  });
});
