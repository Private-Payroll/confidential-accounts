import { useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity';
import { INDEXER_HOST } from '../config.js';
import type { BalanceState, StopBalance } from '../chain/balance.js';
import { BalanceEnginesContext } from '../chain/balance-context.js';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from '../chain/amount.js';
import { otherTokenLines, shortColour, smallestUnits } from '../chain/shielded-tokens.js';
import type { OwnedAddress } from '../accounts/owned-address.js';
import { MAIN_ACCOUNT, defaultNameOf, hueOf } from '../accounts/subwallets.js';
import { WalletSwitcher } from '../shell/switcher.js';
import { FAUCET_NAME } from './network-words.js';
import { Mark } from '../shell/mark.js';
import { Button, Card, CardContent, CardDescription, CardHeader, Input, Label, Separator, Skeleton } from 'vaults-ui';
import { StatusBadge } from '../components/status.js';
import { GLYPH, Glyph } from '../glyphs.js';

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
  {
    kind: 'unshielded',
    title: FAUCET_NAME === null
      ? 'Unshielded NIGHT — ordinary transfers'
      : 'Unshielded NIGHT — ordinary transfers, the faucet',
    hero: true,
  },
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
export function HeroCard({ identity, secret, owned, names, onRename, onEstablished }: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly owned: OwnedAddress;
  readonly names: Readonly<Record<string, string>>;
  readonly onRename: (name: string) => void;
  readonly onEstablished?: () => void;
}): ReactNode {
  const { account } = owned;
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
      <HeroHeader
        identity={identity}
        secret={secret}
        owned={owned}
        names={names}
        personal={personal}
        renaming={renaming}
        setDraft={setDraft}
        setRenaming={setRenaming}
      />

      <CardContent className="flex flex-col gap-4">
        <HeroRenameForm
          owned={owned}
          renaming={renaming}
          draft={draft}
          setDraft={setDraft}
          setRenaming={setRenaming}
          onRename={onRename}
        />

        <HeroBalances
          asked={asked}
          check={check}
          stateOf={stateOf}
          owned={owned}
          anySynced={anySynced}
          anyFailed={anyFailed}
        />
      </CardContent>
    </Card>
  );
}


function HeroHeader({ identity, secret, owned, names, personal, renaming, setDraft, setRenaming }: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly owned: OwnedAddress;
  readonly names: Readonly<Record<string, string>>;
  readonly personal: boolean;
  readonly renaming: boolean;
  readonly setDraft: (draft: string) => void;
  readonly setRenaming: (update: (now: boolean) => boolean) => void;
}): ReactNode {
  const { account, name } = owned;
  return (
    <>
      <CardHeader>
        {/* THE OWNER LINE: a number never appears without the wallet it
          * belongs to, and a personal name never travels without its slot. */}
        <div className="wallet-owner flex flex-wrap items-center gap-2">
          <Mark address={owned.address.bech32} account={account} size={28} />
          <StatusBadge tone="accent" data-wallet-name="">
            <strong className="font-semibold">{name}</strong>
          </StatusBadge>
          {owned.owner !== name && <span className="text-xs text-muted-foreground">{owned.slot}</span>}
          <span className="flex-1" />
          <WalletSwitcher identity={identity} secret={secret}>
            <Button type="button" variant="outline" size="sm">
              <Glyph icon={GLYPH.switcher} className="size-4" />
              Switch wallet
            </Button>
          </WalletSwitcher>
          <Button
            type="button"
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
            <Glyph icon={GLYPH.rename} className="size-4" />
          </Button>
        </div>
        <CardDescription>
          {account === MAIN_ACCOUNT
            ? 'The main wallet — what any Midnight wallet opens from these words.'
            : 'Its own address and its own money, under the same passkey and the same '
              + 'recovery pieces.'}
        </CardDescription>
      </CardHeader>
    </>
  );
}

/** The form that names or renames the wallet, shown only while it is open. */
function HeroRenameForm({ owned, renaming, draft, setDraft, setRenaming, onRename }: {
  readonly owned: OwnedAddress;
  readonly renaming: boolean;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly setRenaming: (open: boolean) => void;
  readonly onRename: (name: string) => void;
}): ReactNode {
  const { account } = owned;
  return (
    <>
        {renaming && (
          <form
            className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(draft);
              setRenaming(false);
            }}
          >
            <Label htmlFor="wallet-name" className="mb-2">
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
              <Button type="submit" variant="default" size="sm">Save the name</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              Naming a wallet is what makes it yours to find again. Names live in this
              browser only — after a recovery every wallet comes back and the names are
              the part you re-type. Leave it empty to go back to the slot&rsquo;s own name.
            </p>
          </form>
        )}
    </>
  );
}

