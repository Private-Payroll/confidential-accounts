import { nanoid } from 'nanoid';
import { decideList } from './provenance.js';
import type { Hex } from './crypto.js';
import type { AssetId } from './assets.js';
import { assets as defaultAssets, formatAmount, sumAmounts } from './assets.js';
import type { DataStore } from './store.js';
import type { AccountService } from './account.js';
import type { PluginManifest, Installation, PluginEvent, Scope, ShieldedEntry } from './types.js';

/**
 * The extension layer. Two invariants make an open catalogue safe on an account
 * that holds money, and everything else is detail.
 *
 *   1. A plug-in can propose. A plug-in can never execute. Releasing funds
 *      always requires the account threshold, signed by humans. There is no
 *      scope that grants execution and none can be added without changing this
 *      file, which is deliberate.
 *
 *   2. A plug-in never receives the viewing key. It receives a capability token
 *      bound to an account, a scope set and an expiry. Shielded reads are
 *      filtered to the granted scope before they leave, so a plug-in with
 *      state:read:totals cannot see a single line item however it asks.
 *
 * Spending allowances reuse the policy engine rather than inventing a second
 * one. An installed plug-in is a non-human principal with a bounded policy,
 * which is exactly what an agent is. They are the same primitive.
 */

export const CATALOGUE: PluginManifest[] = [
  {
    id: 'safe-bridge', name: 'Safe Connect', publisher: 'First party',
    category: 'interop', verification: 'first-party', version: '0.4.0',
    summary: 'Use an existing Safe on another chain as the source of funds. Assets never move. Deliberation and policy run here, the Safe keeps enforcing its own threshold.',
    scopes: ['state:read', 'proposal:create', 'runs:read'], requestsSpend: true,
  },
  {
    id: 'moneygram-payout', name: 'MoneyGram Payout', publisher: 'MoneyGram',
    category: 'offramp', verification: 'verified', version: '1.2.0',
    summary: 'Cash collection in 100+ countries. Employees convert salary without a bank account. Only the aggregate and the recipient reference leave the account.',
    scopes: ['people:read', 'runs:read', 'proposal:create'], requestsSpend: true,
  },
  {
    id: 'wise-payout', name: 'Wise Transfers', publisher: 'Wise',
    category: 'offramp', verification: 'verified', version: '2.0.1',
    summary: 'Multi currency payout to local bank accounts at interbank rates. Handles the leg between settlement and an employee bank account.',
    scopes: ['people:read', 'runs:read', 'proposal:create'], requestsSpend: true,
  },
  {
    id: 'monument-gbp', name: 'Monument Deposits', publisher: 'Monument Bank',
    category: 'offramp', verification: 'verified', version: '1.0.0',
    summary: 'Fund payroll from a UK bank account in tokenised sterling. No stablecoin conversion and no offramp needed, because the asset is already a regulated deposit.',
    scopes: ['state:read:totals', 'proposal:create'], requestsSpend: false,
  },
  {
    id: 'treasury-yield', name: 'Treasury Yield', publisher: 'Community',
    category: 'treasury', verification: 'community', version: '0.2.3',
    summary: 'Deploy idle treasury into lending markets without publishing the strategy. Proposes moves inside an allowance you set. It cannot move funds on its own.',
    scopes: ['state:read', 'proposal:create'], requestsSpend: true,
  },
  {
    id: 'xero-sync', name: 'Xero Sync', publisher: 'Community',
    category: 'accounting', verification: 'community', version: '1.4.0',
    summary: 'Posts settled payroll to your ledger as a single journal entry. Reads totals only, so your accounting integration never holds individual salaries.',
    scopes: ['state:read:totals', 'runs:read'], requestsSpend: false,
  },
  {
    id: 'hmrc-rti', name: 'HMRC Real Time Information', publisher: 'Community',
    category: 'compliance', verification: 'community', version: '0.9.0',
    summary: 'Files UK payroll submissions from an attestation rather than a spreadsheet of salaries. Issues the proof, submits the return.',
    scopes: ['runs:read', 'disclosure:issue'], requestsSpend: false,
  },
  {
    id: 'auditor-portal', name: 'Auditor Portal', publisher: 'First party',
    category: 'compliance', verification: 'first-party', version: '1.1.0',
    summary: 'Scoped, time boxed access for an external accountant. They verify what they need and see nothing else, and the grant expires on its own.',
    scopes: ['state:read:totals', 'disclosure:issue'], requestsSpend: false,
  },
  {
    id: 'vesting', name: 'Vesting and Cap Table', publisher: 'Community',
    category: 'treasury', verification: 'community', version: '0.6.0',
    summary: 'Scheduled disbursement with shielded amounts on the same engine as payroll. Cliffs are provable without being publicly trackable.',
    scopes: ['people:read', 'proposal:create'], requestsSpend: true,
  },
  {
    id: 'contributor-bounties', name: 'Contributor Payouts', publisher: 'Community',
    category: 'treasury', verification: 'community', version: '0.3.1',
    summary: 'Pay contributors and bounty claimants from the same account, confidentially, without adding them to the payroll roster.',
    scopes: ['proposal:create'], requestsSpend: true,
  },
];

