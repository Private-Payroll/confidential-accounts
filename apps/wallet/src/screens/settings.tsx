import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Secret } from 'midnight-identity';
import { INDEXER_HOST, NETWORK, ORIGIN, RP_ID } from '../config.js';
import { NODE_RPC_URL } from '../chain/facade.js';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { StorageError, allPasskeys, arrivalOf, creationOf, loadSecuredSetup } from '../accounts/storage.js';
import type { SecuredSetup } from '../accounts/storage.js';
import { loadTermsSeen } from '../chain/terms.js';
import { MAIN_ACCOUNT, displayNameOf } from '../accounts/subwallets.js';
import { renameThisWallet, useWallets } from '../shell/wallets.js';
import { ThemePicker, useTheme } from '../shell/theme.js';
import { day, verifiedWords } from '../components/piece-map.js';
import type { Passkey } from 'midnight-identity/passkey/verify';
import {
  Alert, Badge, Button, ButtonLink, Card, CardContent, GLYPH, Icon, Input, Label,
  ListRow, ListRows, Section,
} from '../kit/index.js';

/**
 * SETTINGS — almost nothing here is new capability.
 *
 * THE RULE: *"It is facts and controls that already exist and are
 * buried, unreachable, or offered only from an error screen."* Seven sections,
 * and six of them are `storage.ts` and `config.ts` read out loud. The seventh
 * — the danger section — is a door that until now existed only on `broken`,
 * so a healthy wallet had no way to a clean slate and a tester cleared browser
 * storage by hand.
 *
 * ONE PAGE, SECTIONS IN A COLUMN, NOT TABS. The change's own words for why:
 * *"a tab is a place to hide a section, and what comes after is where
 * a hidden thing quietly becomes an unreachable one."* If a section grows a
 * ceremony it becomes a route of its own, the way `secure` already is.
 *
 * WHAT THIS SCREEN READS AND WHAT IT REFUSES TO:
 *
 *   **It reads no money.** Not a balance, not a STAR, not a SPECK, not an
 *   indexer. The design freezes the money card for later and the deferral
 *   is only free while nothing else learns to read what money exists — so this
 *   screen never asks. Nothing in this file imports `balance.ts`, `amount.ts`,
 *   `dust.ts` or `unshielded.ts`, and the danger section's two warnings differ
 *   by whether the account is SECURED, never by what it holds.
 *
 *   **It reimplements no ceremony.** Re-cutting links to `secure`; pairing is
 *   Home's row and `add-device`'s screen; recovery is not offered from an
 *   unlocked wallet at all. This section composes and links.
 *
 *   **It shows no address.** `ownedAddressFor` is the one door from a slot to
 *   a renderable address and it carries its owner; a settings page has
 *   no reason to open that door, so it does not, and there is one fewer
 *   surface where a name could arrive without its slot.
 */

export function Settings({ secret }: { readonly secret: Secret }): ReactNode {
  const { names, account, wallet } = useWallets(secret);
  const name = displayNameOf(account, names);
  /* WHAT THE DANGER SECTION ASKS FOR IS NOT WHAT THE REST OF THIS PAGE
   * SHOWS, AND THAT IS THE POINT. `name` is the OPEN wallet; `mainName` is
   * account 0's, which is what the whole account is called. `displayNameOf`
   * falls back to the slot's own fixed name when nobody has renamed it, so
   * this string always exists. */
  const mainName = displayNameOf(MAIN_ACCOUNT, names);
  const secured = loadSecuredSetup(secret);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="m-0">Settings</h1>

      <ThisWallet secret={secret} name={name} wallet={wallet} />
      <Backup setup={secured} arrivedAt={secured === null ? arrivalOf(secret)?.at ?? null : null} />
      <Passkeys />
      <NetworkAndHosts />
      <AddressBookRow />
      <YourDetailsRow />
      <AgentRow />
      <AdvancedRow />

      {/*
        * LAST IN THE DOCUMENT, WHICH IS THE KEYBOARD REQUIREMENT AS WELL AS
        * THE VISUAL ONE. THE RULE: *"bottom of the page, visually
        * apart, and never the target of a stray keyboard path — it is the last
        * thing tabbed to, not the first."* Being last in the DOM is what makes
        * that true of Tab as well as of the eye, and the button inside is
        * `disabled` until the name is typed, so until then it is not a tab
        * stop at all.
        */}
      <DangerSection secret={secret} account={mainName} secured={secured !== null} />
    </div>
  );
}

/* ------------------------------------------------- §1 this wallet, this device */

/**
 * WHICH ACCOUNT IS OPEN, WHEN THIS BROWSER GOT IT, THE THEME — AND THE
 * SENTENCE ABOUT REVOCATION THAT THIS SCREEN IS THE ONE THAT OWES.
 *
 * THE DEVICE SENTENCE IS UNCHANGED IN SUBSTANCE: one of two true
 * sentences, or nothing. `creationOf` and `arrivalOf` are both fingerprint-
 * bound, creation wins over arrival because it is the older fact, and
 * **a recovery stamps neither, so this browser says nothing** — which is the
 * whole point of it. A card that called a recovery a creation would tell
 * somebody who had just rebuilt an old account that it began on the machine
 * they rebuilt it onto.
 *
 * AND THERE IS NO DEVICE LIST, WHICH IS A DECISION AND NOT A GAP.
 * THE RULE: *"this wallet cannot know how many devices hold
 * this account, and must not appear to."* There is no registry, pairing leaves
 * the two machines no channel at all, and there is **no revocation anywhere in
 * `src/`**. A row is open and says rotation does not lock out a stolen device,
 * *"which is the one case everybody assumes it is for"* — and **a device list
 * is exactly the component that makes a person assume revocation exists.**
 * The screen that talks about devices is the screen that
 * must say so plainly.
 */
