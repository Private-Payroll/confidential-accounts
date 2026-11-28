// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import * as L from '@midnightntwrk/ledger-v9';
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import type { Channel, ChannelWindow } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { type AccountAddress, companyLabelOf, readAccountAddress } from 'midnight-identity/profile/company-label';
import {
  CREATION_SIGNATURE_SCHEMA,
  type CreationLedger,
  type ThisBuildsAccountKeys
} from 'midnight-identity/profile/creation-sign';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { emptyProfile, recordRelease } from 'midnight-identity/profile/model';
import { type CreationRequest, parseAsk, REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import { load, save } from 'midnight-identity/profile/store';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import * as account from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { ACCOUNT_KEYS, keysOnDisk } from '../../../../contracts/test/keys-on-disk.js';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { liveConstruction, startingStateRefusal } from '../chain/account-as-constructed.js';
import type { BuiltAccountKeys } from '../chain/this-builds-account-keys.js';
import { act, cleanup, fireEvent, render, waitFor } from '../testing/render.js';
import { watchedOpener } from '../testing/settled-channel.js';
import { watchedStore } from '../testing/settled-store.js';
import { Approve } from './approve.js';
import { ApproveCreation, liveCreationLedger } from './approve-creation.js';

/* The screen for the second press of creating a company, shown a real deploy built by the device's own builder: it
 * shows the label, the account and who holds it, and answers only after the press, pinning the account first. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NET = 'undeployed';
const ORIGIN = 'https://payroll.example';
const LABEL = companyLabelOf(new Uint8Array(32).fill(0x5a));
const identity = identityFromWords(TEST_MNEMONIC);
const KEYS = join(import.meta.dirname, '../../../../contracts/managed/keys');
const keyFile = (c: string) => new Uint8Array(readFileSync(join(KEYS, `${c}.verifier`)));
const b64 = (b: Uint8Array) => PolyfillBuffer.from(b).toString('base64');
const fromHex = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
/* Read only inside a test that runs, never when this file is loaded: a compile without keys carries no digests. */
const builtKeys = (): ThisBuildsAccountKeys => {
  const digest = (c: string): [string, Uint8Array] => {
    const hex = account.expectedVk[c];
    if (hex === undefined) throw new Error(`this build carries no key digest for ${c}`);
    return [c, fromHex(hex)];
  };
  return { first: new Map(CREATION_STEPS.first.map(digest)), second: new Map(CREATION_STEPS.second.map(digest)) };
};
const thisBuilds = (): BuiltAccountKeys => ({ of: 'built', keys: builtKeys() });
/* A deploy needs no proof, so a request to check or prove anything is a failure. */
const refusingProver: L.ProvingProvider = {
  check: async () => {
    throw new Error('asked to check');
  },
  prove: async () => {
    throw new Error('asked to prove');
  },
  lookupKey: async () => undefined
};
/** The named function a module exports, the module loaded by a path this app's typecheck does not follow. */
const exported = async (path: string, name: string): Promise<(...args: unknown[]) => unknown> => {
  const loaded: unknown = await import(/* @vite-ignore */ path);
  const found: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, name) : undefined;
  if (typeof found !== 'function') throw new Error(`${path} exports no function ${name}`);
  return (...args) => Reflect.apply(found, undefined, args);
};

let deploy: { proven: Uint8Array; address: AccountAddress };
/* The deploy here is built from this build's account keys, which only a full compile of the account produces. */
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