const SCOPE_LABELS: Record<Scope, string> = {
  'state:read': 'Read your shielded balance and every transaction line',
  'state:read:totals': 'Read balance totals only, never individual lines',
  'people:read': 'Read your employee roster',
  'runs:read': 'Read payroll run history',
  'proposal:create': 'Propose transactions for your signers to approve',
  'disclosure:issue': 'Issue attestations to third parties',
};

export const scopeLabel = (s: Scope) => SCOPE_LABELS[s] ?? s;

export class PluginService {
  constructor(
    private store: DataStore,
    private accounts: AccountService,
    private assets = defaultAssets,
  ) {}

  catalogue() { return CATALOGUE; }
  manifest(pluginId: string) {
    const m = CATALOGUE.find(x => x.id === pluginId);
    if (!m) throw new Error('unknown plug-in');
    return m;
  }

  installed(accountId: string) {
    return this.store.listInstallations(accountId);
  }

  install(args: {
    accountId: string; pluginId: string; scopes: Scope[];
    allowance: Installation['allowance']; installedBy: string;
  }): Installation {
    this.accounts.require(args.accountId);
    const manifest = this.manifest(args.pluginId);

    // A plug-in cannot be granted a scope it never asked for. Anything outside
    // the manifest is refused rather than quietly dropped, so a UI bug cannot
    // widen a grant.
    const extra = args.scopes.filter(s => !manifest.scopes.includes(s));
    if (extra.length) throw new Error(`plug-in did not request: ${extra.join(', ')}`);

    if (args.allowance && !manifest.requestsSpend) {
      throw new Error('this plug-in cannot propose spending, so an allowance is meaningless');
    }
    /*
     * A ceiling per asset, and every asset named has to be a real one.
     *
     * Checked here rather than at spend time because an allowance granted in a
     * currency the registry has never heard of is a limit nobody can enforce —
     * and it would only surface at the first payment, which is the worst moment
     * to discover a grant is meaningless.
     */
    if (args.allowance) {
      const named = Object.keys(args.allowance.limits);
      if (named.length === 0) {
        throw new Error(
          'an allowance with no asset in it grants nothing. Leave it null if this plug-in ' +
            'should not be able to propose spending.',
        );
      }
      for (const asset of named) {
        this.assets.require(asset);
        const l = args.allowance.limits[asset]!;
        if (typeof l.perProposal !== 'bigint' || typeof l.perPeriod !== 'bigint') {
          throw new Error(`the ${asset} allowance must be bigints in that asset's smallest unit`);
        }
      }
    }
    if (this.store.listInstallations(args.accountId).some(i => i.pluginId === args.pluginId && i.status !== 'removed')) {
      throw new Error('already installed');
    }

    const install: Installation = {
      id: 'ins_' + nanoid(12),
      accountId: args.accountId,
      pluginId: args.pluginId,
      grantedScopes: args.scopes,
      allowance: args.allowance,
      status: 'active',
      installedAt: new Date().toISOString(),
      installedBy: args.installedBy,
      token: 'cap_' + nanoid(24),
    };
    this.store.putInstallation(install);
    this.log(install, 'installed', `granted ${args.scopes.length} scopes`, true);
    return install;
  }

  setStatus(installationId: string, status: Installation['status']) {
    const i = this.requireInstall(installationId);
    i.status = status;
    this.store.putInstallation(i);
    this.log(i, status === 'removed' ? 'removed' : status, 'by account owner', true);
    return i;
  }

