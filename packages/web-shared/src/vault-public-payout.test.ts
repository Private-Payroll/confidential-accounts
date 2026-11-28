import { payPrivatelyFromCompanyVault } from './vault-pay-privately-and-merge.js';
import { type PaymentInFlight } from './vault-payment-in-flight.js';
import { PublicPaymentNotYetSeen, payPubliclyFromCompanyVault } from './vault-public-payout.js';
import { type VaultService } from './vault-service.js';
import { newWrappingKeypair } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore } from '../../../src/midnight/vault-pool.js';
import type {
  PrivatePaymentOnTheWire,
  PrivatePaymentOrderOnTheWire
} from '../../../src/midnight/private-payment-wire.js';
import { describe, expect, it } from 'vitest';
import { seatBarOf } from 'midnight-identity/profile/records-key';
import {
  type ChainBehind,
  type TestView,
  VAULT,
  aServiceThatLies,
  builder,
  hereAndThere,
  inFlightInMemory,
  indexerOf,
  pacing,
  serviceFrom,
  theServiceNeverAsked,
  view,
  walletKey,
  walletReadsTheVault
} from './vault-operation.test-support.js';

describe('A PUBLIC PAYMENT OUT', () => {
  const NOW = new Date(1_800_000_000_000);
  const TOKEN = '00'.repeat(32);
  const order = (pay: Partial<PrivatePaymentOnTheWire> = {}) => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0,
      kind: 'unshielded',
      payee: 'mn_addr_x',
      token: TOKEN,
      amount: '250',
      blinding: '0b'.repeat(32),
      nonce: '0c'.repeat(32),
      leaf: '0d'.repeat(32),
      path: [],
      paid: false,
      ...pay
    };
    return {
      payment,
      order: {
        asset: TOKEN,
        form: 'unshielded',
        symbol: 'NIGHT',
        vault: VAULT,
        proposal: '0f'.repeat(32),
        salt: '5a'.repeat(32),
        root: '9a'.repeat(32),
        payees: '1',
        opensAt: '1799999000',
        closesAt: '1800009000',
        payments: [payment]
      } as PrivatePaymentOrderOnTheWire
    };
  };
  const doorsFor = (
    log: string[],
    answers: Array<boolean | null>,
    over: Partial<VaultService> & Partial<ChainBehind> = {},
    seen: TestView = view({ heldByCommittee: true, started: true })
  ) => {
    let i = 0;
    const service = serviceFrom([seen], log, over);
    return {
      ...pacing,
      ...walletReadsTheVault,
      now: () => NOW,
      service,
      indexer: indexerOf(service),
      builder: builder(log),
      paidYet: async () => {
        log.push('asked the account');
        return answers[Math.min(i++, answers.length - 1)]!;
      }
    };
  };

  it("A PUBLIC PAYMENT OUT OF A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER'S OWN WALLET READS IT, IS REFUSED BEFORE ANYTHING IS BUILT", async () => {
    const log: string[] = [];
    const d = {
      ...doorsFor(log, [false]),
      onChain: async (v: string) => ({
        holders: {
          committee: [],
          threshold: 1,
          seats: [],
          approvals: 1,
          vaultThresholds: [],
          policyBar: null,
          seatBar: seatBarOf(1, null),
          adoptedVaults: [],
          founding: '4a'.repeat(32),
          foundingCommittee: [{ tag: 'schnorr', value: walletKey(0x11) }]
        }
      })
    };
    /* RED WHEN: public money is paid out of a vault the service named and the account never adopted. */
    await expect(payPubliclyFromCompanyVault(d, order())).rejects.toThrow(/not one your company's account has adopted/);
    expect(log.filter((l) => l.startsWith('build') || l.startsWith('sent'))).toEqual([]);
  });

  it("A PUBLIC PAYMENT IS BUILT ON THE BLOCK THIS DEVICE READ AT THE WALLET'S INDEXER; WHAT THE SERVICE WOULD SERVE IS NEVER ASKED", async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const d = doorsFor(log, [false, true]);
    await payPubliclyFromCompanyVault({ ...d, service: aServiceThatLies(d.service, asked) }, order());
    /* RED WHEN: the block a public payment is built on is asked of the service. */
    expect(asked).toEqual([]);
    expect(log.filter((l) => l.startsWith('build'))).toEqual(['build public payout of 250 to mn_addr_x at B1']);
  });

  it("A PUBLIC PAYMENT OUT OF A VAULT WHOSE COMMITTEE DIFFERS FROM THE ACCOUNT'S GOES AHEAD WHILE THE VAULT IS PINNED TO THE ACCOUNT", async () => {
    const log: string[] = [];
    /* Started and pinned to the company's account, and held by other keys than the account is, as the chain shows both. */
    const done = await payPubliclyFromCompanyVault(
      doorsFor(log, [false, true], {}, view({ heldByCommittee: false, started: true })),
      order()
    );
    /* RED WHEN: a public payment reads who holds the vault - a committee change the service leaves half done would then stop it. */
    expect(done).toEqual({ txRef: 'u' });
    expect(log).toContain('sent public payout');
  });

  it("BUILDS THE VAULT'S PUBLIC PAYOUT, SENDS IT THROUGH THE PUBLIC DOOR, AND IS DONE WHEN THE ACCOUNT RECORDS IT", async () => {
    const log: string[] = [];
    const done = await payPubliclyFromCompanyVault(doorsFor(log, [false, true]), order());
    /* RED WHEN: a public payment chooses a note, reads a note's events, goes out through the private door, or
     * reports done before the company's account records it. */
    expect(log).toEqual([
      'read the block here',
      'build public payout of 250 to mn_addr_x at B1',
      'sent public payout',
      'asked the account',
      'asked the account'
    ]);
    expect(done).toEqual({ txRef: 'u' });
  });

  it('A PRIVATE PAYMENT IS NEVER PAID PUBLICLY, AND A PUBLIC ONE NEVER PRIVATELY', async () => {
    const log: string[] = [];
    /* RED WHEN: the public operation takes a payment the leg names as private - it would send a private payee public money. */
    await expect(
      payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ kind: 'shielded', payee: 'mn_shield-addr_x' }))
    ).rejects.toThrow(/^this payment is not a public one, so it is not paid publicly\. Nothing was sent\.$/);
    expect(log).toEqual([]);
    /* RED WHEN: the private operation takes a payment the leg names as public - it would spend a note on a public payee's leaf. */
    const wrapping = newWrappingKeypair();
    await expect(
      payPrivatelyFromCompanyVault(
        {
          ...pacing,
          ...walletReadsTheVault,
          now: () => NOW,
          me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32) },
          myRecordsKey: 'ff'.repeat(32),
          records: () => new MemorySealedPoolStore(),
          seatHere: async () => null,
          signers: async () => [],
          ...hereAndThere(serviceFrom([view({ heldByCommittee: true, started: true })], log)),
          builder: builder(log),
          inFlight: inFlightInMemory<PaymentInFlight>()
        },
        order()
      )
    ).rejects.toThrow(/^this payment is not a private one, so it is not paid privately\. Nothing was sent\.$/);
    expect(log).toEqual([]);
  });

  it('IS NOT SENT FOR SOMEBODY THE ACCOUNT ALREADY RECORDS PAID, OR OUTSIDE THE APPROVED WINDOW', async () => {
    const log: string[] = [];
    /* RED WHEN: a public payee the account already records paid is offered a second payment. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ paid: true }))).rejects.toThrow(
      /already records this person paid/
    );
    const late = { ...doorsFor(log, [true]), now: () => new Date(1_900_000_000_000) };
    /* RED WHEN: the window the signers approved is not asked before a public payment is built. */
    await expect(payPubliclyFromCompanyVault(late, order())).rejects.toThrow(/only inside the window/);
    expect(log).toEqual([]);
  });

  it('A PUBLIC PAYMENT OUT OF A VAULT NOT STARTED IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const notStarted = { chain: async () => view({ heldByCommittee: true, started: false }) };
    /* RED WHEN: the public payment's check of the fundable answer is removed - a payment is then built out of a vault not started. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true], notStarted), order())).rejects.toThrow(
      /^No payment can be made out of this vault yet.*this vault has not been started/
    );
    expect(log).toEqual([]);
  });

  it('A PUBLIC PAYMENT READS THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const log: string[] = [];
    const asked = { n: 0 };
    /* RED WHEN: the public payment reads the vault through the service's chain route. */
    await payPubliclyFromCompanyVault(theServiceNeverAsked(doorsFor(log, [false, true]), asked), order());
    expect(log).toContain('sent public payout');
    expect(asked.n).toBe(0);
  });

  it('A FAILURE AFTER THE SEND IS NEVER REPORTED AS A PAYMENT THAT DID NOT HAPPEN', async () => {
    const log: string[] = [];
    /* RED WHEN: an account that never records the payment is read as the payment not having been made. */
    const e = await payPubliclyFromCompanyVault(doorsFor(log, [false]), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PublicPaymentNotYetSeen);
    expect(e.message).toMatch(
      /^the payment may have been sent \(u\) and this device has not seen it land, so it may still land\. Do not pay this person again/
    );
    /* A refusal before anything was sent says so, and is not dressed up as a payment that may have moved. */
    const refused = Object.assign(new Error('this is not a public payment. Nothing was sent.'), {
      nothingWasSent: true
    });
    await expect(
      payPubliclyFromCompanyVault(
        doorsFor([], [true], {
          payoutPublicly: async () => {
            throw refused;
          }
        }),
        order()
      )
    ).rejects.toBe(refused);
    const lost = await payPubliclyFromCompanyVault(
      doorsFor([], [true], {
        payoutPublicly: async () => {
          throw new Error('the socket closed');
        }
      }),
      order()
    ).catch((x) => x);
    /* RED WHEN: a send that may have reached the chain is reported as nothing sent. */
    expect(lost).toBeInstanceOf(PublicPaymentNotYetSeen);
  });
});
