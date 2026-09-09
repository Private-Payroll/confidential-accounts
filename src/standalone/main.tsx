/**
 * Standalone build. The entire product runs in the browser with no server.
 *
 * This is possible because core/ is isomorphic: the same account service,
 * payroll service, policy engine and cryptography that run on the server run
 * here unchanged. Only the store swaps (memory instead of a file) and the
 * transport swaps (a direct call instead of HTTP).
 *
 * The fetch shim below implements the same routes as src/server/index.ts so
 * App.tsx does not know which mode it is running in.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../web/App.js';
import '../web/styles.css';

import { MemoryStore } from '../core/store.js';
import { wiring, observerView } from '../wiring/selection.js';
import { AccountService } from '../core/account.js';
import { PayrollService, RecordingInviteDelivery } from '../core/payroll.js';
import { runPayments } from '../midnight/run-status.js';
import { rootOfLeaves } from '../midnight/payout-tree.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { bigintJsonReplacer, type Hex } from '../core/crypto.js';

/**
 * This build runs entirely in the browser with a simulated ledger, so its
 * network is `undeployed` — an address for any real network is refused, which
 * is the right answer for a demo that cannot reach a chain.
 */
const NETWORK = 'undeployed' as const;

/** No mail from a browser. The tokens are kept where the console can show them. */
const invites = new RecordingInviteDelivery();
import { PluginService } from '../core/plugins.js';
import { seedDemo } from '../core/demo.js';
import { assets as assetRegistry, parseAmount } from '../core/assets.js';
import { IdentityService, StaleKeyBundle } from '../core/identity.js';
import { MemoryChallengeStore } from '../core/challenges.js';
import { MemorySessionStore } from '../core/sessions.js';

const store = new MemoryStore();
/*
 * THE SAME SELECTOR THE SERVER USES, AND THAT IS THE POINT OF IT BEING HERE.
 *
 * This file used to hold its own copy of the decision — two constructions
 * identical to `src/server/index.ts:101-102`, kept in step by nobody. Two copies
 * of a choice is one copy that gets changed. Now both builds read the same line
 * in `src/wiring/selection.ts`, and the commitment scheme comes with the ledger
 * rather than being defaulted separately by `AccountService`.
 */
const chosen = wiring();
const ledger = chosen.createLedger();
const proofs = chosen.createProofSystem();
const accounts = new AccountService(store, ledger, chosen.commitments);
const payroll = new PayrollService(store, accounts, proofs, undefined, NETWORK, invites);
const plugins = new PluginService(store, accounts);
// The same identity service the server runs. **There is no password in either
// build since `PI4b`**: this holds the session and the sealed bundle, and who
// somebody is comes from their wallet. The vault is sealed under a key the shim
// never sees, exactly as in the hosted build.

// IN-MEMORY SESSIONS AND LIMITER ARE THE RIGHT ANSWER HERE AND ONLY HERE.
// There is no server and no second process, so "per-process" is "per-tab",
// which is what a single-tab build wants: closing it ends the session, and
// there is nothing to restart. **This is not a fallback the server may reach**
// — src/server/index.ts refuses to boot on these unless told to in so many
// words. S-4 used to be about a hardcoded `'00'.repeat(32)` secret here; there
// is no session secret any more, so there is nothing to hardcode.
/*
 * NAMED, because `DeviceService` needs the SAME session store the identity
 * service uses. Constructed inline, the two would each get their own and
 * removing a device would revoke sessions in a store nothing reads — a
 * revocation that runs, reports success and ends nothing.
 */
const sessions = new MemorySessionStore();
/* `PI4a`: recovery is deleted, so this no longer takes a challenge store. The
 * import stays because `MemoryChallengeStore` is what a wallet sign-in nonce
 * uses, and this build is where that is owed next — see the entry. */
/* `PI4b`: the limiter is no longer a constructor argument — what it guarded was
 * `login`, and there is no login. **The import went with it**, because the one
 * thing in this build that took a limiter was this line: a wallet sign-in
 * service, which counts on one, is what this build owes next and is not here
 * yet. An import kept warm for a caller that does not exist is the same dead
 * weight this round is removing everywhere else. */