  /* ---------------- the capability check ---------------- */

  /**
   * Every plug-in call goes through here. Resolves the token, refuses anything
   * outside the grant, and writes the attempt to the audit trail whether it
   * succeeded or not. A refused call is more interesting than an allowed one.
   */
  private authorise(token: string, scope: Scope, action: string): Installation {
    const install = this.store.getInstallationByToken(token);
    if (!install) throw new Error('unknown capability token');
    if (install.status !== 'active') {
      this.log(install, action, `blocked: installation is ${install.status}`, false);
      throw new Error(`this plug-in is ${install.status}`);
    }
    if (!install.grantedScopes.includes(scope)) {
      this.log(install, action, `blocked: ${scope} was not granted`, false);
      throw new Error(`not granted: ${scope}`);
    }
    return install;
  }

  /** Shielded read, filtered to the granted scope before it leaves. */
  async read(token: string, viewingKey: Hex) {
    const install = this.store.getInstallationByToken(token);
    if (!install) throw new Error('unknown capability token');

    const full = install.grantedScopes.includes('state:read');
    const totals = install.grantedScopes.includes('state:read:totals');
    if (!full && !totals) {
      this.log(install, 'read state', 'blocked: no read scope', false);
      throw new Error('not granted: state:read');
    }

    const state = await this.accounts.readState(install.accountId, viewingKey);
    if (full) {
      this.log(install, 'read state', 'full ledger', true);
      return state;
    }
    // Totals only. The entries never leave, so no filtering bug downstream can
    // leak them.
    this.log(install, 'read state', 'totals only', true);
    /*
     * THE ENTRY COUNT, AND NOTHING ELSE.
     *
     * A balance per asset stood here. The account keeps no balance, so a
     * totals-scoped plug-in has one honest number to be given: how many entries
     * the log holds. Returning `balances: {}` was the alternative and it is
     * worse — a plug-in rendering "£0.00 held" reads as a fact about the money
     * rather than the absence of a book.
     */
    return { entryCount: state.entries.length };
  }

  /**
   * A plug-in can no longer read the roster, and that is the correct outcome.
   *
   * This used to return names, titles and statuses — which worked only because
   * WE could read them. Sealing the roster removes that, and it should:
   * a plug-in reading employee names off the back of the operator's own access
   * was never a permission the customer granted, it was a side effect of the
   * data being in the clear.
   *
   * Giving a plug-in genuine scoped access means delegating a key to it, which
   * is real design work and is tracked separately. Until then this
   * returns what the store can actually see, and the scope is honest about
   * being unimplemented rather than quietly over-delivering.
   */
  readPeople(token: string) {
    const install = this.authorise(token, 'people:read', 'read roster');
    return this.store.listEmployees(install.accountId).map(e => ({ id: e.id }));
  }

  /**
   * A plug-in can see that runs exist, not what they cost.
   *
   * `total` and headcount used to be here, and worked only because WE could
   * read them. Real scoped access means delegating a key to the installation.
   */
  readRuns(token: string) {
    const install = this.authorise(token, 'runs:read', 'read runs');
    /*
     * **A PLUG-IN'S LIST OF RUNS IS A LIST, AND IT IS HELD TO THE LIST RULE.**
     *
     * The company's bookkeeping reads this. `status` is the field that says a
     * run settled, so a run that never reached a chain sitting here beside one
     * that did is the same false belief the company's own screen refuses -
     * arriving through a different door and into a system that will act on it
     * without anybody looking.
     */
    const verdict = decideList(
      this.accounts.wiring, this.store.listRuns(install.accountId));
    if (!verdict.listed) throw new Error(verdict.message);
    return verdict.rows.map(r => ({
      id: r.id, period: r.period, status: r.status, provenance: r.provenance,
    }));
  }

