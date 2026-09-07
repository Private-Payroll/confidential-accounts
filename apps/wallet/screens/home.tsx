import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { shortPayee } from 'midnight-identity';
import type { Identity, Secret } from 'midnight-identity';
import { INDEXER_HOST, NETWORK } from '../config.js';
import type { BalanceState, StopBalance } from '../balance.js';
import { BalanceEnginesContext } from '../balance-context.js';
import { shortUnshielded } from '../unshielded.js';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from '../amount.js';
import { ownedAddressFor } from '../owned-address.js';
import type { OwnedAddress } from '../owned-address.js';
import { hrefOf } from '../routes.js';
import { splitShortAddress } from '../short-address.js';
import { arrivalOf, creationOf, loadSecuredSetup } from '../storage.js';
import type { SecuredSetup } from '../storage.js';
import {
  MAIN_ACCOUNT, WALLET_ACCOUNTS, defaultNameOf, displayNameOf, hueOf,
} from '../subwallets.js';
import { renameWallet, useWallets } from '../shell/wallets.js';
import { WalletSwitcher } from '../shell/switcher.js';
import {
  WalletBalanceCell, anyNeverChecked, holdsMoney, rowFor, useWalletBalances,
} from '../shell/wallet-balances.js';
import { Mark } from '../shell/mark.js';
import { InboxCard } from '../inbox-card.js';
import { day, verifiedWords } from '../piece-map.js';
import {
  dismissPendingSend, liveResolutionDoors, loadPendingSends, resolvePendingSends,
} from '../pending.js';
import type { PendingSend, ResolutionDoors } from '../pending.js';
import { CopyButton } from '../ui.js';
import { QrPanel } from '../qr.js';
import {
  ActionTile, ActionTiles, Alert, Badge, Button, ButtonLink, Card, CardContent,
  CardDescription, CardFooter, CardHeader, CardTitle, Dialog, DialogContent,
  DialogDescription, DialogHeader, DialogTitle, EmptyState, GLYPH, Icon, Input, Label,
  ListRow, ListRows, Separator, Skeleton,
} from '../kit/index.js';

/**
 * HOME — the screen that decides whether a tester continues.
 *
 * THIS SCREEN REBUILDS ITS CONTENTS AND CHANGES NOTHING IT KNOWS. The rules this file
 * has always stated still hold and are still the reason it is shaped this way:
 *
 *   THE SECURING STATE IS THE FIRST THING SAID. `loadSecuredSetup` refuses a
 *   record cut from a different secret, and the subwallet names and
 *   last-used slot are held to the same rule.
 *
 *   THE SELECTION LIVES IN STORAGE, NOT IN A PROVIDER. Every switch writes
 *   `lastUsed`, so navigating away and back — or locking and unlocking — lands
 *   on the wallet that was open. `shell/wallets.ts` is the change event
 *   `storage.ts` cannot emit: this screen and the chip subscribe to the same
 *   record and are notified by the same write. No second copy.
 *
 * WHAT THIS SCREEN SHOWS, and the order it reads in:
 *
 *   THE BACKUP ALERT SITS ABOVE THE BALANCE and disappears entirely once the
 *   account is secured, so it never permanently pushes the balance down. It is
 *   the kit's amber `Alert` — what is at risk, not what is undone — carrying
 * §7.7's sentence unchanged.
 *
 *   THE HERO IS THE UNSHIELDED NIGHT BALANCE at the display size the kit added.
 *
 *   **THE HERO AND THE TOKEN LIST ARE ONE OBJECT, and that is a judgement this
 *   file makes rather than a reading of the instruction.** The design names
 *   them as two sections; built as two they print the same balance twice on one
 *   screen, and a wallet that says 5,000 tNIGHT in two places is a wallet whose
 *   two numbers can disagree. So the token list IS the three lines — unshielded
 *   NIGHT, private, DUST — with the first of them promoted to display size and
 *   the other two quiet beneath it. `TOKEN_LINES` is an array, so a fourth
 *   token is one entry rather than a redesign, which is what *"build the list
 *   so more rows slot in"* is protecting.
 *
 *   NOTHING LEAVES THIS BROWSER UNTIL THE BUTTON IS PRESSED, and the hero did
 *   NOT change that. Asking the indexer tells its operator this wallet's
 *   address, so the asking is an act a person performs — `SECURITY.md`'s
 *   promise that opening the wallet page calls nobody, and `balance.test.tsx`'s
 *   first claim.
 *
 *   THE ADDRESS MOVED INTO RECEIVE. It is a popup because it moves nothing and
 *   goes through no approval path. **SEND DOES NOT**: send carries the approval
 *   surface, and *one surface approves anything that moves money* is the rule
 *   the agent and the payroll integration both depend on — so Send is a LINK to
 *   a screen and will never be a modal.
 *
 *   EVERY VISIBLE THING COMES FROM `apps/wallet/kit/`. No component is defined in
 *   this file that a second screen could want; the switcher is the shell's own
 *   and is reached through `shell/switcher.tsx` rather than reimplemented,
 *   which is the rule *"one switcher, two doors"*.
 */