const identity = new IdentityService(store, sessions);

/**
 * The same decimal-string-plus-asset rule the hosted server keeps. One
 * definition per build rather than one shared one, because this file is the
 * standalone bundle and deliberately imports nothing from `src/server`.
 */
const money = (asset: string, amount: string): bigint =>
  parseAmount(String(amount), assetRegistry.require(asset));

/*
 * BIGINTS SURVIVE THIS. Found by audit, 17 Aug — `M-134` in the second
 * implementation of the API, which is where it happened the first time too.
 *
 * The hosted server sets `bigintJsonReplacer` as Express's JSON replacer; this
 * shim was a bare `JSON.stringify`, so the moment a route returned a bigint —
 * `offerFor` returns a salary — it threw *"Do not know how to serialize a
 * BigInt"*, and the outer catch turned that into a 400 at the person trying to
 * read what they were being offered.
 */
const ok = (body: unknown) =>
  new Response(JSON.stringify(body, bigintJsonReplacer), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
const bad = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });

/**
 * There is no network here, so there is no address to count against. `ip: null`
 * says that rather than inventing one — the per-email limit still applies, and
 * a per-IP limit in a single tab would be counting this tab against itself.
 */
const LOCAL = { ip: null, userAgent: 'this browser' };

/** The bearer token as sent, or ''. */
function bearer(init?: RequestInit): string {
  const h = new Headers(init?.headers ?? {});
  return String(h.get('authorization') ?? '').replace(/^Bearer /, '');
}

/** Resolves the bearer token exactly as the server does. */
async function caller(init?: RequestInit): Promise<string> {
  return identity.verify(bearer(init));
}

/**
 * THE HOSTED BUILD'S `ownsPerson`, WHICH THIS BUILD DID NOT HAVE. Found by
 * audit 17 Aug.
 *
 * `/api/employees/:id/admit` and `/api/people/:id/status` both carry
 * `ownsPerson` in `src/server/index.ts` — the first sets where somebody's
 * salary goes, the second decides whether they are paid at all. Here they were
 * `authed` and nothing more, so any signed-in user of this build could name any
 * employee id on any company. **The gate was added on one build in the turn it
 * was found and not the other**, which is the same second-build drift as the
 * bigint serialiser and the stripped invites listing, three times in one slice.
 *
 * Returns the caller, so a route cannot use the id without passing the gate.
 */
async function ownsPerson(employeeId: string, init?: RequestInit): Promise<string> {
  const who = await caller(init);
  const rec = store.getEmployee(employeeId);
  /* The same refusal whether the record is missing or simply not yours. */
  if (!rec) throw new Error('employee not found');
  accounts.requireMember(rec.accountId, who);
  return who;
}

