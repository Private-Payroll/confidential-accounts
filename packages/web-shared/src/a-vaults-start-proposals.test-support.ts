/**
 * **A COMPANY'S PROPOSALS, KEPT FOR A TEST OF A VAULT'S START.** What setting a
 * vault up writes its two proposals into: the service's proposal routes kept in
 * memory, each filing checked as the service checks it (`proposalFilingRefusal`)
 * and a raise sent with it counted as reaching the chain, and the company's
 * directory as one seat's device believes it before any of these proposals is
 * anchored. Every call is logged in order, so a test reads what was written
 * down, sent and entered.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { signingPublicKeyOf } from '../../../src/core/crypto.js';
import { proposalFilingRefusal } from '../../../src/core/proposal-filing.js';
import type { Role, SealedProposal } from '../../../src/core/types.js';
import { NothingWasSent } from '../../../src/core/jobs.js';
import type { ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import { kindKeyOf } from '../../../src/midnight/records-held.js';
import { FiledNotEntered, type Filed } from './record-entered-here.js';
import type { RoundOnThePage } from './governed-call-on-device.js';
import type { DirectoryHere } from './vault-page-doors.js';
import type { VaultStartProposals } from './vault-operation.js';

export interface ProposalsKeptInATest {
  readonly doors: VaultStartProposals;
  /** The company's proposals as the service keeps them, in filing order. */
  readonly kept: SealedProposal[];
  /** Each call, in order: `file`, `file and raise`, `send <id>`, `entered <id>`, `not entered <id>`, `carried <id>`, `not carried <id>`. */
  readonly log: string[];
  /** What a raise sent with each filing or send carried, by proposal. */
  readonly raised: Map<string, string>;
  /** The body of each filing, as the service was handed it. */
  readonly bodies: Array<Record<string, unknown>>;
}

/**
 * One seat's view: `signingSecret` is the seat's filing key, `role` its role in
 * the directory. `failSend` writes a raise down and then refuses it before the
 * chain is handed it; `failEnter` refuses that many entries (every one, given
 * true). `onRaise` is told of each raise that reaches the chain. `notBelieved`
 * makes the seat one this device does not believe.
 */
export const proposalsKeptInATest = (over: {
  readonly signingSecret: Hex; readonly role?: Role | null; readonly accountId?: string; readonly viewingKey?: Hex;
  readonly failSend?: boolean; readonly failEnter?: boolean | number; readonly kept?: SealedProposal[];
  readonly onRaise?: (chainId: string) => void;
  /** The service refuses to write a carried-out proposal down. */
  readonly failCarried?: boolean;
  /** Why this device does not believe the seat: its wallet never attested its records key, or the chain does not hold it. */
  readonly notBelieved?: 'unattested' | 'not-on-the-chain';
}): ProposalsKeptInATest => {
  const accountId = over.accountId ?? 'acc_1';
  const kept: SealedProposal[] = over.kept ?? [];
  const log: string[] = [];
  const raised = new Map<string, string>();
  const bodies: Array<Record<string, unknown>> = [];
  let entryRefusals = typeof over.failEnter === 'number' ? over.failEnter : over.failEnter === true ? Infinity : 0;
  const round = (p: SealedProposal): RoundOnThePage => ({ id: p.id, chainId: p.chainId, status: p.status, approvalCount: 0 });
  /*
   * The directory as this seat's device believes it: its own seat, and the company's records asked for every
   * proposal with none of them anchored yet. Only what a vault's start reads of it is given.
   */
  const here = {
    dir: {
      company: accountId,
      seats: [{ seat: 'ada', signingKey: signingPublicKeyOf(over.signingSecret), role: over.role === undefined ? 'admin' : over.role, retired: null }],
    },
    another: new Set(over.notBelieved === 'unattested' ? ['ada'] : []),
    holders: { seats: over.notBelieved === 'not-on-the-chain' ? [] : ['ada'] },
    records: {
      asked: { records: new Set<string>(), kinds: new Set([kindKeyOf({ store: 'proposal', kind: 'proposal' })]) },
      history: new Map(), notYetAnchored: [], stopped: null,
    },
  } as unknown as DirectoryHere;
  const doors: VaultStartProposals = {
    accountId,
    companyKeys: over.viewingKey ?? ('44'.repeat(32) as Hex),
    signingSecret: over.signingSecret,
    directory: async () => here,
    entered: {
      enter: async (filed: readonly Filed[]) => {
        for (const f of filed) {
          const id = (f as ManifestEntryBody).id;
          if (entryRefusals > 0) {
            entryRefusals -= 1;
            log.push(`not entered ${id}`);
            throw new FiledNotEntered('the service did not keep the entry');
          }
          log.push(`entered ${id}`);
        }
      },
    },
    service: {
      callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'bh', accountState: 'as', parameters: 'pp' }) as never,
      sealedProposals: async () => [...kept],
      file: async (company, body) => {
        bodies.push(body as unknown as Record<string, unknown>);
        const why = proposalFilingRefusal(company, body.proposal);
        if (why !== null) throw new NothingWasSent(`this is not a proposal this company can write down: ${why}. Nothing was written down or sent.`);
        const f = body.proposal;
        const rec: SealedProposal = {
          id: f.id, accountId: company, status: 'open', createdAt: f.createdAt, digest: f.digest, chainId: f.chainId,
          approvalCount: 0, keyEpoch: f.keyEpoch, sealed: f.sealed, filedBy: { publicKey: f.filedBy.publicKey, signature: f.filedBy.signature },
        };
        kept.push(rec);
        log.push(body.tx === undefined ? 'file' : 'file and raise');
        if (body.tx !== undefined) {
          if (over.failSend === true) throw new NothingWasSent('the chain could not be asked. Nothing was sent.');
          raised.set(f.id, body.tx);
          over.onRaise?.(f.chainId);
        }
        return round(rec);
      },
      send: async (id, body) => {
        log.push(`send ${id}`);
        const rec = kept.find((p) => p.id === id);
        if (rec === undefined) throw new NothingWasSent('this company holds no proposal by that name. Nothing was sent.');
        raised.set(id, body.tx);
        over.onRaise?.(rec.chainId);
        return round(rec);
      },
    },
    carried: async (id, body) => {
      if (body.filer !== signingPublicKeyOf(over.signingSecret).toLowerCase() || !/^[0-9a-f]{64}$/u.test(body.vault)) {
        log.push(`not carried ${id}`);
        throw new Error('this request does not carry this seat\'s filing key and the vault');
      }
      const i = kept.findIndex((p) => p.id === id);
      if (over.failCarried === true || i < 0) {
        log.push(`not carried ${id}`);
        throw new Error('the chain did not answer, so whether it carried this proposal out is not known');
      }
      kept[i] = { ...kept[i]!, status: 'executed' };
      log.push(`carried ${id}`);
    },
  };
  return { doors, kept, log, raised, bodies };
};