export function Home({ identity, secret, justRecovered = false }: {
  readonly identity: Identity;
  readonly secret: Secret;
  /**
   * True when this account arrived by a completed recovery in this very
   * session. §7.15: the landing writes the secured record itself, so
   * normally `loadSecuredSetup` finds one — but if that write could not stand
   * behind the evidence, the person who JUST proved their pieces work must not
   * be greeted with "the money is gone". Three states, not two.
   */
  readonly justRecovered?: boolean;
}): ReactNode {
  const { names, account } = useWallets(secret);

  /* THE SHEET IS A SNAPSHOT — the answer (a), the honest half. The
   * securing flow prints a sheet that can carry these names, but a name given
   * or changed after it was printed is not on it, and a person who believes the
   * paper carries their names would be wrong. So a rename on a SECURED account
   * says so, and points at the reprint. */
  const [sheetStale, setSheetStale] = useState(false);
  /* Bumped whenever a sync establishes a number, so the all-wallets card
   * re-reads its checkpoint summaries without owning the sync itself. */
  const [checkpointsChanged, setCheckpointsChanged] = useState(0);

  const rename = (name: string): void => {
    renameWallet(secret, account, name);
    if (loadSecuredSetup(secret) !== null) setSheetStale(true);
  };

  const name = displayNameOf(account, names);
  /* The ONE door from a slot to a renderable address. The owner travels
   * inside the value, so nothing below can render the address without it.
   * `names` is deliberately a dependency: a rename re-derives the owner
   * everywhere at once. */
  const owned = useMemo(
    () => ownedAddressFor(identity, account, names, NETWORK), [identity, account, names]);
  const secured = loadSecuredSetup(secret);
  /* The DURABLE half of §7.15's third state: an account that arrived by pairing
   * carries that fact in storage, fingerprint-checked, so a reload does not
   * greet its owner with "your account exists only in this browser" — pairing
   * just demonstrated the opposite. Pairing proves the OTHER machine had the
   * account and nothing about pieces, so this is never a tick. */
  const arrived = secured === null ? arrivalOf(secret) : null;
  const unknown = !secured && (justRecovered || arrived !== null);

  return (
    <div className="flex flex-col gap-4">
      {/* The switch, said out loud for a screen reader — the visual half of
        * "unmistakable" is the hero above changing name and colour. */}
      <div role="status" aria-live="polite" className="visually-hidden">
        {`Now showing ${name}`}
      </div>

      {sheetStale && (
        <Alert tone="warning" title="Your printed sheet of pieces is now out of date">
          It was made before this name.{' '}
          <a className="text-accent underline-offset-4 hover:underline" href={hrefOf('secure')}>
            Reprint it from the securing screen.
          </a>{' '}
          The pieces themselves are untouched; only the names on the paper age.
        </Alert>
      )}

      {/* ABOVE THE BALANCE, AND GONE THE MOMENT IT IS UNTRUE. */}
      {!secured && !unknown && <UnsecuredNotice />}

      {/* THE ACTIONS COME OUT OF THEIR CARD AND SIT ABOVE THE
        * MONEY. They were a card titled *"Do something"* below the
        * balance; they are the reason a person opened the wallet. The SET and
        * the ORDER are unchanged and so is every rule on them — this moves a
        * row and changes no action.
        *
        * IT IS STILL BELOW THE AMBER ALERT. The order here
        * was *"the one thing that can cost everything sits first"*, and the
        * alert is gone the moment the account is secured, so nothing is
        * permanently above the actions either. */}
      <QuickActions owned={owned} />

      <HeroCard
        key={account}
        identity={identity}
        secret={secret}
        owned={owned}
        names={names}
        onRename={rename}
        onEstablished={() => setCheckpointsChanged((n) => n + 1)}
      />

      {/* THE CARRIED QUESTION — under the hero, when there is one, and nothing at all when
        * there is not. This change PLACES the card; it does not rebuild it. */}
      <PendingSendsCard secret={secret} />

      {/* WHAT IS WAITING FOR YOU SOMEWHERE ELSE.
        * BELOW THE MONEY AND ABOVE THE RECORD-KEEPING, because it is neither:
        * it is a report about somewhere else, and it approves nothing
        * (`../inbox-card.tsx`). It renders in every state including the one
        * this build ships in — there is no inbox host, and *nothing is being
        * asked* is a sentence a person is owed rather than an empty space.
        *
        * IT TAKES NO PROPS. The poller's lifetime is the unlocked phase and is
        * owned by `app/app.tsx`; this card subscribes to what it finds
        * (`../inbox-live.ts`), the way the chip and this screen both subscribe
        * to `shell/wallets.ts` rather than being handed a copy. */}
      <InboxCard />

      <RecentActivity />

      {/* The securing state in full — the tick and its pieces, or the two
        * honest "this browser cannot tell" cards. The amber alert above is the
        * only thing that appears when nothing is on record. */}
      {secured
        ? <SecuredCard setup={secured} />
        : justRecovered ? <RecoveredUnknownCard />
          : arrived !== null ? <PairedUnknownCard at={arrived.at} /> : null}

      <ThisDeviceCard secret={secret} />

      <SetUp state={secured ? 'secured' : unknown ? 'unknown' : 'unsecured'} />

      <AllWalletsCard
        identity={identity}
        secret={secret}
        names={names}
        changed={checkpointsChanged}
      />
    </div>
  );
}

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
function UnsecuredNotice(): ReactNode {
  return (
    <Alert
      tone="warning"
      role={null}
      title="If you lose this device, the money in this wallet is gone."
    >
      <p className="m-0">
        Your account exists only in this browser. Cut it into pieces and place them —
        your own cloud account, paper, people you trust — and a lost or broken machine
        becomes an errand instead of a loss.
      </p>
      <p className="mt-2 mb-0">
        One set of pieces covers every subwallet — securing once secures all of them,
        including subwallets you first use years from now.
      </p>
      <p className="mt-3 mb-0">
        <ButtonLink variant="primary" href={hrefOf('secure')}>Secure your account</ButtonLink>
      </p>
    </Alert>
  );
}

/* ----------------------------------------------------------------- the hero */

const asClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* `asMoment` MOVED to `shell/wallet-balances.tsx` with the rows that call it.
 * It was never the money card's — the card's own clock is `asClock` above —
 * and the freeze is on the card, whose bytes are unchanged. */

/**
 * THE TOKEN LIST, AS DATA. *"build the list so more rows
 * slot in."* A third token is an entry here; it is not a redesign.
 *
 * THE ORDER IS DELIBERATE. Unshielded first, because that is the address the
 * ordinary route pays and the one the faucet pays — the wallet spent a whole
 * milestone showing a shielded zero over money that had arrived unshielded.
 *
 * `hero` IS TRUE FOR EXACTLY ONE OF THEM. Two display-sized numbers on one
 * screen is not a hierarchy.
 */
const TOKEN_LINES: readonly {
  readonly kind: 'unshielded' | 'shielded' | 'dust';
  readonly title: string;
  readonly hero: boolean;
}[] = [
  { kind: 'unshielded', title: 'Unshielded NIGHT — ordinary transfers, the faucet', hero: true },
  { kind: 'shielded', title: 'Shielded — private payments', hero: false },
  { kind: 'dust', title: 'DUST — pays transaction fees', hero: false },
];

/**
 * THE HERO — which wallet is open, what is in it, and the two controls that
 * change either.
 *
 * IT IS KEYED BY ACCOUNT in `Home`, so switching wallets remounts it: the old
 * wallet's sync stops in cleanup and the new wallet starts from the honest "not
 * asked" state. A number must never linger over a different wallet's name.
 *
 * THE SWITCH OPENS THE SAME SWITCHER THE SIDEBAR FOOTER USES —
 * `shell/switcher.tsx`, one implementation, two doors. A second list here would
 * be that shape moved into the chrome.
 *
 * THE PENCIL IS NOT COSMETIC. Mechanically the ten
 * slots always exist, but to a person a slot with no name and no history is not
 * an account — **so naming is the act of creation**, and on an unnamed slot the
 * control reads *"Name this wallet"* rather than *"Rename"*.
 */
