import type { ReactNode } from 'react';
import type { Secret } from 'midnight-identity';
import { hrefOf } from '../routes.js';
import { arrivalOf, creationOf } from '../accounts/storage.js';
import type { SecuredSetup } from '../accounts/storage.js';
import { day, verifiedWords } from '../components/piece-map.js';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from 'vaults-ui';
import { RowItem, RowItems } from '../components/rows.js';
import { StatusAlert, StatusBadge } from '../components/status.js';
import { GLYPH, Glyph } from '../glyphs.js';

/* ---------------------------------------------------------------- the alert */

/**
 * THE STANDING NOTICE — §7.7, and the words are not this change's to
 * rewrite. It says what is actually at stake, it has no close button, and it
 * renders until `loadSecuredSetup()` stands behind a record for THIS account.
 *
 * It moves into the kit's amber `Alert`, which is where
 * the design put this exact sentence: **it states what is at
 * risk, not what is undone.** `role={null}` because it is a standing banner
 * that has been on screen since load — announcing it on every render is the
 * screen-reader equivalent of a notification that will not stop.
 */
export function UnsecuredNotice(): ReactNode {
  return (
    <StatusAlert tone="warning" role={null} title="If you lose this device, the money in this wallet is gone.">
      <p className="m-0">
        Your account exists only in this browser. Cut it into pieces and place them — your own cloud account, paper,
        people you trust — and a lost or broken machine becomes an errand instead of a loss.
      </p>
      <p className="mt-2 mb-0">
        One set of pieces covers every subwallet — securing once secures all of them, including subwallets you first use
        years from now.
      </p>
      <p className="mt-3 mb-0">
        {/* The alert underlines the links in its words; this one is a button. */}
        <Button asChild variant="default" className="no-underline!">
          <a href={hrefOf('secure')}>Secure your account</a>
        </Button>
      </p>
    </StatusAlert>
  );
}

/* ------------------------------------------------------- the securing state */

/**
 * §7.15's third state: no record stands for this account, and it arrived by
 * recovery a moment ago — so "the money is gone if you lose this device" is
 * untrue on arrival and is not said. This browser does not know where the
 * pieces are; that is the whole claim.
 */