function ThisWallet({ secret, name, wallet }: {
  readonly secret: Secret;
  readonly name: string;
  /** The name of the WHOLE wallet, or null. `name` above is the OPEN
   * ACCOUNT's, and the two rows below say which is which in their own words,
   * because a page that shows both must not let a reader swap them. */
  readonly wallet: string | null;
}): ReactNode {
  const made = creationOf(secret);
  const linked = arrivalOf(secret);
  const { theme, choice, setChoice } = useTheme();
  return (
    <Section
      title="This wallet, this device"
      description="What is open here, how it got here, and how this browser looks."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <WalletNameRow secret={secret} wallet={wallet} />
            <ListRow
              leading={<Icon glyph={GLYPH.wallet} className="text-muted" />}
              title="Wallet open"
              subtitle="Switch wallets from the account chip"
              trailing={<span className="font-medium">{name}</span>}
            />
            <ListRow
              leading={<Icon glyph={GLYPH.home} className="text-muted" />}
              title="This browser"
              /* Three states, and the third one is silence. */
              trailing={
                <span className="font-normal text-muted">
                  {made
                    ? `Created here on ${day(made.at)}`
                    : linked
                      ? `Linked on ${day(linked.at)}`
                      : 'No record of when it arrived'}
                </span>
              }
            />
            <ListRow
              leading={<Icon glyph={GLYPH.themeSystem} className="text-muted" />}
              title="Theme"
              subtitle="The same control that is in the sidebar"
              trailing={<ThemePicker choice={choice} theme={theme} onChoose={setChoice} />}
            />
          </ListRows>
        </CardContent>
      </Card>

      <Alert tone="info" role={null} title="There is no way to throw a device off.">
        <p className="m-0">
          A device that has this account keeps it. Pairing hands the account to another
          machine and the two are then strangers — there is no register of them, no
          channel between them, and nothing in this wallet can take an account back off
          a machine that already holds it.
        </p>
        <p className="mt-2 mb-0">
          So the answer to a lost or stolen device is not to revoke it. It is to{' '}
          <a className="text-accent underline-offset-4 hover:underline" href={hrefOf('send')}>
            move the money
          </a>{' '}
          to a wallet that machine does not have.
        </p>
      </Alert>
    </Section>
  );
}

/**
 * THE WALLET'S OWN NAME, AND THE ONE SENTENCE THIS CONTROL OWES.
 *
 * **RENAMING WORKS HERE AND DOES NOT REACH THE PASSKEY.** A credential's
 * label was fixed by what `navigator.credentials.create` was given when it
 * was made, and no web application can change a saved passkey's name — only
 * the browser or the password manager can. So the form says so, once, at the
 * point of renaming. A rename screen that implied otherwise would be telling
 * a person their browser's chooser had been put right when it had not, which
 * is the same class of lie as a comment claiming privacy over a line that
 * hands the key away.
 *
 * IT NAMES THE SECRET, NOT THE OPEN ACCOUNT. The row under this one is the
 * account that is open; this is the wallet all eleven of them live in, and
 * the subtitle says so rather than leaving a reader to guess which of two
 * adjacent names they are editing. The account rename is on Home's hero card
 * and is untouched.
 */