beforeAll(async () => {
  if (!ON_DISK) return;
  /* The device's own builder and the calls the product hands it are the service's modules, checked under their own
   * settings and not this app's, so they are loaded by paths this app's typecheck does not follow. */
  const callsTheProductBuilds = await exported(
    '../../../../contracts/test/the-calls-the-product-builds.js',
    'callsTheProductBuilds'
  );
  const buildAccountDeploy = await exported(
    '../../../../packages/web-shared/src/vault-builder.js',
    'buildAccountDeploy'
  );
  /* Which compiler built the keys is read through the node provider: it reads one small file, which works under a DOM. */
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const built = new NodeZkConfigProvider(join(KEYS, '..'));
  const made = await buildAccountDeploy(
    {
      ledger: L,
      runtimeState: runtime.ContractState,
      contracts: callsTheProductBuilds(),
      network: NET,
      accountCompiled: CompiledContract.make('ConfidentialAccount', account.Contract).pipe(
        CompiledContract.withWitnesses(witnesses)
      ),
      /* The key files read here rather than through the node provider, whose reads fail under this test's DOM. */
      accountKeys: {
        getVerifierKey: async (c: string) => keyFile(c),
        getVerifierKeys: async (cs: readonly string[]) => cs.map((c): [string, Uint8Array] => [c, keyFile(c)]),
        getArtifactRuntimeVersion: () => built.getArtifactRuntimeVersion()
      },
      prove: async (tx: L.UnprovenTransaction) => tx.prove(refusingProver, L.CostModel.initialCostModel())
    },
    { foundingLeaf: '7c'.repeat(32), label: LABEL, foundingKey: committeeKeyFor(identity, LABEL) }
  );
  const proven = typeof made === 'object' && made !== null && 'proven' in made ? made.proven : undefined;
  const address =
    typeof made === 'object' && made !== null && 'address' in made ? readAccountAddress(made.address) : null;
  if (!(proven instanceof Uint8Array) || address === null) throw new Error('the builder made no deploy');
  deploy = { proven, address };
}, 120_000);

const askOf = (over: Record<string, unknown> = {}): CreationRequest => {
  const ask = parseAsk(
    {
      schema: REQUEST_SCHEMA,
      kind: 'creation',
      requester: { name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'To finish creating your company.',
      nonce: 'n-1',
      expiresAt: Date.now() + 600_000,
      company: LABEL,
      account: deploy.address,
      deploy: b64(deploy.proven),
      insert: CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(keyFile(c)) })),
      ...over
    },
    ORIGIN,
    Date.now()
  );
  if (ask.kind !== 'creation') throw new Error(`asked to finish a company, the ask read as ${ask.kind}`);
  return ask;
};
type Logged = readonly [string, ...unknown[]];
const channelFor = (log: Logged[], answered = true): Channel => {
  let ended = false;
  return {
    answer: (a) => {
      log.push(['answer', a]);
      ended = answered;
      return answered;
    },
    refuse: (r: unknown) => {
      log.push(['refused', r]);
      ended = true;
      return true;
    },
    progress: () => !ended,
    over: () => ended,
    stop: () => undefined
  };
};
/* The screen has read the deploy once it no longer says it is reading, whether it then offers the press or refuses. */
const finishedReading = async (c: HTMLElement) => {
  await waitFor(() => expect(c.querySelector('[data-reading]')).toBeNull());
};
type Over = {
  drewTheLabel?: boolean;
  built?: () => BuiltAccountKeys;
  ledger?: () => Promise<CreationLedger>;
  request?: CreationRequest;
  onPin?: (a: AccountAddress, at: number) => Promise<void>;
  answered?: boolean;
};
const draw = async (log: Logged[], over: Over = {}) => {
  const r = render(
    <ApproveCreation
      request={over.request ?? askOf()}
      identity={identity}
      channel={channelFor(log, over.answered ?? true)}
      consent={{ ok: true }}
      whoIsAsking={<p>asker</p>}
      onDecline={() => log.push(['declined'])}
      onPin={
        over.onPin ??
        (async (a, at) => {
          log.push(['pin', a, at]);
        })
      }
      drewTheLabel={over.drewTheLabel ?? true}
      ledger={over.ledger ?? liveCreationLedger}
      built={over.built ?? thisBuilds}
    />
  );
  await finishedReading(r.container);
  return r;
};
const button = (c: HTMLElement): HTMLButtonElement => {
  const found = c.querySelector('[data-sign-creation]');
  if (!(found instanceof HTMLButtonElement)) throw new Error('the screen shows no press to sign');
  return found;
};

afterEach(() => {
  cleanup();
});