function HeroCard({ identity, secret, owned, names, onRename, onEstablished }: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly owned: OwnedAddress;
  readonly names: Readonly<Record<string, string>>;
  readonly onRename: (name: string) => void;
  readonly onEstablished?: () => void;
}): ReactNode {
  const { account, name } = owned;
  const personal = names[String(account)] !== undefined && names[String(account)] !== '';
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const engines = useContext(BalanceEnginesContext);
  const [shielded, setShielded] = useState<BalanceState | null>(null);
  const [unshielded, setUnshielded] = useState<BalanceState | null>(null);
  const [dust, setDust] = useState<BalanceState | null>(null);
  const stopShielded = useRef<StopBalance | null>(null);
  const stopUnshielded = useRef<StopBalance | null>(null);
  const stopDust = useRef<StopBalance | null>(null);
  /* Mounted per wallet, so this cleanup is what guarantees at most one wallet
   * is ever syncing live — the one on screen. */
  useEffect(() => () => {
    stopShielded.current?.();
    stopUnshielded.current?.();
    stopDust.current?.();
  }, []);

  /* The press reads both kinds of NIGHT, and the fee tank too. A
   * wallet that read only the shielded balance was showing zero over money that
   * arrived the ordinary way — and a wallet that never reads DUST cannot say
   * why sending is impossible. */
  const check = (): void => {
    stopShielded.current?.();
    stopUnshielded.current?.();
    stopDust.current?.();
    stopShielded.current = engines.shielded(identity, account, (next) => {
      setShielded(next);
      if (next.name === 'synced') onEstablished?.();
    });
    stopUnshielded.current = engines.unshielded(identity, account, setUnshielded);
    stopDust.current = engines.dust(identity, account, setDust);
  };

  const stateOf = (kind: 'unshielded' | 'shielded' | 'dust'): BalanceState | null =>
    (kind === 'dust' ? dust : kind === 'shielded' ? shielded : unshielded);

  const asked = shielded !== null || unshielded !== null || dust !== null;
  const anyFailed = shielded?.name === 'failed' || unshielded?.name === 'failed'
    || dust?.name === 'failed';
  const anySynced = shielded?.name === 'synced' || unshielded?.name === 'synced'
    || dust?.name === 'synced';

  return (
    <Card
      data-hero=""
      data-account={account}
      style={{ '--wallet-hue': String(hueOf(account)) } as CSSProperties}
      className="border-l-4 border-l-[hsl(var(--wallet-hue)_65%_62%)]"
    >
      <CardHeader>
        {/* THE OWNER LINE: a number never appears without the wallet it
          * belongs to, and a personal name never travels without its slot. */}
        <div className="wallet-owner flex flex-wrap items-center gap-2">
          <Mark address={owned.address.bech32} account={account} size={28} />
          <Badge tone="accent" data-wallet-name="">
            <strong className="font-semibold">{name}</strong>
          </Badge>
          {owned.owner !== name && <span className="text-xs text-faint">{owned.slot}</span>}
          <span className="flex-1" />
          <WalletSwitcher identity={identity} secret={secret}>
            <Button variant="outline" size="sm">
              <Icon glyph={GLYPH.switcher} className="size-4" />
              Switch wallet
            </Button>
          </WalletSwitcher>
          <Button
            variant="ghost"
            size="sm"
            aria-label={personal ? 'Rename this wallet' : 'Name this wallet'}
            title={personal ? 'Rename this wallet' : 'Name this wallet'}
            aria-expanded={renaming}
            onClick={() => {
              setDraft(names[String(account)] ?? '');
              setRenaming((now) => !now);
            }}
          >
            <Icon glyph={GLYPH.rename} className="size-4" />
          </Button>
        </div>
        <CardDescription>
          {account === MAIN_ACCOUNT
            ? 'The main wallet — what any Midnight wallet opens from these words.'
            : 'Its own address and its own money, under the same passkey and the same '
              + 'recovery pieces.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {renaming && (
          <form
            className="flex flex-col gap-2 rounded-tight border border-line bg-sunken p-3"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(draft);
              setRenaming(false);
            }}
          >
            <Label htmlFor="wallet-name">
              {account === MAIN_ACCOUNT
                ? 'A name for the main wallet'
                : `A name for ${owned.slot}`}
            </Label>
            <Input
              id="wallet-name"
              value={draft}
              maxLength={24}
              placeholder={defaultNameOf(account)}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" size="sm">Save the name</Button>
              <Button size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
            </div>
            <p className="m-0 text-xs text-faint">
              Naming a wallet is what makes it yours to find again. Names live in this
              browser only — after a recovery every wallet comes back and the names are
              the part you re-type. Leave it empty to go back to the slot&rsquo;s own name.
            </p>
          </form>
        )}

        {!asked ? (
          <div>
            <p className="m-0 text-sm text-muted">
              Not asked yet. Checking reads all three balances — unshielded NIGHT,
              shielded, and DUST, which pays fees — and asks the indexer at{' '}
              {INDEXER_HOST}, which learns this wallet&rsquo;s addresses. Nothing is sent
              until you press.
            </p>
            <Button variant="primary" className="mt-3" onClick={check}>
              Check the balance
            </Button>
          </div>
        ) : (
          <>
            {TOKEN_LINES.map((line, at) => (
              <div key={line.kind}>
                {at > 0 && <Separator decorative className="mb-4" />}
                <BalanceLine
                  kind={line.kind}
                  title={line.title}
                  hero={line.hero}
                  state={stateOf(line.kind)}
                  owner={owned.owner}
                />
              </div>
            ))}
            {anySynced && (
              <p className="m-0 text-xs text-faint">
                1 NIGHT = 1,000,000 STARs and 1 DUST = 10^15 SPECKs — the
                Foundation&rsquo;s own figures. The NIGHT split was
                measured on stagenet on 19 Aug: 5000 tNIGHT from the faucet read back as
                exactly 5,000,000,000 STARs.
              </p>
            )}
            {anyFailed && <Button onClick={check}>Try again</Button>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * ONE LINE OF THE TOKEN LIST, unchanged.
 *
 * Zero and "I do not know" are different facts: `synced` is the ONLY state that
 * renders a number, it says which moment it was true of, and the failed state
 * says out loud that it is not a zero.
 *
 * `hero` CHANGES THE SIZE AND NOTHING ELSE. The same states, the same
 * sentences, the same `data-kind` hook — a line that said less because it was
 * smaller would be a second, quieter version of the honesty this card is for.
 *
 * THE SKELETON IS ONLY EVER SHOWN WHILE SOMETHING IS ARRIVING: a dead
 * network may never read as a wait that never ends, so `failed` has words and
 * no skeleton, and the sentence beside every skeleton says what is happening.
 */
function BalanceLine({ kind, title, hero, state, owner }: {
  readonly kind: 'unshielded' | 'shielded' | 'dust';
  readonly title: string;
  readonly hero: boolean;
  readonly state: BalanceState | null;
  readonly owner: string;
}): ReactNode {
  /* One state shape, two tokens: the state's atomic amount renders in the
   * line's own unit — STARs → tNIGHT, SPECKs → tDUST — always exactly, always
   * with the atomic figure beside it (§7.17). */
  const big = kind === 'dust' ? dustFromSpecks : nightFromStars;
  const exact = kind === 'dust' ? exactSpecks : exactStars;
  const unit = kind === 'dust' ? 'tDUST' : 'tNIGHT';
  const arriving = state?.name === 'connecting' || state?.name === 'syncing';
  return (
    <div data-kind={kind} aria-busy={arriving ? 'true' : undefined}>
      <h3 className={hero ? 'm-0 text-sm font-medium text-muted' : 'm-0 text-sm font-medium text-muted'}>
        {title}
      </h3>

      {state === null && (
        <p className="m-0 mt-1 text-sm text-muted" role="status">Not asked yet.</p>
      )}

      {arriving && <Skeleton className={hero ? 'mt-2 h-11 w-56' : 'mt-2 h-6 w-32'} />}

      {state?.name === 'connecting' && (state.quietMs === undefined
        ? (
          <p className="m-0 mt-2 text-sm text-muted" role="status">
            Asking {INDEXER_HOST}… nothing is known yet — this is a wait, not a zero.
          </p>
        )
        : (
          <p className="m-0 mt-2 text-sm text-warn-text" role="status">
            Nothing has answered in {Math.round(state.quietMs / 1000)} seconds. Still
            trying — still a wait, not a zero — and the wallet will stop waiting on its
            own if the silence keeps.
          </p>
        ))}

      {state?.name === 'syncing' && (
        <p className="m-0 mt-2 text-sm text-muted" role="status">
          Reading {owner}&rsquo;s coins — {state.applied.toLocaleString()}{' '}
          {kind === 'unshielded' ? 'transactions' : 'events'} applied; the newest the
          indexer has reported is{' '}
          {state.highest === 0n ? 'not known yet' : state.highest.toLocaleString()}. No
          number until the wallet has seen them all.
        </p>
      )}

      {state?.name === 'synced' && (
        <>
          <div
            className={hero
              ? 'balance-big mt-1 font-sans text-display font-semibold text-ink'
              : 'balance-big mt-1 font-sans text-xl font-semibold text-ink'}
            aria-label={`${title} balance of ${owner}`}
          >
            {big(state.night)} <span className="balance-unit text-muted">{unit}</span>
          </div>
          <p className="m-0 mt-1 text-xs text-muted">
            Exactly {exact(state.night)}, as of {asClock(state.asOf)}.
          </p>
          {kind === 'shielded' && (
            /* THE PRIVATE BALANCE LINE, and the copy is the
             * point of it. It will read zero for a long time: this ledger has no
             * shield door, so shielded value is minted by contracts and nothing
             * can send it to a standalone wallet yet. The sentence has to be
             * honest about the mechanism without implying money may arrive that
             * cannot — **zero is a true answer to it.** */
            <p className="m-0 mt-1 text-xs text-faint">
              Money sent to you privately appears here. Nothing can send it yet: on this
              ledger private value is minted by a contract rather than moved in through a
              door, so a zero here is the true answer and not a wallet that has stopped
              looking.
            </p>
          )}
          {kind === 'dust' && state.night === 0n && (
            <p className="m-0 mt-1 text-xs text-faint">
              A real zero, not an unknown: DUST is not paid in — it grows over time from
              NIGHT that has been <strong>registered</strong> for generation, and this
              wallet has registered none yet. Without DUST no fee can be paid, so nothing
              can be sent.
            </p>
          )}
        </>
      )}

      {state?.name === 'failed' && (
        <>
          <div className="error mt-2" role="alert">
            The indexer could not be reached: {state.message}
          </div>
          <p className="m-0 mt-1 text-sm text-warn-text">
            This says nothing about the money — it is <strong>not a zero</strong>. The
            coins are on the chain; only the reading failed.
          </p>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------- the quick actions */

/**
 * FOUR SHORTCUTS, AND THE DIFFERENCE BETWEEN THEM IS THE ARCHITECTURE.
 *
 * **Send is a LINK and will never be a popup.** The interface's
 * first standing rule: *one surface approves anything that moves money*. Every
 * confirmation row in the sequence lives on that surface
 * — and a modal is exactly where a second approval path gets built by accident.
 * A later change redesigns that screen; this one only points at it.
 *
 * **Receive is a popup** because it moves nothing: an address, a code and a copy
 * control, with no approval path anywhere near it.
 *
 * **Earn is a popup that ships**, and is not a placeholder to remove — see
 * `ComingSoon` below.
 *
 * **The address book is a shortcut to a DESTINATION**, not an inline drawer.
 * Build it as a drawer now and converting it to a route later
 * is a rewrite. It is `notbuilt` until its own round; the shortcut is real.
 */
function QuickActions({ owned }: { readonly owned: OwnedAddress }): ReactNode {
  return (
    <ActionTiles aria-label="Shortcuts">
      <ActionTile
        href={hrefOf('send')}
        glyph={GLYPH.send}
        tone="accent"
        label="Send"
        says="Pay somebody from this wallet"
      />
      <ReceiveRow owned={owned} />
      <EarnRow />
      {/* THE TILE SAYS *Contacts*; THE ROUTE IS STILL `address-book`. The
        * words on a tile are what a person reads and the route name is what
        * the code and every recorded hash refer to — renaming the second to
        * follow the first would change a URL people may already have. */}
      <ActionTile
        href={hrefOf('address-book')}
        glyph={GLYPH.contacts}
        label="Contacts"
        says="People you pay, so an address is never typed twice"
      />
      {/*
        * MY PROFILE — A DOOR, ADDED BESIDE THE OTHERS RATHER THAN INSTEAD OF
        * ONE. `#/profile` existed and was reachable only from Settings, which
        * is two clicks and a guess; a person who has typed their name in once
        * looks for it where the wallet's other shortcuts are.
        *
        * **IT IS STILL NOT A PLACE.** The design keeps the
        * navigation at four on purpose. A shortcut is a door, and adding one
        * does not widen what the bottom bar or the rail holds.
        *
        * `quiet`, like its neighbours — **Send is the one accented tile on
        * this screen** and a second accent is no hierarchy at all.
        */}
      <ActionTile
        href={hrefOf('profile')}
        glyph={GLYPH.details}
        label="My profile"
        says="A company can ask; you decide what it gets"
      />
    </ActionTiles>
  );
}

/**
 * RECEIVE — the address, a code, and a copy control per address. Display only.
 *
 * TWO ADDRESSES, NOT ONE, AND UNSHIELDED FIRST. The design says *"address,
 * a QR, one copy control"*; this wallet has two payable addresses and
 * that showing only one is how 5000 tNIGHT once landed somewhere the interface
 * could not see. So it is one copy control PER ADDRESS, and dropping either
 * would delete a closed row's assertion rather than move it.
 *
 * The card takes an `OwnedAddress` and nothing else. There is no prop to
 * hand it a bare address, so the owner cannot be dropped or mismatched here or
 * by any future caller.
 */
function ReceiveRow({ owned }: { readonly owned: OwnedAddress }): ReactNode {
  const { address, unshieldedBech32, name, slot, owner } = owned;
  /* CONTROLLED RATHER THAN `DialogTrigger asChild`, AND IT IS A REAL
   * CONSTRAINT RATHER THAN A PREFERENCE. `asChild` goes through Radix's `Slot`,
   * which clones the child and hands it the trigger's own props and ref. `Slot`
   * can only do that to a component that SPREADS what it is given —
   * `kit/button.tsx` does, which is why the switcher's trigger is a `Button` —
   * and `kit/list-row.tsx` deliberately does not: it takes a fixed prop list so
   * a row cannot acquire arbitrary attributes at a call site. So the row keeps
   * its own `onClick` and this component owns the open state. Radix still
   * returns focus to the row on close, because it remembers what was focused
   * when the dialog opened rather than what the trigger was. */
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ActionTile
        onClick={() => setOpen(true)}
        glyph={GLYPH.receive}
        tone="accent"
        label="Receive"
        says="Your address and a code to scan"
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receive into {name}</DialogTitle>
          <DialogDescription>
            Nothing here moves money. Both addresses below are real and payable on{' '}
            {address.network}; when comparing either, check <strong>both ends</strong> —
            every address on this network starts with the same run of characters.
          </DialogDescription>
        </DialogHeader>
        <p className="wallet-owner m-0 flex items-center gap-2">
          <Mark address={address.bech32} account={owned.account} size={22} />
          <strong className="text-sm font-semibold text-ink">{name}</strong>
          {owner !== name && <span className="text-xs text-faint">{slot}</span>}
        </p>
        <AddressBlock
          kind="unshielded"
          title="Unshielded NIGHT"
          says={(
            <>
              Ordinary NIGHT transfers pay here — and the stagenet faucet pays{' '}
              <strong>only</strong> here: it rejects shielded and DUST addresses.
            </>
          )}
          bech32={unshieldedBech32}
          short={shortUnshielded(unshieldedBech32)}
          owner={owner}
        />
        <AddressBlock
          kind="shielded"
          title="Shielded"
          says="Private payments — what this product’s payroll pays. Amounts and parties stay hidden on the chain."
          bech32={address.bech32}
          short={shortPayee(address)}
          owner={owner}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One renderer for both strings, so neither can quietly lose its
 * both-ends treatment or the owner in its copy confirmation.
 *
 * THE TYPOGRAPHY CLASSES ARE `app.css`'s AND STAY THERE. `.address-short`,
 * `.net`, `.end` and `.address-full` are how an address is drawn in this
 * wallet, and `screens/send.tsx` and `screens/recover.tsx` draw addresses the
 * same way. Moving them into the kit is a change to three screens, which is not
 * this change.
 */
function AddressBlock({ kind, title, says, bech32, short, owner }: {
  readonly kind: 'unshielded' | 'shielded';
  readonly title: string;
  readonly says: ReactNode;
  readonly bech32: string;
  readonly short: string;
  readonly owner: string;
}): ReactNode {
  const parts = splitShortAddress(short);
  return (
    <div data-addr={kind} className="rounded-tight border border-line p-3">
      <h3 className="m-0 text-sm font-semibold text-ink">{title}</h3>
      <p className="m-0 mt-1 text-xs text-muted">{says}</p>
      <div
        className="address-short"
        aria-label={`${title} address of ${owner}, short form: ${short}`}
      >
        <span className="net">{parts.network}</span>
        <span className="end">{parts.head}</span>
        {parts.tail !== null && (
          <>
            <span className="gap">…</span>
            <span className="end">{parts.tail}</span>
          </>
        )}
      </div>
      {/* Capped: at the panel's full width the second address block is pushed
        * off the popup, and a code this size still scans. */}
      <div className="max-w-[10rem]">
        <QrPanel
          payload={bech32}
          caption={`${title} address of ${owner}, as a code to scan`}
          testId={`receive-${kind}`}
          bare
        />
      </div>
      <CopyButton
        text={bech32}
        label={`Copy the ${kind} address`}
        copied={`Copied — the ${kind} address of ${owner}`}
      />
      <details className="reveal" style={{ marginTop: '0.6rem' }}>
        <summary>Show the whole address</summary>
        <p className="muted small" style={{ margin: '0.5rem 0 0.25rem' }}>
          The full {kind} address of {owner}:
        </p>
        <div className="address-full">{bech32}</div>
      </details>
    </div>
  );
}

/**
 * EARN — COMING SOON, AND IT SHIPS. The roadmap is visible on purpose and
 * roadmap signalling in a wallet is ordinary. **This is not a placeholder
 * somebody forgot to remove, and the next person to read this file should not
 * "fix" it by deleting it.**
 *
 * **THE WORDS WERE DECIDED THE OTHER WAY, AND THIS COMMENT IS CORRECTED RATHER
 * THAN LEFT TO BE RE-LITIGATED.** It used to argue that *"Coming soon"* puts a
 * date in the reader's head that nobody has committed to, and this popup said
 * *Not built yet* instead. Then `screens/explore.tsx` shipped six tiles saying
 * *Coming soon* and named the disagreement rather than absorbing it — *"one of
 * the two should win, and this file is not where that is decided."* It is
 * decided: **Coming soon is the wording, everywhere a planned feature is
 * named.** Two rooms of one wallet using two phrases for one state is worse
 * than either phrase, and the argument against this one was never that it was
 * false — only that it was warmer than the alternative.
 *
 * WHAT THE OLD COMMENT WAS RIGHT ABOUT IS KEPT AND IS THE PART UNDER TEST.
 * **The test is whether the sentence is still true in a year**, so nothing
 * here names a month, a quarter, a season or a version, and the body still
 * says outright that there is no date and this screen will not invent one.
 * *Soon* is a temperature; *Q3* is a promise. Only the second is forbidden.
 *
 * NOT `screens/notbuilt.tsx`. That screen is about a ROUTE WITH NO SCREEN
 * BEHIND IT — a different statement, in different words, and untouched.
 */
function EarnRow(): ReactNode {
  /* Controlled for the same reason `ReceiveRow` is — see the note there. */
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ActionTile
        onClick={() => setOpen(true)}
        glyph={GLYPH.earn}
        label="Earn"
        says="Coming soon"
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Earn is coming soon</DialogTitle>
          <DialogDescription>
            This is where staking and yield will live — putting NIGHT to work without
            handing it to anybody.
          </DialogDescription>
        </DialogHeader>
        <p className="m-0 text-sm text-muted">
          There is no date for it and this screen will not invent one. When it exists it
          will name every host it dials, the way the rest of this wallet does, and
          nothing will move without going through the same approval screen a payment
          does.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------- recent activity */

/**
 * RECENT ACTIVITY — the link is what makes this change additive.
 *
 * **THE LIST IS EMPTY BECAUSE NOTHING READS HISTORY YET, AND THE SCREEN SAYS
 * THAT RATHER THAN SHOWING AN EMPTY LIST OF PAYMENTS.** The same discipline
 * applied to a list instead of a balance: *"nothing here yet"* and *"we have
 * not asked"* are different sentences, and only one of them is true here.
 * `facade.getAllFromTxHistory()` exists and Activity's own round wires it; a
 * home screen that printed "no payments" today would be making a claim about
 * money out of a feature that is not built.
 *
 * "View all" IS A LINK TO A PLACE, never a drawer — the rule that
 * makes a right panel a later addition instead of a rewrite.
 *
 * THE AFFORDANCE MOVED AND THE RULE DID NOT. It was a `View all`
 * link in the footer; it is the card header's action slot now, holding a
 * chevron. **It is still an anchor and it still goes to `#/activity`** — the
 * rule at the top of this comment is the one thing about it that may never
 * change, and the test asserts the `href` rather than the words.
 *
 * THE WORDS DID NOT DISAPPEAR, THEY MOVED INTO THE ACCESSIBLE NAME. An
 * icon-only control with no name is an unnamed link in a screen reader's list,
 * which is worse than the footer it replaced.
 */
function RecentActivity(): ReactNode {
  return (
    <Card>
      <CardHeader
        action={(
          <ButtonLink
            variant="ghost"
            size="icon"
            href={hrefOf('activity')}
            aria-label="View all activity"
            title="View all activity"
          >
            <Icon glyph={GLYPH.next} className="size-5" />
          </ButtonLink>
        )}
      >
        <CardTitle>Recent activity</CardTitle>
      </CardHeader>
      <CardContent>
        <EmptyState icon={GLYPH.inbox} title="Payment history is not read on this screen yet">
          The wallet SDK already answers for it — this is a screen to build, not a
          capability to invent. Nothing above is a statement that no payments exist.
        </EmptyState>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------- the securing state */

/**
 * §7.15's third state: no record stands for this account, and it arrived by
 * recovery a moment ago — so "the money is gone if you lose this device" is
 * untrue on arrival and is not said. This browser does not know where the
 * pieces are; that is the whole claim.
 */
function RecoveredUnknownCard(): ReactNode {
  return (
    <Card aria-label="Where this account's pieces are is not known here">
      <CardHeader>
        <CardTitle>This account was just put back from its pieces.</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="m-0 text-sm text-muted">
          The pieces you used exist — you fetched them yourself. This browser could not
          write its own note of where they are, so it does not know, and this screen
          cannot tell you whether the account is secured. It does not follow that
          anything is wrong.
        </p>
        <p className="m-0 mt-3 text-xs text-faint">
          Cutting a new set from{' '}
          <a className="text-accent underline-offset-4 hover:underline" href={hrefOf('secure')}>
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
function PairedUnknownCard({ at }: { readonly at: number }): ReactNode {
  return (
    <Card aria-label="Where this account's pieces are is not known here">
      <CardHeader>
        <CardTitle>This wallet arrived from another device on {day(at)}.</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="m-0 text-sm text-muted">
          Whether it is secured — where its pieces are, if it has any — is recorded on
          the machine it came from, not here. This browser cannot tell, and does not
          guess.
        </p>
        <p className="m-0 mt-3 text-xs text-faint">
          You can check on the other machine, or cut a set from{' '}
          <a className="text-accent underline-offset-4 hover:underline" href={hrefOf('secure')}>
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
function SecuredCard({ setup }: { readonly setup: SecuredSetup }): ReactNode {
  /* A kept map is only this account's history if its fingerprint says so.
   * The rest is some other account's map, kept because destroying a map is never
   * ours to do — and its pieces do not open this account. */
  const ownOld = setup.superseded.filter((old) => old.fingerprint === setup.fingerprint);
  const foreignOld = setup.superseded.filter((old) => old.fingerprint !== setup.fingerprint);
  return (
    <Card aria-label="This account is secured">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="ok" aria-hidden="true">✓</span> Account secured
        </CardTitle>
        <CardDescription>
          {setup.partial
            ? `On ${day(setup.rebuiltAt)} this account was put back from ${setup.pieces.length} `
              + 'pieces fetched from where they were placed — the strongest check there is. '
              + 'These are the pieces you used; there may be others this browser does not '
              + 'know about.'
            : `On ${day(setup.rebuiltAt)} this account was cut into ${setup.pieces.length} pieces `
              + `and proved rebuildable from any ${setup.threshold}. One piece was read back from `
              + 'its card; you said the rest are placed.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div>
          {setup.pieces.map((piece) => (
            <div className="piece-row" key={`${piece.holder}:${piece.label}`}>
              <span className="who">{piece.label}</span>
              {piece.holder !== piece.label
                && <span className="faint small">{piece.holder}</span>}
              <span className={typeof piece.lastVerified === 'number' ? 'verified' : 'verified never'}>
                {verifiedWords(piece.lastVerified)}
              </span>
            </div>
          ))}
        </div>
        <p className="m-0 mt-3 text-xs text-faint">
          These pieces cover every subwallet too: all of them grow out of the one secret
          the pieces rebuild — including subwallets first used after the pieces were
          placed.
        </p>
        {ownOld.length > 0 && (
          <details className="reveal" style={{ marginTop: '0.75rem' }}>
            <summary>
              {ownOld.length === 1
                ? 'One earlier set was replaced — its pieces still work'
                : `${ownOld.length} earlier sets were replaced — their pieces still work`}
            </summary>
            <p className="warn-text small" style={{ margin: '0.5rem 0 0.25rem' }}>
              Replacing a plan adds a way in and never removes one: these pieces rebuild
              this account for as long as they exist, and nothing can switch them off.
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
              These pieces do <strong>not</strong> open this account — they belong to an
              account that was on this browser before. The list is kept because
              destroying a map is never this wallet&rsquo;s call: whoever owns that
              account may still need it.
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
function ThisDeviceCard({ secret }: { readonly secret: Secret }): ReactNode {
  const made = creationOf(secret);
  const linked = arrivalOf(secret);
  if (!made && !linked) return null;
  return (
    <Card aria-label="When this browser got this account">
      <CardContent className="flex items-center gap-3 pt-5">
        <Icon glyph={GLYPH.wallet} className="text-muted" />
        <p className="m-0 text-sm text-ink">
          {made
            ? `Created in this browser on ${day(made.at)}.`
            : `Linked on ${day(linked!.at)}.`}
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
function SetUp({ state }: {
  readonly state: 'secured' | 'unsecured' | 'unknown';
}): ReactNode {
  return (
    <Card aria-label="What to do next">
      <CardHeader>
        <CardTitle>Set up</CardTitle>
      </CardHeader>
      <CardContent>
        <ListRows>
          <ListRow
            href={hrefOf('secure')}
            leading={<Icon glyph={GLYPH.secured} className="text-muted" />}
            title="Secure your account"
            subtitle={state === 'secured'
              ? 'Done — revisit the pieces, re-verify them, or change the plan'
              : state === 'unsecured'
                ? 'The one thing worth doing first'
                : 'This browser does not know where this account’s pieces are'}
          />
          <ListRow
            href={hrefOf('add-device')}
            leading={<Icon glyph={GLYPH.wallet} className="text-muted" />}
            title="Add another device"
            /* `ListRow` truncates a subtitle on purpose (`kit/list-row.tsx`),
             * so these fit one line rather than the row growing to hold them.
             * The full sentence lives on the screen each one leads to. */
            subtitle="Scan a code and compare two digits on both screens"

          />
          <ListRow
            href={hrefOf('advanced')}
            leading={<Icon glyph={GLYPH.settings} className="text-muted" />}
            title="Advanced"
            subtitle="The recovery phrase, and the key others lock pieces to"
            trailing={<Badge>Coming soon</Badge>}
          />
        </ListRows>
        <p className="m-0 mt-3 text-xs text-faint">
          Recovering a <em>different</em> account onto this machine starts from the lock
          screen — press Lock first. It replaces the wallet stored here, and says so
          before it does.
        </p>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------- every wallet */

/**
 * HOW MANY SLOTS THE PREVIEW SHOWS WHEN NONE OF THEM IS KNOWN TO HOLD MONEY.
 * Three, by decision. It is a FLOOR: see the note on `AllWalletsCard`.
 */
const PREVIEWED = 3;

/**
 * EVERY WALLET, HONESTLY — and it is a PREVIEW of the switcher.
 *
 * WHAT IT IS FOR HAS NOT MOVED. Live sync follows the OPEN wallet only, and
 * this card is what keeps that decision from hiding money: each slot shows the
 * last number anyone established WITH ITS AGE, and a slot nobody has ever
 * checked says so in warning words — because a subwallet that never syncs is
 * one money can arrive in with nobody told, which is §2.3's invisible-money
 * trap arriving through a performance decision. **It is that trap on the screen**,
 * and six assertions stand on it.
 *
 * WHAT CHANGES. Eleven rows is a wall. So the card shows a
 * FEW, with a chevron in its header to the switcher, and **the sweep moves
 * into the switcher** where a person has asked to see all of them. One list,
 * three doors: the sidebar's chip, the money card's *Switch wallet*, and this
 * chevron all open the same surface.
 *
 * =====================================================================
 * THE FIRST THREE ARE NOT ALWAYS THREE, AND THAT IS THE RULE HOLDING.
 * =====================================================================
 *
 * THE RULE: *"a slot holding money is always listed, named or not …
 * three rows plus a chevron must not become a way for a funded slot to be
 * invisible. If 'the first three' can hide a slot that holds money, then it is
 * not the first three — a funded slot outranks an empty one for a place in
 * that list."*
 *
 * A rank alone does not finish the job: with FOUR funded slots, three rows
 * ranked perfectly still hide one of them. So the three is a FLOOR and not a
 * ceiling — every slot known to hold money is listed, and the preview is
 * topped up to three from the rest in slot order. In practice that is three
 * rows, because most slots are empty; the day it is five, it is five, and no
 * money is behind a press.
 *
 * AN UNCHECKED SLOT IS NOT AN EMPTY ONE and does not rank — it cannot, nothing
 * has asked. **That is what the warning sentence is for**, and it is computed
 * over all eleven rather than over the three shown, so shortening the list did
 * not shorten what the card admits.
 *
 * THE DERIVATION IS UNAFFECTED: the list is built from `WALLET_ACCOUNTS`, which never
 * contains account 1.
 */
function AllWalletsCard({ identity, secret, names, changed }: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly names: Readonly<Record<string, string>>;
  readonly changed: number;
}): ReactNode {
  const { rows } = useWalletBalances(identity, changed);

  /* THE RANK, IN ONE LINE, AND THE ONLY QUESTION IT ASKS THE NUMBER IS
   * WHETHER IT IS MORE THAN NOTHING (`holdsMoney`, `shell/wallet-balances.tsx`
   * — the one question whose answer is the same in every unit, which is why
   * this is not a second reader of the atomic figure). */
  const funded = WALLET_ACCOUNTS.filter((account) => holdsMoney(rowFor(rows, account)));
  const rest = WALLET_ACCOUNTS.filter((account) => !holdsMoney(rowFor(rows, account)));
  const shown = [...funded, ...rest.slice(0, Math.max(0, PREVIEWED - funded.length))]
    .sort((a, b) => a - b);
  const hidden = WALLET_ACCOUNTS.length - shown.length;

  return (
    <Card aria-label="Every wallet's last known balance">
      <CardHeader
        action={(
          <WalletSwitcher identity={identity} secret={secret}>
            <Button variant="ghost" size="icon" aria-label="See every wallet" title="See every wallet">
              <Icon glyph={GLYPH.next} className="size-5" />
            </Button>
          </WalletSwitcher>
        )}
      >
        <CardTitle>Every wallet</CardTitle>
        <CardDescription>
          Live checking follows the wallet that is open. The others show the last time
          anyone looked — and how long ago that was.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ListRows>
          {shown.map((account) => (
            <div
              key={account}
              /* `data-wallet-preview-row`, a NEW name for a NEW claim.
               * `data-wallet-balance-row` names *a row of the full eleven*
               * and moved to the switcher with them; this attribute names *a
               * row of the preview*, and keeping them apart is what lets a
               * test say which list it is looking at. */
              data-wallet-preview-row=""
              data-account={account}
              style={{ '--wallet-hue': String(hueOf(account)) } as CSSProperties}
            >
              <ListRow
                leading={<span className="wallet-swatch small" aria-hidden="true" />}
                title={displayNameOf(account, names)}
                trailing={<WalletBalanceCell row={rowFor(rows, account)} />}
              />
            </div>
          ))}
        </ListRows>
        {hidden > 0 && (
          <p className="m-0 mt-3 text-xs text-faint">
            {hidden === 1
              ? 'One more slot is not shown here.'
              : `${hidden} more slots are not shown here.`}{' '}
            Every slot this wallet has, and the control that checks them all, is behind
            the arrow above.
          </p>
        )}
        {anyNeverChecked(rows) && (
          <p className="m-0 mt-3 text-sm text-warn-text">
            A wallet never checked can be holding money nobody was told about — its
            address exists whether or not anyone looks.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------- the carried question */

/**
 * THE CARRIED QUESTION. A payment whose outcome was not
 * known when its screen closed does not become nobody's problem: the record
 * written before submission (`pending.ts`) surfaces HERE, on the screen a person
 * actually returns to, and resolves itself against the chain — on mount (every
 * start), then on a timer — with nobody pressing anything. When the answer
 * arrives it stays on this card until a person dismisses it, because an answer
 * nobody saw is not yet an answer.
 *
 * Renders NOTHING when there is nothing pending — most days, for most people,
 * this card does not exist.
 *
 * **IT WAS PLACED AND WAS NOT REBUILT.** Its words are unchanged and are not
 * this change's; the amber banner stays amber, and the two answer cards stay the
 * cards a person dismisses. Only the wrapper markup below is the kit's.
 */
export function PendingSendsCard({ secret, resolution }: {
  readonly secret: Secret;
  /** Injectable for tests; the app asks the real indexer by identifier. */
  readonly resolution?: ResolutionDoors;
}): ReactNode {
  const [records, setRecords] = useState<PendingSend[]>(() => loadPendingSends(secret));
  const doors = resolution;
  useEffect(() => {
    let stale = false;
    const refresh = (): void => { if (!stale) setRecords(loadPendingSends(secret)); };
    const resolve = (): void => {
      if (loadPendingSends(secret).every((r) => r.outcome !== null)) return;
      void resolvePendingSends(secret, doors ?? liveResolutionDoors())
        .then((settled) => { if (settled.length > 0) refresh(); })
        .catch(() => { /* silence is not an answer; the next round asks again */ });
    };
    resolve();
    const timer = setInterval(resolve, 15_000);
    return () => { stale = true; clearInterval(timer); };
  }, [secret, doors]);
  if (records.length === 0) return null;
  const dismiss = (key: string): void => {
    dismissPendingSend(secret, key);
    setRecords(loadPendingSends(secret));
  };
  return (
    <>
      {records.map((r) => {
        const amount = `${nightFromStars(BigInt(r.stars))} tNIGHT`;
        const to = `${r.recipientBech32.slice(0, 20)}…${r.recipientBech32.slice(-8)}`;
        if (r.outcome === null) {
          return (
            <section className="warn-banner" role="status" key={r.key}
              aria-label="A payment is still confirming"
            >
              <h2>A payment is still confirming.</h2>
              <p className="small">
                {amount} to {to}, handed to the network{' '}
                {new Date(r.submittedAt).toLocaleString()}. Whether it went through
                is not known yet — this wallet is watching the chain and will say
                sent or failed here, on its own. <strong>Do not send this payment
                again</strong>; the send screen refuses it while this one is
                unresolved.
              </p>
              <details className="reveal">
                <summary>The identifier{r.identifiers.length === 1 ? '' : 's'}, for checking elsewhere</summary>
                {r.identifiers.map((id) => <div className="address-full" key={id}>{id}</div>)}
              </details>
            </section>
          );
        }
        return r.outcome.name === 'sent' ? (
          <Card role="status" key={r.key} aria-label="A payment went through">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="ok" aria-hidden="true">✓</span> That payment went through.
              </CardTitle>
              <CardDescription>
                {amount} to {to} — submitted {new Date(r.submittedAt).toLocaleString()},
                confirmed on the chain by its identifier.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button onClick={() => dismiss(r.key)}>Understood</Button>
            </CardFooter>
          </Card>
        ) : (
          <Card role="alert" key={r.key} aria-label="A payment did not go through">
            <CardHeader>
              <CardTitle>A payment did not go through.</CardTitle>
              <CardDescription>
                {amount} to {to} — submitted {new Date(r.submittedAt).toLocaleString()}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="error">{r.outcome.reason}</div>
            </CardContent>
            <CardFooter>
              <Button onClick={() => dismiss(r.key)}>Understood</Button>
            </CardFooter>
          </Card>
        );
      })}
    </>
  );
}