function WalletNameRow({ secret, wallet }: {
  readonly secret: Secret;
  readonly wallet: string | null;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <>
      <ListRow
        leading={<Icon glyph={GLYPH.rename} className="text-muted" />}
        title="This wallet's name"
        subtitle="Covers every account in the switcher, not just the open one"
        trailing={(
          <span className="flex items-center gap-2">
            <span className="font-medium" data-whole-wallet="">
              {wallet ?? 'Not named'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              /* Deliberately NOT "Rename this wallet": Home's pencil already
               * carries that label and it renames the open ACCOUNT. Two
               * controls with one accessible name is the confusion this change
               * is about, spoken aloud. */
              aria-label={wallet === null
                ? 'Give this wallet a name'
                : "Change this wallet's name"}
              aria-expanded={editing}
              onClick={() => {
                setDraft(wallet ?? '');
                setEditing((now) => !now);
              }}
            >
              <Icon glyph={GLYPH.rename} className="size-4" />
            </Button>
          </span>
        )}
      />
      {editing && (
        <form
          className="flex flex-col gap-2 rounded-tight border border-line bg-sunken p-3"
          onSubmit={(e) => {
            e.preventDefault();
            renameThisWallet(secret, draft);
            setEditing(false);
          }}
        >
          <Label htmlFor="whole-wallet-rename">A name for this wallet</Label>
          <Input
            id="whole-wallet-rename"
            value={draft}
            maxLength={24}
            placeholder="e.g. “Rent money”, “Company”"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm">Save the name</Button>
            <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
          <p className="m-0 text-xs text-faint">
            This changes the name inside the wallet only. <strong>Your browser&rsquo;s
            passkey list keeps the name it already has</strong> — a passkey&rsquo;s
            label is fixed when it is made and nothing here can change it; only your
            browser or password manager can rename a saved passkey. A name given to a
            passkey made from now on will be this one. Leave it empty to have no name.
          </p>
        </form>
      )}
    </>
  );
}

/* --------------------------------------------------------- §2 security, in full */

/**
 * THE BACKUP, IN FULL — Home's Set-up card is the summary and this is the
 * record.
 *
 * `rebuiltAt` IS THE ONE THAT IS EASY TO TURN INTO A LIE. §7.12
 * defines it as a real rebuild from real pieces, never the act of placing
 * them, and `saveSecuredSetup` performs the rebuild it is about to claim
 * rather than taking a caller's word for it. **It is a dated PAST fact and
 * may never be phrased as "you are safe"** — so the line below says what
 * happened and when, and says nothing at all about today.
 *
 * THREE STATES PER PIECE, NOT TWO. `verifiedWords` is the one place
 * those three sentences live, and this screen calls it rather than writing a
 * fourth copy of them: a number is when the home last answered, `'never'` is
 * a home that could be asked and has not been, and `null` is a home that
 * cannot be asked, ever — paper.
 *
 * `partial` IS SAID OUT LOUD, NOT IMPLIED BY SILENCE. A recovery
 * writes this record from the pieces the person actually fetched, and there
 * may be others this browser has never heard of.
 *
 * AND RE-CUTTING ADDS A WAY IN AND NEVER REMOVES ONE — the sentence
 * people get wrong. Old pieces rebuild the same secret for as long as they
 * exist and nothing in Shamir can switch them off.
 */
function Backup({ setup, arrivedAt }: {
  readonly setup: SecuredSetup | null;
  readonly arrivedAt: number | null;
}): ReactNode {
  if (setup === null) {
    return (
      <Section
        title="Security"
        description="Where the pieces that rebuild this account are, and when they were last proved."
      >
        <Card>
          <CardContent className="pt-5">
            <p className="m-0 text-sm text-muted">
              {arrivedAt !== null
                ? 'This browser holds no record of any pieces. This account arrived here from '
                  + `another device on ${day(arrivedAt)}, and whether it is secured is written `
                  + 'there rather than here — this browser cannot tell, and does not guess.'
                : 'This browser holds no record of any pieces. If nobody has cut this account '
                  + 'into pieces and placed them, then losing this device loses the money in it, '
                  + 'and nobody can put it back — including us.'}
            </p>
            <p className="m-0 mt-4">
              <ButtonLink variant="primary" href={hrefOf('secure')}>
                Cut this account into pieces
              </ButtonLink>
            </p>
          </CardContent>
        </Card>
      </Section>
    );
  }

  const ownOld = setup.superseded.filter((old) => old.fingerprint === setup.fingerprint);
  const foreignOld = setup.superseded.filter((old) => old.fingerprint !== setup.fingerprint);

  return (
    <Section
      title="Security"
      description="Where the pieces that rebuild this account are, and when they were last proved."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <ListRow
              leading={<Icon glyph={GLYPH.secured} className="text-muted" />}
              title="How many pieces put it back"
              subtitle="The quorum, taken off the pieces themselves"
              trailing={
                <span className="font-medium">
                  Any {setup.threshold} of {setup.pieces.length}
                </span>
              }
            />
            <ListRow
              leading={<Icon glyph={GLYPH.success} className="text-muted" />}
              title="Last proved"
              subtitle="The last time it was actually rebuilt from real pieces"
              trailing={<span className="font-medium">{day(setup.rebuiltAt)}</span>}
            />
          </ListRows>

          {/* §7.12, said rather than implied. */}
          <p className="m-0 mt-3 text-xs text-faint">
            That is a dated past fact and nothing more. It is not a statement about today,
            and it is not the day the pieces were placed — it is the day the account was
            put back together from them and the result matched.
          </p>

          {setup.partial && (
            <Alert
              tone="warning"
              role={null}
              className="mt-4"
              title="This list names only the pieces this browser has seen."
            >
              The record was written by a recovery, from the pieces that were actually
              fetched and used. There may be others placed elsewhere that this browser has
              never heard of, and their absence below says nothing about them.
            </Alert>
          )}

          <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Where the pieces are</h3>
          <div>
            {setup.pieces.map((piece) => (
              <div className="piece-row" key={`${piece.holder}:${piece.label}`}>
                <span className="who">{piece.label}</span>
                {piece.holder !== piece.label
                  && <span className="faint small">{piece.holder}</span>}
                <span
                  className={typeof piece.lastVerified === 'number' ? 'verified' : 'verified never'}
                >
                  {verifiedWords(piece.lastVerified)}
                </span>
              </div>
            ))}
          </div>
          <p className="m-0 mt-3 text-xs text-faint">
            A piece that <em>cannot be checked</em> is not a piece that failed a check — paper
            cannot answer, ever, and that is its honest permanent answer. A piece that has{' '}
            <em>not yet been checked</em> is one that could be asked and has not been.
          </p>

          {ownOld.length > 0 && (
            <Alert
              tone="warning"
              role={null}
              className="mt-4"
              title={ownOld.length === 1
                ? 'An earlier set was replaced, and its pieces still work.'
                : `${ownOld.length} earlier sets were replaced, and their pieces still work.`}
            >
              <p className="m-0">
                Cutting a fresh set <strong>adds</strong> a way in and never removes one. The
                pieces below rebuild this account for as long as they exist, and nothing can
                switch them off.
              </p>
              {ownOld.map((old) => (
                <p className="mt-2 mb-0 text-xs text-faint" key={old.supersededAt}>
                  Replaced {day(old.supersededAt)} (any {old.threshold} of {old.pieces.length}):{' '}
                  {old.pieces.map((piece) => piece.label).join('; ')}
                </p>
              ))}
            </Alert>
          )}

          {foreignOld.length > 0 && (
            /* A kept map is only this account's history if its
             * fingerprint says so. The rest is a different account's map, kept
             * because destroying a map is never this wallet's call. */
            <p className="m-0 mt-4 text-sm text-muted">
              A different account&rsquo;s piece list is also on file in this browser. Its
              pieces do <strong>not</strong> open this account:{' '}
              {foreignOld.flatMap((old) => old.pieces.map((piece) => piece.label)).join('; ')}.
            </p>
          )}

          <p className="m-0 mt-5">
            <ButtonLink variant="secondary" href={hrefOf('secure')}>
              Re-verify or cut a fresh set
            </ButtonLink>
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ §3 passkeys */

/**
 * THE PASSKEYS — the one genuinely new surface in this change, and the most
 * valuable.
 *
 * `allPasskeys()` has recorded all of this and nothing has ever
 * shown it anywhere. **THE SENTENCE THIS SECTION EXISTS TO SAY:** a passkey
 * that does not sync to a cloud is gone with the device that holds it. A
 * tester with a hardware-bound credential and no backup should learn that
 * here, in advance, rather than afterwards — and in those terms, what happens
 * if this device disappears, never in WebAuthn's.
 *
 * `syncsToACloud` IS "COULD BE COPIED" AND `backedUpNow` IS "IS COPIED", and
 * they are the WebAuthn BE and BS flags in plain English (`passkey/verify.ts`).
 * Three states, three different sentences, and the dangerous one is red
 * because it is the one this section is for.
 *
 * `provenBySignIn` IS NOT DECORATION. A registration carries no
 * signature (`attestation: 'none'`), so a credential that has never signed
 * anything has never demonstrated that anybody holds the private half; a
 * credential recorded with the wrong public key registers happily and can
 * never sign in again. One completed sign-in is what turns it true, and the
 * difference is shown rather than averaged away.
 *
 * `signCount` IS PRINTED ONLY WHEN IT IS NON-ZERO, because zero means the
 * authenticator does not count — *"Zero means it does not count"*, the type's
 * own words — and printing "0 sign-ins" over a credential that has signed in
 * a dozen times would be a wrong fact rather than a missing one.
 *
 * SHOW, DO NOT REMOVE — decided 21 Aug, and the screen says so rather
 * than leaving a tester hunting for a control that is not there. Removing the
 * last passkey locks a person out of the account on this device, and that
 * guard deserves designing rather than passing.
 *
 * **BUILT SO REMOVAL IS ADDITIVE LATER, WHICH IS ONE REQUIREMENT AND NOT A
 * DESIGN**: every row is keyed on `credentialId`, and the
 * state that a control will sit beside is in `ListRow`'s existing `trailing`
 * slot. `forgetPasskey` already exists in `storage.ts`. Done this way, adding
 * removal later is a control and a guard; done any other way it is a rewrite
 * of the list.
 *
 * DAMAGE IS A STATE, NOT AN EMPTY LIST. `allPasskeys()` THROWS on a
 * record it cannot read, and catching that into `[]` would tell somebody with
 * a healthy keyring that they have no passkeys. The storage's own sentence is
 * shown verbatim instead.
 */
const shortCredential = (id: string): string =>
  (id.length > 16 ? `${id.slice(0, 7)}…${id.slice(-6)}` : id);

interface CloudState {
  readonly words: string;
  readonly tone: 'sent' | 'warning' | 'failed';
}

/** The three states of the two backup flags, as three different sentences. */
export function cloudStateOf(passkey: Passkey): CloudState {
  if (!passkey.syncsToACloud) return { words: 'this device only', tone: 'failed' };
  if (!passkey.backedUpNow) return { words: 'no cloud copy yet', tone: 'warning' };
  return { words: 'copied to your cloud account', tone: 'sent' };
}

function Passkeys(): ReactNode {
  /* This card lists the passkeys of the wallet that is OPEN, which
   * is the only wallet this screen is about. Read during render. */
  const { walletId } = useSession();
  let passkeys: readonly Passkey[] = [];
  let damaged: string | null = null;
  try {
    passkeys = allPasskeys(walletId);
  } catch (e) {
    /* The storage's own words, which say what was found and what to do. */
    damaged = e instanceof StorageError ? e.message : String(e);
  }

  const strandable = passkeys.filter((passkey) => !passkey.syncsToACloud);
  const unproven = passkeys.filter((passkey) => !passkey.provenBySignIn);

  return (
    <Section
      title="Passkeys"
      description="What opens this wallet on this device, and what happens to each one if the device disappears."
    >
      {damaged !== null && <Alert tone="danger" title="This browser cannot read its passkey record.">{damaged}</Alert>}

      {damaged === null && passkeys.length === 0 && (
        <Card>
          <CardContent className="pt-5">
            <p className="m-0 text-sm text-muted">
              No passkeys are recorded in this browser.
            </p>
          </CardContent>
        </Card>
      )}

      {damaged === null && passkeys.length > 0 && (
        <Card>
          <CardContent className="pt-5">
            <ListRows>
              {passkeys.map((passkey) => {
                const cloud = cloudStateOf(passkey);
                return (
                  /* KEYED ON `credentialId` — the design's one
                   * requirement, so a row keeps its identity when a control
                   * is added beside its state later. */
                  <ListRow
                    key={passkey.credentialId}
                    leading={<Icon glyph={GLYPH.passkey} className="text-muted" />}
                    title={<span className="font-mono">{shortCredential(passkey.credentialId)}</span>}
                    subtitle={`Bound to ${passkey.rpId}`}
                    trailing={<Badge tone={cloud.tone}>{cloud.words}</Badge>}
                    meta={passkey.provenBySignIn
                      ? (passkey.signCount > 0
                        ? `has signed in · counter at ${passkey.signCount}`
                        : 'has signed in')
                      : 'never signed in'}
                  />
                );
              })}
            </ListRows>
            {/*
              * THE LABEL ABOVE CANNOT BE CHANGED FROM HERE, AND THE
              * THING THAT ACTUALLY SAVES THE WALLET IS NOT THE LABEL.
              *
              * A passkey's label is fixed by the browser or the password
              * manager at the moment the credential is made. No web
              * application may rename a saved credential afterwards — not
              * this one, not any. The wallet's name went into the label
              * of every credential made from then on; every credential made
              * BEFORE that reads `Midnight wallet`, `new passkey <date>` or
              * `recovered <date>` for ever, and there is no migration for it
              * because there is no API for it.
              *
              * THE LOSS IS CONCRETE: somebody tidying a password manager
              * deletes the only credential for a wallet whose pieces were
              * never cut, and the money is then reachable only through the
              * sealed copy in this one browser.
              *
              * SO IT IS SAID HERE, WHERE THE CREDENTIAL IS ALREADY ON SCREEN,
              * and it is a statement rather than a warning: nothing has gone
              * wrong, and a colour would say something had. **NO OFFER IS
              * MADE TO RENAME IT.** The same rule applies to renaming a
              * wallet — an offer the product cannot honour is worse than
              * silence, because a person acts on an offer.
              *
              * IT IS UNCONDITIONAL OVER THE LIST, AND THAT IS FORCED. Nothing
              * in `StoredPasskey` (`storage.ts:1178`) records the label a
              * credential was made with or the date it was made, so this
              * wallet cannot tell a named credential from an unnamed one.
              * Adding either would change what a credential is, which this
              * change is not allowed to do. Both sentences below are true of
              * every credential regardless, so saying them over all of them
              * costs a named credential nothing.
              */}
            <p className="mt-4 mb-0 text-sm text-muted">
              The name your password manager shows for each of these was fixed when the
              credential was made — a browser writes it then, and nothing in this wallet
              can change it afterwards. Some carry this wallet&rsquo;s name and some say
              only <span className="font-mono">Midnight wallet</span>, depending on when
              they were made.
            </p>
            <p className="mt-2 mb-0 text-sm text-muted">
              What makes this wallet survive losing one of them is not its name.{' '}
              <strong>Cutting recovery pieces is what does that</strong> — pieces put this
              wallet back on another machine whatever becomes of the credentials above.
            </p>
          </CardContent>
        </Card>
      )}

      {strandable.length > 0 && (
        <Alert
          tone="warning"
          role={null}
          title={strandable.length === passkeys.length
            ? 'If this device disappears, nothing above comes back with it.'
            : 'If this device disappears, one of these does not come back with it.'}
        >
          <p className="m-0">
            A passkey marked <strong>this device only</strong> lives in this machine and
            nowhere else — it is not the kind that can be copied into an Apple or Google
            account. A new phone signed into the same account will not find it, because
            there is nothing there to find.
          </p>
          <p className="mt-2 mb-0">
            That is not a reason to worry if your account is secured: pieces put the account
            back on any machine, and a new passkey is made there. It <em>is</em> the reason
            the pieces matter.
          </p>
        </Alert>
      )}

      {unproven.length > 0 && (
        <Alert
          tone="info"
          role={null}
          title="“Never signed in” means something specific."
        >
          Making a passkey proves nothing about it. Nothing is signed at registration, so a
          credential recorded wrongly registers perfectly happily and then can never open
          anything again. A passkey that has signed in once has demonstrated that somebody
          holds its private half; one that has not, has not.
        </Alert>
      )}

      <p className="m-0 text-xs text-faint">
        There is deliberately no way to remove a passkey here yet. Removing the last one
        locks this account out of this browser, and that guard is worth designing rather
        than passing.
      </p>
    </Section>
  );
}

/* -------------------------------------------------------- §4 network and hosts */

/**
 * READ-ONLY, ALL OF IT — AND THE TWO REFUSALS HAVE DIFFERENT REASONS.
 *
 * **No network switcher.** `config.ts`: `NETWORK` is one constant, never
 * derived from a hostname or a build flag, because the network name is a
 * segment of every address string — so **a wallet that displays one network
 * while signing for another is discovered by somebody else's money.**
 *
 * **No editable indexer field.** An indexer a person can point anywhere is an
 * indexer whose operator gets handed every address they own.
 *
 * Both are money. Neither is a preference. This is the screen somebody looks
 * at when a balance seems wrong, and what it owes them is the truth about
 * which hosts are dialled — the same debt the live send card pays when it
 * names every host a send can reach.
 *
 * THE HOSTS ARE READ FROM THE CONSTANTS THEMSELVES, never retyped here. A
 * second copy of a hostname is a second thing to keep true.
 */
function NetworkAndHosts(): ReactNode {
  const terms = loadTermsSeen();
  return (
    <Section
      title="Network and hosts"
      description="What this wallet is connected to. All of it is fixed, and none of it is a preference."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <ListRow
              leading={<Icon glyph={GLYPH.network} className="text-muted" />}
              title="Network"
              subtitle="Part of every address this wallet shows"
              trailing={<span className="font-mono">{NETWORK}</span>}
            />
            {/* THE SUBTITLES ARE SHORT BECAUSE `ListRow` TRUNCATES THEM, and
              * a sentence that carries the privacy trade must not end in an
              * ellipsis. `kit/list-row.tsx` truncates on purpose — a row grows
              * otherwise — and Home's own rows are commented with the same
              * rule: *"the full sentence lives on the screen each one leads
              * to."* These rows lead nowhere, so the full sentences are in the
              * paragraph under the card instead, where nothing clips them.
              * Found by looking at the first screenshot of this screen. */}
            <ListRow
              title="Balances are read from"
              subtitle="Only when you ask"
              trailing={<span className="font-mono break-all">{INDEXER_HOST}</span>}
            />
            <ListRow
              title="Payments are submitted through"
              subtitle="Only when you send"
              trailing={<span className="font-mono break-all">{new URL(NODE_RPC_URL).host}</span>}
            />
            <ListRow
              title="Proof key material comes from"
              subtitle="Checked against pinned fingerprints"
              trailing={<span className="font-mono break-all">{ORIGIN}</span>}
            />
            <ListRow
              leading={<Icon glyph={GLYPH.passkey} className="text-muted" />}
              title="Your passkeys are bound to"
              subtitle="It will not work from anywhere else"
              trailing={<span className="font-mono break-all">{RP_ID}</span>}
            />
          </ListRows>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <h3 className="m-0 mb-1 text-sm font-semibold text-ink">The network’s terms</h3>
          {terms === null ? (
            <p className="m-0 text-sm text-muted">
              Not fetched yet. They are shown once, on the first real send screen, and the
              hash is recorded here then. Fetching them is a call to the indexer, which is
              why nothing does it before you ask to send.
            </p>
          ) : (
            <>
              <p className="m-0 text-sm text-muted">
                Shown in this browser on {day(terms.seenAt)}. The hash below is what the
                indexer reported for the document at that moment.
              </p>
              <p className="m-0 mt-2 font-mono text-xs break-all text-ink">{terms.hash}</p>
              <p className="m-0 mt-2 text-sm">
                <a
                  className="text-accent underline-offset-4 hover:underline"
                  href={terms.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  The terms document
                </a>
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="max-w-prose text-xs text-faint">
        <p className="m-0">
          Nothing above is asked anything until you ask for something. Reading a balance tells
          the indexer this wallet&rsquo;s address, which is why it happens on a press and not
          on a page load. Sending dials the node. The proof of a private payment is built in
          this browser out of key material served by this wallet&rsquo;s own origin and checked
          against pinned fingerprints first — no third party is asked to prove anything.
        </p>
        <p className="mt-2 mb-0">
          There is no network switcher and no indexer field you can edit, and the reasons are
          different. The network name is part of every address this wallet prints, so a wallet
          showing one network while signing for another would be found out by somebody
          else&rsquo;s money. And an indexer you could point anywhere is an indexer whose
          operator is handed every address you own.
        </p>
      </div>
    </Section>
  );
}

/* ----------------------------------------------- §5, §6, §8 the honest not-yets */

/**
 * THREE ROOMS THAT ARE NOT BUILT, AND THE ONE THING NO ROUND MAY DO.
 *
 * THE RULE: *"WHAT NO ROUND MAY BUILD IS AN INPUT THAT ACCEPTS A
 * CONTACT AND DROPS IT. A person who believes a name is saved is a person who
 * will later trust that name, which is the precise failure* a name may never
 * replace an address at approval *exists to prevent."* So the address book is
 * a door and nothing else, exactly as Home's shortcut already is.
 *
 * THE AGENT IS A ROW WITH NO DOOR AT ALL, and that is deliberate rather than
 * an omission: there is no route behind it, so a link would be a dead one. The
 * row states what is coming and, more importantly, the one property that is
 * expensive to retrofit — the key is a bearer credential and goes through
 * sealed storage, never `localStorage`.
 */
function AddressBookRow(): ReactNode {
  return (
    <Section
      title="Contacts"
      description="The people you pay, so an address is never typed twice."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <ListRow
              href={hrefOf('address-book')}
              leading={<Icon glyph={GLYPH.contacts} className="text-muted" />}
              title="Manage your contacts"
              subtitle="One book shared across your wallets"
              trailing={<Badge>Coming soon</Badge>}
            />
          </ListRows>
          <p className="m-0 mt-3 text-xs text-faint">
            A name in it will help you <em>find</em> an address. It will never stand in place
            of one on the screen that approves a payment.
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

/**
 * MY PROFILE, AND THE SCREEN THAT APPROVES LETTING SOME OF IT OUT.
 *
 * **BOTH GET REAL DOORS RATHER THAN AN EXEMPTION.** The design says *new
 * routes get doors or the walk says so*, and `reachability.test.tsx` said so
 * the moment the routes were added. `#/approve` could have gone on the
 * gallery's unlinked list — nothing but an application opening the wallet
 * normally lands there — but adding a route to that list is widening what a
 * closed pin excuses, and a door is cheaper and more honest: it lets a person
 * see what a company asking will look like BEFORE one asks.
 *
 * **NEITHER IS A PLACE.** The design keeps the navigation at
 * four places on purpose; the address book is managed here for the same
 * reason, and this sits beside it.
 */
function YourDetailsRow(): ReactNode {
  return (
    <Section
      title="My profile"
      description="Facts about you — your name, your email — that you can hand to a company that needs them."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <ListRow
              href={hrefOf('profile')}
              leading={<Icon glyph={GLYPH.contacts} className="text-muted" />}
              title="What this wallet holds about you"
              subtitle="Encrypted here, on no server of ours"
            />
            <ListRow
              href={hrefOf('approve')}
              leading={<Icon glyph={GLYPH.passkey} className="text-muted" />}
              title="When a company asks"
              subtitle="What the screen looks like, and what it will not promise"
            />
          </ListRows>
          <p className="m-0 mt-3 text-xs text-faint">
            Nothing leaves this wallet without you approving it, one detail at a time — and
            what is sent, is sent. This wallet can stop sending a company anything new. It
            cannot reach into their records and take anything back.
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

function AgentRow(): ReactNode {
  return (
    <Section
      title="The agent"
      description="Asking for something in words, and having it built for you to approve."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <ListRow
              leading={<Icon glyph={GLYPH.earn} className="text-muted" />}
              title="Bring your own provider and key"
              subtitle="Configured here, in a round of its own"
              trailing={<Badge>Coming soon</Badge>}
            />
          </ListRows>
          <p className="m-0 mt-3 text-xs text-faint">
            Two things are already settled about it. The key you paste is a bearer credential
            — whoever reads it can spend your inference budget — so it goes through this
            wallet&rsquo;s sealed storage rather than into the browser&rsquo;s ordinary
            storage. And the agent <strong>constructs</strong> payments; it never approves
            one. Everything it builds arrives at the same approval screen, with the same
            rows, as everything else.
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

function AdvancedRow(): ReactNode {
  return (
    <Section
      title="Advanced"
      description="The two things that are dangerous to look at, behind their own door."
    >
      <Card>
        <CardContent className="pt-5">
          <ListRows>
            <ListRow
              href={hrefOf('advanced')}
              leading={<Icon glyph={GLYPH.settings} className="text-muted" />}
              title="The recovery phrase, and your recovery key"
              subtitle="Anyone who reads the phrase owns the account"
              trailing={<Badge>Coming soon</Badge>}
            />
          </ListRows>
        </CardContent>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------- §7 the danger */

/**
 * FORGETTING EVERYTHING — decided 21 Aug: yes, with hard guards.
 *
 * `startOver()` has always existed and calls `forgetEverything()`. **Until
 * now it was reachable only from `broken`** — a healthy wallet had no way to
 * it at all, so a tester who wanted a clean slate cleared browser storage by
 * hand, which is the same act with none of the warnings.
 *
 * **THE GUARDS ARE THE FEATURE, AND THERE ARE THREE.**
 *
 *   **A sentence composed deliberately, not a second "are you sure".** A
 *   confirm dialog is dismissed by the same reflex that opened it; typing is
 *   not.
 *
 *   **AND IT IS THE ACCOUNT'S NAME, NOT THE OPEN WALLET'S — decided
 *   21 Aug.** The design asked for the name of the wallet that happened to
 *   be open, and what this button clears is every slot, the passkeys, the
 *   piece map and the stamps. On the main wallet the two coincide and it reads
 *   correctly; **on subwallet 3 it read *Type Savings to confirm* over a
 *   control that erases all eleven** — the sentence a person PERFORMS was
 *   narrower than the act, and that sentence is the guard. So the value asked
 *   for is `displayNameOf(MAIN_ACCOUNT, names)`, which falls back to the
 *   slot's own fixed name when nobody has renamed it — the string always
 *   exists, and it is the one thing in this product that names the whole
 *   account. **The label says ACCOUNT and not wallet**, because otherwise the
 *   mismatch just moves into the wording.
 *
 *   **AN UNSECURED WALLET GETS A DIFFERENT AND STRONGER WARNING**, because
 *   there are no pieces to come back from. That is the one case where this
 *   button is the last event in the money's life. A secured wallet's warning
 *   may say what a secured wallet can do; an unsecured one's must not imply a
 *   way back that does not exist.
 *
 *   **It says what it clears AND what it does not.** `forgetEverything()`
 *   clears the keyring, the passkey record, the secured record, the arrival
 *   and creation stamps, the wallet names and the balance checkpoints. It does
 *   not touch the theme or the sidebar, and `shell/prefs.ts` is explicit about
 *   why: *"a person pressing that button is asking about their money, and a
 *   wallet that answered by also resetting the theme would be telling them it
 *   had done something it had not."* **Which is also why the theme control is
 *   in §1 and not grouped down here to make this section look tidy.**
 *
 * ON A ROW WHICH THIS DELIBERATELY IS NOT. That row is *"the screen may never
 * print the answer to its own confirmation question above the box asking for
 * it"*, and it is about the pairing digits — a value carried out of band,
 * where the whole point is that the two screens agree independently. **Here
 * the value is not evidence of anything and is not secret**: the wallet's name
 * is in the sidebar, in the account chip and four inches up this page. Hiding
 * it would make the guard harder to pass without making it mean more, which is
 * theatre rather than a defence. What this guard buys is deliberateness, and
 * deliberateness survives knowing the answer.
 */
function DangerSection({ secret, account, secured }: {
  readonly secret: Secret;
  /** The MAIN wallet's name, which is the ACCOUNT's name. Never the
   * open wallet's: see the note above. */
  readonly account: string;
  readonly secured: boolean;
}): ReactNode {
  const { startOver, wallets } = useSession();
  /* The OTHER wallets in this browser, which this button does not
   * touch. Naming them is not decoration: this control used to clear the
   * browser, and a person who has just been told that would reasonably think
   * their other wallets went with it. */
  const others = wallets.filter((wallet) => !wallet.current);
  const [typed, setTyped] = useState('');
  const armed = typed.trim() === account;
  /* `secret` is not read here on purpose: `startOver` forgets the browser's
   * whole state and takes no account. It is in the signature so the section
   * cannot be rendered without one — this belongs to an unlocked wallet and
   * to nothing else. */
  void secret;

  return (
    <Section
      tone="danger"
      title="Forget this wallet"
      description={others.length === 0
        ? 'Takes this wallet off this browser. Nothing on the chain changes.'
        : `Takes this wallet off this browser. The other ${others.length === 1
          ? 'wallet here is' : `${others.length} wallets here are`} untouched, and `
          + 'nothing on the chain changes.'}
    >
      {others.length > 0 && (
        <p className="m-0 max-w-prose text-sm text-ink">
          <strong>
            This is about this wallet only.
          </strong>{' '}
          {others.length === 1 ? 'The other wallet' : `The other ${others.length} wallets`}
          {' '}in this browser — {others
            .map((wallet, i) => wallet.name ?? `an unnamed wallet (${i + 1})`)
            .join(', ')} — {others.length === 1 ? 'stays' : 'stay'} exactly as
          {others.length === 1 ? ' it is' : ' they are'}, with{' '}
          {others.length === 1 ? 'its own passkey' : 'their own passkeys'}.
        </p>
      )}
      {secured ? (
        <p className="m-0 max-w-prose text-sm text-ink">
          Your pieces are what puts this account back, and they are not in this browser —
          they are wherever you placed them. Forgetting here does not touch them, and it does
          not touch anything that has ever been paid to your addresses. It empties this
          machine.
        </p>
      ) : (
        <p className="m-0 max-w-prose text-sm text-ink">
          <strong>
            This account has never been cut into pieces from this browser, so there is
            nothing to put it back with.
          </strong>{' '}
          If you do this, the account is gone — and everything ever paid to its addresses is
          gone with it, permanently, for everybody, including us. There is no copy anywhere
          and nothing to find later.{' '}
          <a className="text-accent underline-offset-4 hover:underline" href={hrefOf('secure')}>
            Cut it into pieces first
          </a>{' '}
          if you might want it back.
        </p>
      )}

      <div className="grid gap-4 wide:grid-cols-2">
        <div>
          <h3 className="m-0 mb-1 text-sm font-semibold text-ink">What this clears</h3>
          <ul className="m-0 list-disc pl-5 text-sm text-muted">
            <li>the sealed account keys in this browser</li>
            <li>the record of this browser&rsquo;s passkeys</li>
            <li>the record of where your pieces are</li>
            <li>when this browser got the account</li>
            <li>the names you gave your wallets</li>
            <li>the saved balances</li>
            <li>the key in this browser that unsealed it</li>
          </ul>
        </div>
        <div>
          <h3 className="m-0 mb-1 text-sm font-semibold text-ink">What it does not</h3>
          <ul className="m-0 list-disc pl-5 text-sm text-muted">
            <li>the pieces themselves, wherever you placed them</li>
            <li>this account on any other device</li>
            <li>any other wallet in this browser</li>
            <li>anything on the chain, including money at your addresses</li>
            <li>your theme and sidebar — this button is about your money</li>
          </ul>
        </div>
      </div>

      <div className="max-w-prose">
        <Label htmlFor="forget-confirm">
          Type the account&rsquo;s name — <strong>{account}</strong> — to confirm
        </Label>
        <Input
          id="forget-confirm"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>

      <div>
        <Button
          variant="danger"
          disabled={!armed}
          onClick={startOver}
        >
          Forget this wallet
        </Button>
      </div>
    </Section>
  );
}