describe.skipIf(!ON_DISK)(
  "THE SCREEN FOR FINISHING A COMPANY'S ACCOUNT [needs contracts/managed/keys; `npm run compact` builds them]",
  () => {
    it('SHOWS THE LABEL, THE ACCOUNT IT READ FROM THE DEPLOY AND WHO HOLDS IT, AND ANSWERS ONLY AFTER THE PRESS, PINNING FIRST', async () => {
      const log: Logged[] = [];
      const { container } = await draw(log);
      /* RED WHEN: the screen shows anything but what this wallet read from the deploy, or answers before the press. */
      expect(container.querySelector('[data-label]')?.textContent).toBe(LABEL);
      expect(container.querySelector('[data-account]')?.textContent).toBe(deploy.address);
      expect(container.querySelector('[data-fingerprint]')?.textContent).toBe(
        companyFingerprint(LABEL, deploy.address)
      );
      expect(container.querySelector('[data-held-by-you]')).not.toBeNull();
      expect(container.querySelector('[data-circuits]')?.textContent).toContain(
        `runs ${CREATION_STEPS.first.length} of this build's circuits. This step adds the other ${CREATION_STEPS.second.length}`
      );
      expect(log).toEqual([]);
      await act(async () => {
        fireEvent.click(button(container));
      });
      /* RED WHEN: the account is not pinned, or is pinned only after the answer has gone. */
      expect(log.map((e) => e[0])).toEqual(['pin', 'answer']);
      expect(log[0]?.[1]).toBe(deploy.address);
      expect(log[1]?.[1]).toMatchObject({ account: deploy.address });
      expect(container.querySelector('[data-pinned-account]')?.textContent).toBe(deploy.address);
    });

    it('STAYS SIGNED WHEN THE PIN TURNS THE LABEL INTO ONE THIS WALLET HAS FINISHED, AS THE WALLET THAT HOSTS IT DOES', async () => {
      const log: Logged[] = [];
      const request = askOf();
      const channel = channelFor(log);
      const built = thisBuilds;
      let finishTheLabel = (): void => undefined;
      const labelFinished = new Promise<void>((resolve) => {
        finishTheLabel = resolve;
      });
      /* The host, as the wallet's approve screen is: pinning makes the label one this wallet has finished, here once the signature has gone. */
      function Host() {
        const [drew, setDrew] = useState(true);
        return (
          <ApproveCreation
            request={request}
            identity={identity}
            channel={channel}
            consent={{ ok: true }}
            whoIsAsking={<p>asker</p>}
            onDecline={() => undefined}
            onPin={async (a, at) => {
              log.push(['pin', a, at]);
              setTimeout(() => {
                setDrew(false);
                finishTheLabel();
              }, 0);
            }}
            drewTheLabel={drew}
            ledger={liveCreationLedger}
            built={built}
          />
        );
      }
      const { container } = render(<Host />);
      await finishedReading(container);
      await act(async () => {
        fireEvent.click(button(container));
      });
      await act(async () => {
        await labelFinished;
      });
      /* RED WHEN: the screen reads whether this wallet drew the label again after the pin, and tells the person who just signed that nothing was signed. */
      expect(container.querySelector('[data-creation-refused]')).toBeNull();
      expect(container.querySelector('[data-pinned-account]')?.textContent).toBe(deploy.address);
    });

    it('SIGNS NOTHING WHEN THE ACCOUNT COULD NOT BE KEPT, AND SAYS A SIGNATURE THE PAGE NEVER TOOK DID NOT REACH IT', async () => {
      const log: Logged[] = [];
      const { container } = await draw(log, {
        onPin: async () => {
          throw new Error("This wallet could not keep the company's account, so nothing has been signed. Try again.");
        }
      });
      await act(async () => {
        fireEvent.click(button(container));
      });
      /* RED WHEN: the signature is handed back before the account it is for is kept. */
      expect(log).toEqual([]);
      expect(container.querySelector('[data-creation-refused]')?.textContent).toContain(
        "could not keep the company's account"
      );
      const closed: Logged[] = [];
      const late = await draw(closed, { answered: false });
      await act(async () => {
        fireEvent.click(button(late.container));
      });
      /* RED WHEN: a signature the page had stopped waiting for is reported as handed back. */
      expect(late.container.querySelector('[data-signed-heading]')).toBeNull();
      expect(late.container.querySelector('[data-creation-refused]')?.textContent).toContain('did not reach it');
    });

    const unreadable: [string, Over, string][] = [
      ['a label this wallet did not draw', { drewTheLabel: false }, "did not make up this company's label"],
      [
        "a wallet built without the account's keys",
        { built: () => ({ of: 'missing', why: 'no keys here' }) },
        'no keys here'
      ],
      [
        'a ledger that would not load',
        { ledger: () => Promise.reject(new Error('no')) },
        'could not load what it needs to read the deploy'
      ]
    ];
    it.each(unreadable)('SIGNS NOTHING FOR %s, AND SAYS SO', async (_what, over, says) => {
      const log: Logged[] = [];
      const { container } = await draw(log, over);
      /* RED WHEN: the screen offers the press, or answers, when it could not check what it would sign. */
      expect(container.querySelector('[data-creation-refused]')?.textContent).toContain(says);
      expect(button(container).disabled).toBe(true);
      await act(async () => {
        fireEvent.click(button(container));
      });
      expect(log).toEqual([]);
    });

    it('SIGNS NOTHING FOR A DEPLOY WHOSE STARTING STATE IS NOT THE ONE ITS CONSTRUCTOR MAKES, WHATEVER ELSE IT GETS RIGHT', async () => {
      /* The same account, held by the same key, with the same label, seat and circuits, and one cell more than its constructor makes. */
      const tx = L.Transaction.deserialize<L.SignatureEnabled, L.Proof, L.PreBinding>(
        'signature',
        'proof',
        'pre-binding',
        deploy.proven
      );
      const action = [...(tx.intents?.values() ?? [])][0]?.actions[0];
      if (!(action instanceof L.ContractDeploy)) throw new Error('the deploy holds no contract deploy');
      const read = runtime.ContractState.deserialize(action.initialState.serialize());
      let grown = runtime.StateValue.newArray();
      for (const cell of read.data.state.asArray() ?? []) grown = grown.arrayPush(cell);
      read.data = new runtime.ChargedState(grown.arrayPush(runtime.StateValue.newNull()));
      const other = new L.ContractDeploy(L.ContractState.deserialize(read.serialize()));
      const unproven = L.Transaction.fromParts(
        NET,
        undefined,
        undefined,
        L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(other)
      );
      const bytes = (await unproven.prove(refusingProver, L.CostModel.initialCostModel())).serialize();
      const log: Logged[] = [];
      const { container } = await draw(log, { request: askOf({ account: other.address, deploy: b64(bytes) }) });
      /* RED WHEN: the screen keeps an account as the company's without comparing its whole starting state with the constructor's. */
      expect(container.querySelector('[data-creation-refused]')?.textContent).toContain(
        'does not start as its own constructor makes it'
      );
      expect(button(container).disabled).toBe(true);
      await act(async () => {
        fireEvent.click(button(container));
      });
      expect(log).toEqual([]);
    });

    it("RUNS THE CONSTRUCTOR ONLY WITH KEYS IT HAS CHECKED ARE THIS BUILD'S, AND COMPARES WHAT IT MAKES WITH THE DEPLOY", async () => {
      const request = askOf();
      const deps = await liveConstruction();
      const input = (insert: CreationRequest['insert']) => ({
        deploy: request.deploy,
        label: LABEL,
        foundingKey: committeeKeyFor(identity, LABEL),
        insert,
        build: builtKeys(),
        digest: sha256
      });
      /* The control: this build's deploy and keys start exactly as the constructor makes the account. */
      expect(await startingStateRefusal(deps, input(request.insert))).toBeNull();
      /* RED WHEN: a key the second step adds is taken as sent rather than compared with this build's before anything runs. */
      const swapped = request.insert.map((k, i) => (i === 0 ? { circuit: k.circuit, key: request.insert[1]!.key } : k));
      expect(await startingStateRefusal(deps, input(swapped))).toMatch(
        /second step's key for ".+" is not this build's/u
      );
      /* RED WHEN: the state is compared with one the constructor made for anyone but this person. */
      expect(
        await startingStateRefusal(deps, {
          ...input(request.insert),
          foundingKey: committeeKeyFor(identity, companyLabelOf(new Uint8Array(32).fill(0x6b)))
        })
      ).toContain('does not start as its own constructor makes it');
    });

    it('SIGNS NOTHING WHEN THE PAGE NAMES ANOTHER ACCOUNT THAN THE DEPLOY CREATES', async () => {
      const log: Logged[] = [];
      const { container } = await draw(log, { request: askOf({ account: 'c1'.repeat(32) }) });
      /* RED WHEN: the account is taken from the page rather than worked out from the deploy. */
      expect(container.querySelector('[data-creation-refused]')).not.toBeNull();
      expect(button(container).disabled).toBe(true);
      expect(log).toEqual([]);
    });
  }
);