/** What the card says about the three balances: not asked yet, or one line each. */
function HeroBalances({ asked, check, stateOf, owned, anySynced, anyFailed }: {
  readonly asked: boolean;
  readonly check: () => void;
  readonly stateOf: (kind: 'unshielded' | 'shielded' | 'dust') => BalanceState | null;
  readonly owned: OwnedAddress;
  readonly anySynced: boolean;
  readonly anyFailed: boolean;
}): ReactNode {
  return (
    <>
        {!asked ? (
          <div>
            <p className="m-0 text-sm text-muted-foreground">
              Not asked yet. Checking reads all three balances — unshielded NIGHT,
              shielded, and DUST, which pays fees — and asks the indexer at{' '}
              {INDEXER_HOST}, which learns this wallet&rsquo;s addresses. Nothing is sent
              until you press.
            </p>
            <Button type="button" variant="default" className="mt-3" onClick={check}>
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
              <p className="m-0 text-xs text-muted-foreground">
                1 NIGHT = 1,000,000 STARs and 1 DUST = 10^15 SPECKs — the
                Foundation&rsquo;s own figures.
              </p>
            )}
            {anyFailed && <Button type="button" variant="outline" onClick={check}>Try again</Button>}
          </>
        )}
    </>
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
  const arriving = state?.name === 'connecting' || state?.name === 'syncing';
  return (
    <div data-kind={kind} aria-busy={arriving ? 'true' : undefined}>
      <h3 className="m-0 text-sm font-medium text-muted-foreground">
        {title}
      </h3>

      {state === null && (
        <p className="m-0 mt-1 text-sm text-muted-foreground" role="status">Not asked yet.</p>
      )}

      {arriving && <Skeleton className={hero ? 'mt-2 h-11 w-56' : 'mt-2 h-6 w-32'} />}

      {state?.name === 'connecting' && (state.quietMs === undefined
        ? (
          <p className="m-0 mt-2 text-sm text-muted-foreground" role="status">
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
        <p className="m-0 mt-2 text-sm text-muted-foreground" role="status">
          Reading {owner}&rsquo;s coins — {state.applied.toLocaleString()}{' '}
          {kind === 'unshielded' ? 'transactions' : 'events'} applied; the newest the
          indexer has reported is{' '}
          {state.highest === 0n ? 'not known yet' : state.highest.toLocaleString()}. No
          number until the wallet has seen them all.
        </p>
      )}

      {state?.name === 'synced' && (
        <SyncedFigure kind={kind} title={title} hero={hero} state={state} owner={owner} />
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

/** The balance once the wallet has seen every event: the figure, the exact amount, and what the line says about its kind. */
function SyncedFigure({ kind, title, hero, state, owner }: {
  readonly kind: 'unshielded' | 'shielded' | 'dust';
  readonly title: string;
  readonly hero: boolean;
  readonly state: Extract<BalanceState, { name: 'synced' }>;
  readonly owner: string;
}): ReactNode {
  const big = kind === 'dust' ? dustFromSpecks : nightFromStars;
  const exact = kind === 'dust' ? exactSpecks : exactStars;
  const unit = kind === 'dust' ? 'tDUST' : 'tNIGHT';
  return (
        <>
          <div
            className={hero
              ? 'balance-big mt-1 font-sans text-3xl tracking-tight font-semibold text-foreground'
              : 'balance-big mt-1 font-sans text-xl font-semibold text-foreground'}
            aria-label={`${title} balance of ${owner}`}
          >
            {big(state.night)} <span className="balance-unit text-muted-foreground">{unit}</span>
          </div>
          <p className="m-0 mt-1 text-xs text-muted-foreground">
            Exactly {exact(state.night)}, as of {asClock(state.asOf)}.
          </p>
          {kind !== 'dust' && state.others !== undefined
            && otherTokenLines(state.others).map(([colour, amount]) => (
              /* EVERY OTHER TOKEN THIS LINE HOLDS, private on the shielded line
               * and public on the unshielded one, one plain line each, after
               * NIGHT's. The wallet has no name and no scale for these, so the
               * amount is in the token's smallest unit and the token is named by
               * its colour: short, with the whole colour beside it. Only held
               * tokens get a line; there is no zero line for a token not held. */
              <p key={colour} className="m-0 mt-1 text-sm text-foreground" data-token={colour}>
                {smallestUnits(amount)} of token{' '}
                <span className="font-mono" title={colour}>{shortColour(colour)}</span>
                <span className="block break-all font-mono text-xs text-muted-foreground">{colour}</span>
              </p>
            ))}
          {kind === 'shielded' && state.others === undefined && (
            /* A SAVED FIGURE FROM BEFORE OTHER TOKENS WERE RECORDED. It knows
             * NIGHT and nothing else, so it says that, rather than showing no
             * other token as if there were none. */
            <p className="m-0 mt-1 text-xs text-muted-foreground" data-others="not-recorded">
              Other private tokens are not recorded in this saved figure. A completed
              check of this wallet&rsquo;s balance reads them.
            </p>
          )}
          {kind === 'shielded' && (
            /* THE PRIVATE BALANCE LINE, and the copy is the point of it. Private
             * value on this ledger is minted by a contract; there is no step that
             * moves public NIGHT in. A mint writes its amount into the public
             * record even though the coin it makes is private, so the sentence
             * says so rather than calling everything on this line private from
             * the start. A zero is what the last completed read found. */
            <p className="m-0 mt-1 text-xs text-muted-foreground">
              Money sent to you privately appears here: NIGHT above, and any other
              token on its own line, in that token&rsquo;s smallest unit. Private value on
              this ledger is minted by a contract, and the amount of a mint is public on
              the chain even though the coin it makes is private. A zero here is what the
              last completed check found, not a wallet that has stopped looking.
            </p>
          )}
          {kind === 'dust' && state.night === 0n && (
            <p className="m-0 mt-1 text-xs text-muted-foreground">
              A real zero, not an unknown: DUST is not paid in — it grows over time from
              NIGHT that has been <strong>registered</strong> for generation, and this
              wallet has registered none yet. Without DUST no fee can be paid, so nothing
              can be sent.
            </p>
          )}
        </>
  );
}