export function RecoveredUnknownCard(): ReactNode {
  return (
    <Card aria-label="Where this account's pieces are is not known here">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          This account was just put back from its pieces.
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="m-0 text-sm text-muted-foreground">
          The pieces you used exist — you fetched them yourself. This browser could not write its own note of where they
          are, so it does not know, and this screen cannot tell you whether the account is secured. It does not follow
          that anything is wrong.
        </p>
        <p className="m-0 mt-3 text-xs text-muted-foreground">
          Cutting a new set from{' '}
          <a className="text-primary underline-offset-4 hover:underline" href={hrefOf('secure')}>
            the securing screen
          </a>{' '}
          adds a way in — it never switches the pieces you already have off.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The pairing flavour of the third state: this account demonstrably lives on
 * another machine too — that is where it just came from — but whether it is
 * secured with pieces is written there, not here. Neither the tick nor the
 * "money is gone" notice would be honest.
 */
export function PairedUnknownCard({ at }: { readonly at: number }): ReactNode {
  return (
    <Card aria-label="Where this account's pieces are is not known here">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          This wallet arrived from another device on {day(at)}.
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="m-0 text-sm text-muted-foreground">
          Whether it is secured — where its pieces are, if it has any — is recorded on the machine it came from, not
          here. This browser cannot tell, and does not guess.
        </p>
        <p className="m-0 mt-3 text-xs text-muted-foreground">
          You can check on the other machine, or cut a set from{' '}
          <a className="text-primary underline-offset-4 hover:underline" href={hrefOf('secure')}>
            the securing screen
          </a>{' '}
          here — a new set adds a way in and never switches an old one off.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Secured. §7.12 as amended by §7.14 and §7.15: the tick states dated FACTS the
 * flow can actually support — the wizard's cut-proved-read-back, or a recovery's
 * real rebuild from really-fetched pieces — never "gathered" and never a
 * prediction. A recovery's map is PARTIAL and says so: only the pieces that were
 * used are known. The nuance lives per piece, in three different sentences for
 * three different facts; a replaced set's pieces are still a way in,
 * which the card says rather than hides; and a superseded set cut from a
 * DIFFERENT account is shown as exactly that, never as this account's
 * history.
 */
export function SecuredCard({ setup }: { readonly setup: SecuredSetup }): ReactNode {
  /* A kept map is only this account's history if its fingerprint says so.
   * The rest is some other account's map, kept because destroying a map is never
   * ours to do — and its pieces do not open this account. */
  const ownOld = setup.superseded.filter((old) => old.fingerprint === setup.fingerprint);
  const foreignOld = setup.superseded.filter((old) => old.fingerprint !== setup.fingerprint);
  return (
    <Card aria-label="This account is secured">
      <CardHeader>
        <CardTitle role="heading" aria-level={3} className="flex items-center gap-2">
          <span className="ok" aria-hidden="true">
            ✓
          </span>{' '}
          Account secured
        </CardTitle>
        <CardDescription>
          {setup.partial
            ? `On ${day(setup.rebuiltAt)} this account was put back from ${setup.pieces.length} ` +
              'pieces fetched from where they were placed — the strongest check there is. ' +
              'These are the pieces you used; there may be others this browser does not ' +
              'know about.'
            : `On ${day(setup.rebuiltAt)} this account was cut into ${setup.pieces.length} pieces ` +
              `and proved rebuildable from any ${setup.threshold}. One piece was read back from ` +
              'its card; you said the rest are placed.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div>
          {setup.pieces.map((piece) => (
            <div className="piece-row" key={`${piece.holder}:${piece.label}`}>
              <span className="who">{piece.label}</span>
              {piece.holder !== piece.label && <span className="faint small">{piece.holder}</span>}
              <span className={typeof piece.lastVerified === 'number' ? 'verified' : 'verified never'}>
                {verifiedWords(piece.lastVerified)}
              </span>
            </div>
          ))}
        </div>
        <p className="m-0 mt-3 text-xs text-muted-foreground">
          These pieces cover every subwallet too: all of them grow out of the one secret the pieces rebuild — including
          subwallets first used after the pieces were placed.
        </p>
        {ownOld.length > 0 && (
          <details className="reveal" style={{ marginTop: '0.75rem' }}>
            <summary>
              {ownOld.length === 1
                ? 'One earlier set was replaced — its pieces still work'
                : `${ownOld.length} earlier sets were replaced — their pieces still work`}
            </summary>
            <p className="warn-text small" style={{ margin: '0.5rem 0 0.25rem' }}>
              Replacing a plan adds a way in and never removes one: these pieces rebuild this account for as long as
              they exist, and nothing can switch them off.
            </p>
            {ownOld.map((old) => (
              <p className="faint small" key={old.supersededAt} style={{ margin: '0.25rem 0' }}>
                Replaced {day(old.supersededAt)} (any {old.threshold} of {old.pieces.length}):{' '}
                {old.pieces.map((p) => p.label).join('; ')}
              </p>
            ))}
          </details>
        )}
        {foreignOld.length > 0 && (
          <details className="reveal" style={{ marginTop: '0.75rem' }}>
            <summary>
              {foreignOld.length === 1
                ? 'A different account’s piece list is also on file'
                : `${foreignOld.length} different accounts’ piece lists are also on file`}
            </summary>
            <p className="muted small" style={{ margin: '0.5rem 0 0.25rem' }}>
              These pieces do <strong>not</strong> open this account — they belong to an account that was on this
              browser before. The list is kept because destroying a map is never this wallet&rsquo;s call: whoever owns
              that account may still need it.
            </p>
            {foreignOld.map((old) => (
              <p className="faint small" key={old.supersededAt} style={{ margin: '0.25rem 0' }}>
                Kept {day(old.supersededAt)} (any {old.threshold} of {old.pieces.length}):{' '}
                {old.pieces.map((p) => p.label).join('; ')}
              </p>
            ))}
          </details>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------ this device */

/**
 * WHEN THIS BROWSER GOT THIS ACCOUNT.
 *
 * Decided 21 Aug: show when this device was linked, as a date and a time,
 * and do not show a count of devices.
 *
 * THE NO-ROSTER HALF IS THE PART THAT IS A DECISION AND NOT A FEATURE.
 * **This wallet cannot know how many devices hold
 * this account and must not appear to.** There is no registry, pairing leaves
 * no channel between the two machines, and there is no revocation anywhere in
 * the codebase — so a count would be fabricated, and worse, *"a device list is
 * exactly the component that makes a person assume revocation exists"*
 * So: one sentence about THIS browser, and nothing that could be
 * read as a list.
 *
 * THREE WAYS A KEYRING APPEARS IN A BROWSER, AND THIS CARD KEEPS THEM APART:
 *
 *   **Created here** — a new secret was made on this machine. `creationOf`,
 *   written by `session.tsx` at the two places `newSecret()` is called.
 *
 *   **Paired here** — the account arrived from another device. `arrivalOf`,
 *   written by `saveArrival` at the landing, and older than this change.
 *
 *   **Recovered here** — threshold-many pieces put an existing account back
 *   onto this machine. **THIS CARD SAYS NOTHING AT ALL IN THAT CASE, AND THAT
 *   IS THE POINT OF THE WHOLE §5.** A recovery is not a beginning: the account
 *   is older than this browser, often by a lot, and a card that called it a
 *   creation would be telling somebody who had just rebuilt an old account
 *   that it started on the machine they rebuilt it onto. There is no honest
 *   dated fact to print — nothing recorded when the account really began — so
 *   nothing is printed. `RecoveredUnknownCard` above already says what this
 *   browser does and does not know in that state.
 *
 * BOTH RECORDS CAN MATCH THE SAME ACCOUNT, and creation wins. It happens if an
 * account made here is later paired back onto this same browser. *Created in
 * this browser* is the older fact and is still true, and it is the one a
 * person is asking about; printing both would be the enumeration the rule
 * forbids.
 *
 * IT IS A LOCAL CONVENIENCE AND SHOWS NOTHING WHEN IT HAS NOTHING. A browser
 * whose record is missing, damaged or another account's renders no card at
 * all — never a guessed date. No money depends on it, which is exactly why it
 * is allowed to be absent (`storage.ts`, the same rule the subwallet names
 * have lived under since §2.3).
 */
export function ThisDeviceCard({ secret }: { readonly secret: Secret }): ReactNode {
  const made = creationOf(secret);
  const linked = arrivalOf(secret);
  if (!made && !linked) return null;
  return (
    <Card aria-label="When this browser got this account">
      <CardContent className="flex items-center gap-3">
        <Glyph icon={GLYPH.wallet} className="size-5 text-muted-foreground" />
        <p className="m-0 text-sm text-foreground">
          {made ? `Created in this browser on ${day(made.at)}.` : `Linked on ${day(linked!.at)}.`}
        </p>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- set up */

/**
 * THE DOORS THAT ARE NOT QUICK ACTIONS — securing, pairing, and the phrase.
 *
 * **THIS CARD IS KEPT DELIBERATELY AND THE DESIGN DOES NOT LIST IT.**
 * The change names what Home carries and this is not among them; building it
 * anyway is a judgement, and the reason is narrow: **`#/add-device` has no
 * other door.** Pairing is five closed rows that no person has
 * ever exercised, and this change exists to hand the wallet to three to five
 * testers. The design puts these in Settings, and Settings is
 * `notbuilt` — so dropping this card would have taken a working feature out of
 * reach of exactly the people the change is for, between one round and the next.
 * It goes back to Settings when Settings exists.
 *
 * The securing door is here as well as in the amber alert, and that is not a
 * duplicate: the alert is gone the moment the account is secured, and a person
 * who wants to re-verify their pieces or cut a fresh set still needs a way in.
 * The sentence it carries is the state, in the three states §7.15 has.
 */
export function SetUp({ state }: { readonly state: 'secured' | 'unsecured' | 'unknown' }): ReactNode {
  return (
    <Card aria-label="What to do next">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          Set up
        </CardTitle>
      </CardHeader>
      <CardContent>
        <RowItems>
          <RowItem
            href={hrefOf('secure')}
            leading={<Glyph icon={GLYPH.secured} className="size-5 text-muted-foreground" />}
            title="Secure your account"
            subtitle={
              state === 'secured'
                ? 'Done — revisit the pieces, re-verify them, or change the plan'
                : state === 'unsecured'
                  ? 'The one thing worth doing first'
                  : 'This browser does not know where this account’s pieces are'
            }
          />
          <RowItem
            href={hrefOf('add-device')}
            leading={<Glyph icon={GLYPH.wallet} className="size-5 text-muted-foreground" />}
            title="Add another device"
            /* `RowItem` truncates a subtitle on purpose (`components/rows.tsx`),
             * so these fit one line rather than the row growing to hold them.
             * The full sentence lives on the screen each one leads to. */
            subtitle="Scan a code and compare two digits on both screens"
          />
          <RowItem
            href={hrefOf('advanced')}
            leading={<Glyph icon={GLYPH.settings} className="size-5 text-muted-foreground" />}
            title="Advanced"
            subtitle="The recovery phrase, and the key others lock pieces to"
            trailing={<StatusBadge>Coming soon</StatusBadge>}
          />
        </RowItems>
        <p className="m-0 mt-3 text-xs text-muted-foreground">
          Recovering a <em>different</em> account onto this machine starts from the lock screen — press Lock first. It
          replaces the wallet stored here, and says so before it does.
        </p>
      </CardContent>
    </Card>
  );
}
