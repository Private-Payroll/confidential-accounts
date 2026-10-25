import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { parseAsk, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringReleaseFor, withTheFounding, withTheKeysRead } from 'midnight-identity/profile/unlock';
import { foundTheCompanyInTheWallet } from './found-company.js';
import { keysReadForThePage } from './read-for-the-page.js';
import { refuseIfItCarriesASecret } from './nothing-secret-crosses.js';
import type { KeyringMark, KeyringMarks } from './held-keyring.js';
import * as keyring from '../../../../packages/web-shared/src/keyring.js';
import type { Openable } from '../../../../packages/web-shared/src/wallet-sign-in.js';
import { MemoryStore } from '../../../../src/core/store.js';
import { MemoryCompanyRecordStore } from '../../../../src/server/company-records-route.js';
import { aCompanyCreatedOnTheLedger } from '../../../../src/server/account-creation.js';
import { openKeyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { savedKeysSealKey } from '../../../../src/testing/a-wallet-founds-a-company.js';

/**
 * **A COMPANY CREATED FROM THE PAGE IS ONE THE SERVICE TAKES.**
 *
 * The first press, end to end with no stand-in on either side of the body: the page's own press
 * (`startCompanyHeldFromTheStart`), a wallet answering the keyring 'new' ask as the wallet's approve screen does
 * (`foundTheCompanyInTheWallet`, `withTheFounding`, `withTheKeysRead`, the outgoing secret check), and the body the
 * page sends to POST /api/accounts handed to the route's own handler (`aCompanyCreatedOnTheLedger`) on a chain
 * wiring that takes companies from their founding signer.
 */
const PAGE = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const PERSON = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);

/** A wallet tab that answers each keyring ask with the wallet's own code, as its approve screen composes it. */
class WalletAsItAnswers implements Openable {
  private readonly seen = new Map<string, KeyringMark>();
  private readonly marks: KeyringMarks = { markOf: (p) => this.seen.get(p) ?? null, raise: (p, m) => { this.seen.set(p, m); } };
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => { void this.onAsk(m); } };
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void { this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private async onAsk(message: unknown): Promise<void> {
    let answer: unknown;
    try {
      const ask = parseAsk(message, PAGE, Date.now());
      if (ask.kind !== 'keyring') throw new Error('only the saved keys are asked for here');
      const request = ask as KeyringRequest;
      const at = Date.now();
      const holds = (a: string): boolean => a === ADDRESS;
      if (request.drawLabel) {
        const label = drawCompanyLabel();
        const founded = await foundTheCompanyInTheWallet({ identity, request, label, marks: this.marks });
        answer = withTheKeysRead(withTheFounding(
          keyringReleaseFor(identity, request, at, holds, () => label),
          { founded: founded.founded, sealed: founded.sealed, ifVersion: founded.ifVersion },
        ), founded.read);
      } else {
        const released = keyringReleaseFor(identity, request, at, holds);
        const here = keysReadForThePage({ identity, request, marks: this.marks });
        answer = here === null ? released : withTheKeysRead(released, here.read);
      }
      refuseIfItCarriesASecret(answer);
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** The service: the saved keys as PUT /api/me/keys keeps them, and POST /api/accounts answered by its own route handler. */
function theService() {
  const store = new MemoryStore();
  const records = new MemoryCompanyRecordStore();
  const answered: Array<{ status: number; body: Record<string, unknown> }> = [];
  const sent: unknown[] = [];
  let saved: { bundle: unknown; version: number } = { bundle: null, version: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const as = (init?.headers as Record<string, string> | undefined)?.['x-signed-in-as'] ?? '';
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys':
        if (saved.bundle !== null && body.ifVersion !== saved.version) return json(409, { error: 'your saved keys changed since they were read' });
        saved = { bundle: body.keyBundle, version: saved.version + 1 };
        return json(200, { version: saved.version });
      case 'POST /api/accounts': {
        sent.push(body);
        const answer = await aCompanyCreatedOnTheLedger({
          store, ledger: { wiring: 'midnight', takesCompaniesFromTheirFoundingSigner: true } as never, records,
        }, as, body);
        answered.push(answer!);
        return json(answer!.status, answer!.body);
      }
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return { store, answered, sent, saved: () => saved };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

describe('A COMPANY CREATED FROM THE PAGE', () => {
  it('is founded in the wallet and taken by the service as one its founding signer\'s device made', async () => {
    const service = theService();
    keyring.signedInByAnotherScreen({ user: PERSON, address: ADDRESS, created: true, session: {} });

    const started = await keyring.startCompanyHeldFromTheStart(
      { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1 }, WALLET, new WalletAsItAnswers(), PAGE,
    );

    /* RED WHEN: the founding the page reads back from the wallet's release loses a field the service requires of a company made on the device (its address source or wiring), so Create a company is refused at step 1. */
    expect(service.answered).toEqual([{ status: 201, body: { account: { id: started.accountId }, state: 'made' } }]);
    /* RED WHEN: the service records a company other than the one the wallet founded under the label it drew. */
    expect(service.store.getAccount(started.accountId)).toMatchObject({
      id: started.accountId, companyLabel: started.label, contractAddress: null, addressSource: null, wiring: 'midnight',
    });
    const kept = openKeyring(service.saved().bundle as never, savedKeysSealKey(identity, {
      requester: { origin: PAGE, name: 'x', rdns: 'x' }, person: PERSON.id,
    } as never) as never).creations![started.accountId]!;
    /* RED WHEN: the page sends the service a company other than the one the wallet founded and kept in the saved keys, field for field. */
    expect(service.sent).toEqual([kept.request]);
  });
});