describe.skipIf(!ON_DISK)(
  'THE APPROVAL SURFACE NO LONGER SIGNS A DEPLOY A PAGE BUILT: FINISHING A COMPANY IS ONE ACTION THE WALLET RUNS WHOLE [needs contracts/managed/keys; `npm run compact` builds them]',
  () => {
    const surface = async (drawn: boolean) => {
      const port = watchedStore();
      const at = Date.now();
      const profile = drawn
        ? recordRelease(
            emptyProfile(at),
            {
              at,
              nonce: 'k-1',
              recipient: { origin: ORIGIN, name: 'Payroll', rdns: 'example.payroll' },
              company: LABEL,
              account: null
            },
            at
          )
        : emptyProfile(at);
      await save(port, identity, profile);
      const opener = watchedOpener();
      const handlers: ((event: MessageEvent) => void)[] = [];
      const view: ChannelWindow = {
        opener,
        addEventListener: (_t, h) => {
          handlers.push(h);
        },
        removeEventListener: () => undefined
      };
      const r = render(
        <Approve
          identity={identity}
          secret={secretFromWords(TEST_MNEMONIC)}
          port={port}
          view={view}
          readLabel={async () => ({ of: 'no-account' })}
          embedder={ORIGIN}
        />
      );
      const wire = {
        schema: REQUEST_SCHEMA,
        kind: 'creation',
        requester: { name: 'Payroll', rdns: 'example.payroll' },
        purpose: 'To finish creating your company.',
        nonce: 'n-2',
        expiresAt: Date.now() + 600_000,
        company: LABEL,
        account: deploy.address,
        deploy: b64(deploy.proven),
        insert: CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(keyFile(c)) }))
      };
      /* The channel reads only where a message came from, its origin and its data; jsdom's event refuses a source that is not a window. */
      const asked = new MessageEvent('message', { origin: ORIGIN, data: wire });
      Object.defineProperty(asked, 'source', { value: opener });
      await act(async () => {
        for (const h of handlers) h(asked);
      });
      await waitFor(() => expect(r.container.querySelector('[data-creation-retired]')).not.toBeNull());
      return { ...r, port, opener };
    };

    /* RED WHEN: a creation ask still reaches a screen that signs the deploy the page built, or anything is pinned or signed for it. */
    it('A CREATION ASK IS REFUSED, WHETHER OR NOT THIS WALLET DREW THE LABEL: NOTHING IS SIGNED AND NOTHING IS PINNED', async () => {
      for (const drawn of [true, false]) {
        const { container, port, opener } = await surface(drawn);
        expect(container.querySelector('[data-creation-refused]')).toBeNull();
        const kept = await load(port, identity);
        if (kept.of !== 'profile') throw new Error(`the wallet's record did not open: ${kept.of}`);
        /* RED WHEN: the wallet's own record carries a pin: the account a company is pinned to lives only in the saved keys. */
        expect('pinned' in kept.profile).toBe(false);
        const signatures = opener.sent.filter(
          (m) =>
            typeof m.message === 'object' &&
            m.message !== null &&
            Reflect.get(m.message, 'schema') === CREATION_SIGNATURE_SCHEMA
        );
        expect(signatures).toEqual([]);
        cleanup();
      }
    });
  }
);