  /**
   * A plug-in proposes. It never executes. The proposal enters the same queue a
   * human proposal does and needs the same threshold of signatures.
   */
  async propose(token: string, viewingKey: Hex, args: {
    summary: string; asset: AssetId; amount: bigint; recipient: string; proposedBy: string;
  }) {
    const install = this.authorise(token, 'proposal:create', 'propose');

    if (!install.allowance) {
      this.log(install, 'propose', 'blocked: no spending allowance', false);
      throw new Error('this plug-in has no spending allowance');
    }
    /*
     * THE CEILING IS LOOKED UP BY THE ASSET BEING SPENT.
     *
     * That one line is the whole safety property, and it is why the caller may
     * name the asset here where a single-asset allowance would have had to
     * forbid it. A plug-in cannot spend pounds against an ether ceiling,
     * because there is no way to reach a ceiling except through the asset it
     * was set for — the pairing is made by the lookup rather than by a check
     * somebody has to remember to write.
     *
     * An asset with no entry is refused outright. Not zero, not unlimited: an
     * asset this installation was never granted.
     */
    const registered = this.assets.require(args.asset);
    const limit = install.allowance.limits[args.asset];
    if (!limit) {
      const granted = Object.keys(install.allowance.limits).sort();
      this.log(install, 'propose', `blocked: no ${args.asset} allowance`, false, args.asset, args.amount);
      throw new Error(
        `this plug-in has no ${args.asset} allowance. It may spend ` +
          `${granted.join(', ')} and nothing else.`,
      );
    }
    if (typeof args.amount !== 'bigint') {
      throw new Error('amount must be a bigint in the asset\'s smallest unit');
    }
    if (args.amount <= 0n) throw new Error('amount must be positive');

    if (args.amount > limit.perProposal) {
      this.log(install, 'propose',
        `blocked: ${formatAmount(args.amount, registered)} ${args.asset} exceeds the ` +
        `per-proposal allowance of ${formatAmount(limit.perProposal, registered)}`,
        false, args.asset, args.amount);
      throw new Error(
        `exceeds this plug-in's per-proposal allowance of ` +
        `${formatAmount(limit.perProposal, registered)} ${args.asset}`,
      );
    }

    const spent = this.spentInPeriod(install, args.asset);
    if (spent + args.amount > limit.perPeriod) {
      this.log(install, 'propose',
        `blocked: would exceed the ${args.asset} period allowance ` +
        `(${formatAmount(spent, registered)} already proposed)`,
        false, args.asset, args.amount);
      throw new Error(`exceeds this plug-in's ${args.asset} allowance for the period`);
    }

    const entries: ShieldedEntry[] = [{
      id: 'ent_' + nanoid(10), kind: 'transfer', asset: args.asset, amount: args.amount,
      counterparty: args.recipient, memo: `via ${this.manifest(install.pluginId).name}`,
      at: new Date().toISOString(),
    }];

    const proposal = await this.accounts.propose({
      accountId: install.accountId, viewingKey, kind: 'transfer',
      summary: args.summary, payload: { entries }, asset: args.asset,
      proposedBy: args.proposedBy,
    });

    this.log(install, 'propose', `${args.summary} (awaiting signatures)`, true, args.asset, args.amount);
    return proposal;
  }

  /**
   * What this installation has already proposed in the window, IN ONE ASSET.
   *
   * The asset filter is load-bearing. Without it a plug-in granted both pounds
   * and USDC would have each ceiling consumed by the other's spending, so a
   * month of dollar payments would exhaust the sterling allowance and neither
   * limit would mean what the person who set it thought it meant.
   */
  private spentInPeriod(install: Installation, asset: AssetId): bigint {
    if (!install.allowance) return 0n;
    const since = Date.now() - install.allowance.periodDays * 86400_000;
    return sumAmounts(
      this.store.listPluginEvents(install.accountId)
        .filter(e => e.installationId === install.id && e.allowed && e.amount !== undefined)
        .filter(e => e.asset === asset)
        .filter(e => new Date(e.at).getTime() >= since)
        .map(e => e.amount!),
    );
  }

  /* ---------------- audit ---------------- */

  private log(
    install: Installation,
    action: string,
    detail: string,
    allowed: boolean,
    /** Present together or not at all: an amount with no asset cannot be read. */
    asset?: AssetId,
    amount?: bigint,
  ) {
    const event: PluginEvent = {
      id: 'evt_' + nanoid(12),
      installationId: install.id,
      accountId: install.accountId,
      pluginId: install.pluginId,
      action, detail, allowed, asset, amount,
      at: new Date().toISOString(),
    };
    this.store.putPluginEvent(event);
  }

  events(accountId: string) {
    return this.store.listPluginEvents(accountId)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  requireInstall(id: string): Installation {
    const i = this.store.getInstallation(id);
    if (!i) throw new Error('installation not found');
    return i;
  }
}