async function route(url: URL, init?: RequestInit): Promise<Response> {
  const p = url.pathname;
  const q = url.searchParams;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const seg = p.split('/').filter(Boolean); // ['api', ...]

  if (p === '/api/health') return ok({ ok: true, ledger: ledger.describe(), proofs: proofs.describe() });

  /* ---------------- auth ---------------- */

  /* **`/api/auth/register` AND `/api/auth/login` ARE DELETED HERE TOO.**
   * `PI4b`, `C129`, in both builds and in the same turn, because this pair has
   * drifted apart three times already. There is no password to stretch and no
   * `authHash` to compare against; a wallet sign-in is the only way in, and
   * anything reaching these two addresses falls through to the 404 below. */
  /* **THE THREE RECOVERY ROUTES ARE DELETED HERE TOO.** `PI4a`, in both builds
   * and in the same turn, because this pair has drifted apart three times
   * already. Nothing called them and they could not serve a wallet account. */

  if (p === '/api/auth/logout' && method === 'POST') {
    await identity.signOut(bearer(init));
    return ok({ ok: true });
  }
  if (p === '/api/me/sessions' && method === 'GET')
    return ok({ sessions: await identity.listSessions((await caller(init)), bearer(init)) });
  if (p === '/api/me/sessions/others/revoke' && method === 'POST')
    return ok({ ended: await identity.signOutEverywhere((await caller(init)), bearer(init)) });
  if (seg[1] === 'me' && seg[2] === 'sessions' && seg[4] === 'revoke' && method === 'POST') {
    const ended = await identity.endSession((await caller(init)), seg[3]);
    return ended ? ok({ ok: true }) : bad('no such session', 404);
  }
  if (p === '/api/me/keys' && method === 'PUT') {
    /* **THE ENVELOPE REFUSAL IS GONE WITH THE ENVELOPE**, in both builds and in
     * the same turn. There is no bundle key and no device copy, so the
     * bundle is the only thing there is to replace. */
    const who = await caller(init);
    /* `C40`, same refusal as hosted and written in the same turn. */
    try {
      const u = identity.updateKeyBundle(who, body.keyBundle, body.ifVersion);
      return ok({ ok: true, version: u.keyBundleVersion });
    } catch (e) {
      if (e instanceof StaleKeyBundle) return bad(e.message, 409);
      throw e;
    }
  }
  if (p === '/api/me/keys' && method === 'GET') {
    /* **One half now, because there is only one** — see the hosted route. */
    const u = identity.user((await caller(init)));
    return ok({
      keyBundle: u.keyBundle,
      version: u.keyBundleVersion ?? 0,
    });
  }

  /* **THE DEVICE-ENVELOPE ROUTES ARE DELETED HERE TOO.** `PI4a`, `C31`, in
   * both builds and in the same turn. Sessions are not devices and are
   * untouched: removing a device now means revoking its session, and that is
   * enough, because no device holds a copy of anything that opens the data. */
  if (p === '/api/me' && method === 'GET') {
    const u = identity.user((await caller(init)));
    return ok({
      user: { id: u.id, email: u.email, name: u.name },
      // Sealed, exactly as the server sends it. The name and the roster are
      // inside the envelope and this half of the app does not hold the key
      // either — the standalone build has no server, so "we cannot read it"
      // has to mean the same thing here.
      accounts: store.accountsForUser(u.id),
    });
  }

  if (p === '/api/accounts' && method === 'GET')
    return ok(store.accountsForUser((await caller(init))));

  if (p === '/api/accounts' && method === 'POST') {
    const uid = (await caller(init));
    const signers = body.signers.map((x: any, i: number) => ({ ...x, userId: i === 0 ? uid : null }));
    return ok(await accounts.create(body.name, signers, body.threshold));
  }

  if (p === '/api/demo/seed' && method === 'POST') {
    return ok(await seedDemo(accounts, payroll, (await caller(init))));
  }

  if (p === '/api/plugins/catalogue') return ok(plugins.catalogue());
  if (p === '/api/plugin/state' && method === 'GET')
    return ok(await plugins.read(q.get('token') ?? '', q.get('viewingKey') ?? ''));
  if (p === '/api/plugin/people' && method === 'GET') return ok(plugins.readPeople(q.get('token') ?? ''));
  if (p === '/api/plugin/runs' && method === 'GET') return ok(plugins.readRuns(q.get('token') ?? ''));
  if (p === '/api/plugin/propose' && method === 'POST')
    return ok(await plugins.propose(body.token, body.viewingKey, body));

  if (seg[1] === 'installations' && seg[3] === 'status' && method === 'POST')
    return ok(plugins.setStatus(seg[2], body.status));

  if (p === '/api/public') {
    const proposals = store.listAccounts().flatMap(a => store.listProposals(a.id)).map(pr => ({
      // Since S-8 this is all we CAN show, not all we chose to. The summary and
      // the per-signer approval list were the deanonymised version of what the
      // chain blinds on purpose.
      id: pr.id, accountId: pr.accountId, digest: pr.digest, status: pr.status,
      approvalCount: pr.approvalCount,
      sealed: { iv: pr.sealed.iv, body: pr.sealed.body.slice(0, 48) + '...' },
      txRef: pr.txRef ?? null,
    }));
    /* Not on the `Ledger` boundary — see `src/wiring/selection.ts`. */
    return ok({ ...observerView(ledger), proposals });
  }

  // /api/accounts/:id/...
  if (seg[1] === 'accounts' && seg[2]) {
    const id = seg[2];
    // The same membership gate the server applies. Without it the standalone
    // build would be a weaker product than the hosted one, and the demo would
    // stop telling the truth about how isolation works.
    accounts.requireMember(id, (await caller(init)));
    // Method must be part of every match. A branch that ignores it will swallow
    // the POST that shares its path, which is exactly what happened here once.
    if (seg[3] === 'state' && method === 'GET') return ok(await accounts.readState(id, q.get('viewingKey') ?? ''));
    if (seg[3] === 'proposals' && method === 'GET') return ok(store.listProposals(id));
    if (seg[3] === 'runs' && method === 'GET') return ok(store.listRuns(id));
    // `deposit` STOOD HERE. The account keeps no book, so there is
    // nothing to deposit into. Removed on both servers in the same turn — a
    // route the hosted build refuses and the standalone build answers is `T-11`.
    if (seg[3] === 'attest-solvency' && method === 'POST')
      return ok(await payroll.attestSolvency(
        id, body.viewingKey, body.asset, money(body.asset, body.threshold)));
    if (seg[3] === 'people' && method === 'GET')
      /* `handedOver` beside each row, exactly as the served build answers it —
       * The one place the compiler cannot see is the one place two
       * implementations diverge, and this file has been caught by that
       * before. */
      return ok(payroll.listPeople(id, body.viewingKey)
        .map(p => ({ ...p, handedOver: payroll.hasHandover(p.id) })));
    if (seg[3] === 'people' && method === 'POST')
      return ok(payroll.invite(id, {
        name: body.name, email: body.email, title: body.title,
        asset: body.asset,
        baseAmount: money(body.asset, body.salary),
        startDate: body.startDate,
      }, body.viewingKey, await caller(init)));
    if (seg[3] === 'invites' && seg[4] === 'signer' && method === 'POST')
      return ok(accounts.inviteSigner(id, body.name, body.email, body.role));
    /*
     * NO TOKENS. A-10, and this build was missed on the first pass — the hosted
     * route stopped returning them and this one carried on, which is the second
     * implementation of an API drifting from the first while both typecheck.
     */
    if (seg[3] === 'invites' && method === 'GET')
      return ok(store.listInvites(id).map(({ token, ...rest }) => ({
        ...rest, redeemed: Boolean(rest.acceptedAt),
      })));
    if (seg[3] === 'plugins' && method === 'GET') return ok(plugins.installed(id));
    if (seg[3] === 'plugins' && method === 'POST')
      return ok(plugins.install({ accountId: id, ...body }));
    if (seg[3] === 'plugin-events' && method === 'GET') return ok(plugins.events(id));
    if (seg[3] === 'grant' && method === 'POST')
      return ok(await accounts.grantAccess(id, body.viewingKey, body.signerId));
    if (seg[3] === 'runs' && method === 'POST')
      return ok(await payroll.createRunFromRoster(id, body.period, body.viewingKey, body.employeeIds));
    if (!seg[3]) return ok(accounts.require(id));
  }

  if (seg[1] === 'invites' && seg[3] === 'accept-signer' && method === 'POST')
    // No `body.blinding`. M-106: an invitee's blinding factor never leaves
    // their device, so there is no parameter here to receive one.
    return ok(accounts.acceptSignerInvite(seg[2], (await caller(init)), body.signingPublicKey,
      body.wrappingPublicKey, body.leafCommitment));
  if (seg[1] === 'invites' && seg[3] === 'offer' && method === 'GET')
    return ok(payroll.offerFor(seg[2]));

  if (seg[1] === 'invites' && seg[3] === 'accept-employee' && method === 'POST') {
    /*
     * **THIS DOOR IS CLOSED IN THE STANDALONE BUILD, FOR THE REASON
     * `self-payee` IS.**
     *
     * It took `body.address` as a bech32 string — the address typed into a box
     * — and sealed it here. `X11` moved that seal onto the invitee's own
     * device: the browser asks the wallet for the address, checks it, seals it
     * to the company's inbox key and posts a blob. **This file IS the page**,
     * so there is no seam between the two halves to move anything across, and
     * there is no wallet in this build to ask.
     *
     * The honest options were to keep taking a typed address in a second place,
     * or to refuse and say so — and taking a typed address is the thing this
     * round exists to delete. `C150` says the standalone build is not this
     * round's work, so it refuses rather than growing half a flow.
     *
     * **A HANDOVER, NOT A KEY** — the note this replaces recorded a real defect
     * from 17 Aug, where `body.wrappingPublicKey` was passed where the handover
     * goes and typechecked because `body` is `any`. That trap is now impossible
     * here in the only way that lasts: there is nothing to pass.
     */
    return bad(
      'accepting an invitation needs your own wallet to hand over the address your salary is '
      + 'paid to, and the acceptance is sealed to the company on your own device before it is '
      + 'sent. This build has no wallet and nothing to seal across, so the step is not '
      + 'available here — open the link in the served application.');
  }

  if (seg[1] === 'accounts' && seg[3] === 'self-payee' && method === 'POST') {
    /*
     * **THIS DOOR IS CLOSED IN THE STANDALONE BUILD, AND CLOSING IT IS THE
     * POINT.**
     *
     * It took the payee's address as PASTED TEXT, exactly as the served build
     * did, and `X7` said in as many words that pasting is safe on that one door
     * and **is a precedent that must not spread.** The served build no longer
     * has it: the address arrives inside a signed disclosure and the SERVER
     * checks it, because a check made in the page being persuaded is not a
     * check.
     *
     * **THERE IS NO SERVER HERE.** This file IS the page. So the honest options
     * were to keep taking a typed address in a second place, or to refuse and
     * say so — and the first is the one thing this round exists to delete. The
     * standalone build is `C150` and is explicitly not this round's work, so
     * this refuses rather than growing a verifier that nothing here has yet
     * argued the shape of.
     *
     * The membership gate stays above the refusal on purpose: a door that says
     * *not built* to a stranger and *not built* to a member is telling both the
     * same thing, and the gate is what stops it becoming an enumerator later.
     */
    const who = await caller(init);
    accounts.requireMember(seg[2], who);
    return bad(
      'adding yourself to payroll needs your wallet to hand over your receiving address, '
      + 'and that is checked where the record is written. This build has no server to '
      + 'check it, so the step is not available here — use the served application.');
  }

  if (seg[1] === 'employees' && seg[3] === 'admit' && method === 'POST')
    return ok(payroll.admit(seg[2], body.viewingKey, await ownsPerson(seg[2], init)));

  if (seg[1] === 'people' && seg[3] === 'status' && method === 'POST') {
    await ownsPerson(seg[2], init);
    return ok(payroll.setStatus(seg[2], body.status, body.viewingKey));
  }

  // /api/proposals/:id/approve
  if (seg[1] === 'proposals' && seg[3] === 'approve' && method === 'POST') {
    /*
     * **THE SAME REFUSAL THE SERVED BUILD MAKES.**
     *
     * There is no network in this build, so a secret in this body would not
     * cross one — which is exactly the argument that would let the two doors
     * drift apart until the standalone one is the lenient example somebody
     * copies. The signature is made in the keyring either way, and a body that
     * still carries a key is a client that has not been changed yet.
     */
    if (body && typeof body === 'object' && 'signingSecret' in body) {
      return bad(
        'this endpoint does not accept a signing secret. An approval is a signature '
        + 'made on the signer\'s device over the proposal digest. Send `signature`.');
    }
    return ok(await accounts.approve(seg[2], body.signerId, body.signature, body.viewingKey));
  }

  // /api/runs/:id/...
  if (seg[1] === 'runs' && seg[2]) {
    const runId = seg[2];
    if (seg[3] === 'propose' && method === 'POST') {
      /*
       * **THE SAME MATERIAL THE HOSTED ROUTE BUILDS, BUILT THE SAME WAY.** A
       * route one build answers and the other refuses is the drift this file
       * exists to prevent, and a run raised here has to be payable by the same
       * vault at the same window as one raised there.
       *
       * The window's shape is checked here because there is no network in this
       * build and therefore no schema layer, and `BigInt('')` throws a syntax
       * error rather than saying what was wanted. **The vault's width is NOT
       * checked here**: that rule lives in one place, beside the payout root's,
       * so both builds and every other propose surface give the same answer.
       */
      if (!/^[0-9]+$/.test(String(body.opensAt ?? ''))
          || !/^[0-9]+$/.test(String(body.closesAt ?? ''))) {
        return bad('a run\'s window is two whole numbers of seconds since the Unix epoch — '
          + 'seconds, because that is what block time is compared against.');
      }
      const inputs = await payroll.runMaterialInputs(runId, body.viewingKey, body.asset);
      const material = await runMaterialFor({
        accountId: inputs.accountId,
        runId: inputs.runId,
        seeds: inputs.seeds,
        facts: inputs.facts,
        opensAt: BigInt(String(body.opensAt)),
        closesAt: BigInt(String(body.closesAt)),
        vault: String(body.vault) as Hex,
      });
      return ok(await payroll.proposeRun(
        runId, body.viewingKey, body.proposedBy, material, body.asset));
    }
    // `settle` STOOD HERE. No balance, no `PayrollService.settle`.
    // Removed on both servers in the same turn — a route the hosted build
    // refuses and the standalone build answers is `T-11`.
    /* **THE SAME PAYMENT VIEW THE HOSTED BUILD ANSWERS**, so a route one build
     * answers and the other refuses cannot arise here. On this build the ledger
     * records no payments at all, and the view says so in those words rather
     * than reporting a payroll in which nobody was paid. */
    if (seg[3] === 'payments' && method === 'POST') {
      const viewingKey = body.viewingKey ?? '';
      const run = payroll.requireRun(runId, viewingKey);
      /* Verified against the approved run, exactly as the hosted route is: the
       * id is rebuilt from the leaves in hand and a list that belongs to
       * another payroll is refused rather than reported on. */
      const material = payroll.payoutMaterialOf(
        runId, viewingKey, { asset: body.asset, rootOf: rootOfLeaves });
      const among = material ? await ledger.paidAmong(run.accountId, material.leaves) : null;
      return ok(runPayments(material, among));
    }
    if (seg[3] === 'attest' && method === 'POST')
      return ok(await payroll.attestPayrollTotal(runId, body.viewingKey, body.asset ?? q.get('asset')));
    if (seg[3] === 'employee' && seg[4])
      return ok(payroll.employeeView(runId, seg[4], q.get('secret') ?? ''));
  }

  // /api/attestations/:id/verify
  if (seg[1] === 'attestations' && seg[3] === 'verify')
    return ok({ valid: await payroll.verifyAttestation(seg[2]) });

  return bad(`no route for ${method} ${p}`);
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input?.url ?? String(input);
  const url = new URL(href, location.origin);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  try {
    return await route(url, init);
  } catch (e: any) {
    const m = e?.message ?? 'unknown error';
    // Session failures must be 401 so the client signs out rather than showing
    // a stale screen with a dead token.
    // One message covers every way a session can be no good — see the note on
    // IdentityService.verify — so this pattern is now the whole of it.
    const auth = /not signed in/.test(m);
    return bad(m, auth ? 401 : 400);
  }
}) as typeof fetch;

/*
 * The page is handed the SAME commitment scheme this build's ledger was built
 * with. Before this it imported one directly and there was no argument to
 * change: an invited signer's leaf was computed under the simulated scheme
 * whatever the ledger underneath was.
 */
createRoot(document.getElementById('root')!).render(<App commitments={chosen.commitments} />);