describe.skipIf(!ON_DISK)(
  'a creation approved before the passkey [needs contracts/managed/keys; `npm run compact` builds them]',
  () => {
    it('is signed with no press once the wallet has read and checked the deploy, pinning first', async () => {
      const log: Logged[] = [];
      render(
        <ApproveCreation
          request={askOf()}
          identity={identity}
          channel={channelFor(log)}
          consent={{ ok: true }}
          whoIsAsking={<p>asker</p>}
          onDecline={() => log.push(['declined'])}
          onPin={async (a, at) => {
            log.push(['pin', a, at]);
          }}
          drewTheLabel
          ledger={liveCreationLedger}
          built={thisBuilds}
          answerAtOnce
        />
      );
      /* RED WHEN: a creation approved before the passkey waits for the screen's own press once the wallet is open. */
      await waitFor(() => expect(log.map((e) => e[0])).toEqual(['pin', 'answer']));
    });

    it('is not signed for a label this wallet never drew', async () => {
      const log: Logged[] = [];
      const { container } = render(
        <ApproveCreation
          request={askOf()}
          identity={identity}
          channel={channelFor(log)}
          consent={{ ok: true }}
          whoIsAsking={<p>asker</p>}
          onDecline={() => log.push(['declined'])}
          onPin={async (a, at) => {
            log.push(['pin', a, at]);
          }}
          drewTheLabel={false}
          ledger={liveCreationLedger}
          built={thisBuilds}
          answerAtOnce
        />
      );
      await waitFor(() => expect(container.querySelector('[data-creation-refused]')).not.toBeNull());
      /* RED WHEN: the wallet's own refusal is passed over because the person approved before the passkey. */
      expect(log).toEqual([]);
    });
  }
);
