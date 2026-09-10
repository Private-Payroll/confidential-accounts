import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import { REGISTRY } from 'midnight-identity/profile/attributes';
import type { Registry } from 'midnight-identity/profile/attributes';
import { abbreviate, check } from 'midnight-identity/profile/definition';
import type { AttributeDefinition } from 'midnight-identity/profile/definition';
import {
  ProfileError, changed, editValue, emptyProfile, forgetValue, heldAbout, relabel, selfAssert,
} from 'midnight-identity/profile/model';
import type { Disclosure, Held, Profile, Says, Stale } from 'midnight-identity/profile/model';
import { browserPort, load, save } from 'midnight-identity/profile/store';
import type { Port } from 'midnight-identity/profile/store';
import type { Opened } from 'midnight-identity/profile/seal';
import {
  Alert, Badge, Button, ButtonLink, Card, CardContent, CardHeader, CardTitle,
  Input, Label, Section, Separator,
} from '../kit/index.js';
import { hrefOf } from '../routes.js';
import { heldWallets } from '../accounts/wallets-held.js';
import { sayingForUnopenable } from '../lib/unopenable-details.js';

/**
 * MY PROFILE — the plain screen.
 *
 * **THE SCREEN IS CALLED *MY PROFILE*; THE COPY ON IT STILL SAYS *YOU*.** The
 * name of a thing and the voice it speaks in are different decisions: a person
 * looks for *my profile* in a list of destinations, and once inside it, a
 * wallet that said *facts about the user* rather than *facts about you* would
 * be talking about them instead of to them. The route is `#/profile` and does
 * not move — a route name is what the code, the walk and any kept hash refer
 * to.
 *
 * **THIS IS NOT A UI ROUND**. What is here is enough to enter
 * a profile, see what is held, and read what has been sent — plain, honest and
 * undesigned. A dedicated UI round dresses it.
 *
 * **EVERY FIELD ON THIS SCREEN COMES OUT OF THE REGISTRY AND NOTHING HERE
 * KNOWS AN ATTRIBUTE'S NAME.** §3.4's rule, and the reason `registry` is a
 * prop: `registry-open.test.ts` renders this same component with a registry
 * carrying one extra entry and drives that entry end to end, with **not one
 * line of this file changing.** The only `switch` below is on the RULE's KIND
 * — four arms for four shapes of input — which is the cost `definition.ts`
 * names deliberately.
 *
 * **SELF-ASSERTED AND ISSUED NEVER LOOK ALIKE** (§3.1), and an issued record
 * shows its date beside it — the same rule §7.12 imposes on
 * `rebuiltAt`, for the same reason: a mark with no date is a prediction.
 */

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * WHAT ONE `Says` READS AS — one function, so a held row, the changed-value
 * notice and the record cannot drift into three spellings of one value.
 */
const saysText = (says: Says): string => (says.of === 'value'
  ? says.value
  : `${says.predicate}: ${says.result ? 'yes' : 'no'}`);

/**
 * WHERE A LABEL EARNS ITS PLACE — READ OFF THE REGISTRY, NOT OFF A NAME.
 *
 * **A PERSON TELLS TWO EMAILS APART BY READING THEM**, and two first names the
 * same way. A box asking them to nickname one is a control standing in front
 * of the one that matters, and adding a second value is typing in the field
 * and pressing Add — it needs nothing else. Two shielded addresses are not
 * like that: `mn_shield-addr_stagenet1w02mvw…` and
 * `mn_shield-addr_stagenet1kaycku…` share everything a person can see at a
 * glance, and the label is the only thing that distinguishes them.
 *
 * `abbreviate: 'middle'` IS EXACTLY THAT PROPERTY, AND IT IS ALREADY IN THE
 * REGISTRY. `definition.ts` shortens from BOTH ENDS, precisely where
 * keeping the head alone would let two different strings look identical, which
 * is the same sentence as *these cannot be told apart by looking*. `'none'` is
 * shown whole and `'domain'` keeps the part a person reads, so neither needs a
 * label to be legible.
 *
 * **NOTHING HERE KNOWS AN ATTRIBUTE'S NAME** (§3.4). Add an opaque attribute
 * to `attributes.ts` and its label field appears with it; make an existing one
 * legible and the field goes. The registry is still the only vocabulary, and
 * this change read one flag from it rather than restructuring anything.
 */
const labelTellsThemApart = (definition: AttributeDefinition): boolean =>
  definition.render.abbreviate === 'middle';

/**
 * THE WAY OUT, AT THE TOP AS WELL AS THE FOOT.
 *
 * The foot of this page is a long way down and a person arriving from Home's
 * shortcut looks at the top for the way back. **It goes HOME rather than back
 * one step**: the hash can be pasted, and this wallet costs an unlock on
 * reload, so the browser's own back button is not a way out of anywhere.
 */
function BackToWallet(): ReactNode {
  return (
    <p className="m-0">
      <ButtonLink href={hrefOf('home')} variant="ghost" size="sm">
        ← Back to your wallet
      </ButtonLink>
    </p>
  );
}

/**
 * THE ONE SWITCH, AND IT IS ON THE KIND RATHER THAN ON THE ATTRIBUTE.
 * Adding an attribute adds no arm here. Adding a KIND does.
 */
function FieldFor({ definition, value, onChange, id, invalid }: {
  readonly definition: AttributeDefinition;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly id: string;
  readonly invalid: boolean;
}): ReactNode {
  const rule = definition.validate;
  const common = {
    id,
    value,
    'aria-invalid': invalid ? true : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  switch (rule.of) {
    case 'enum':
      return (
        <select
          {...common}
          data-kind="enum"
          className="block w-full rounded-tight border border-line-strong bg-bg px-3 py-2 text-base text-ink"
        >
          <option value="">Choose…</option>
          {rule.members.map((member) => (
            <option key={member.value} value={member.value}>{member.label}</option>
          ))}
        </select>
      );
    case 'date':
      return <Input {...common} type="date" data-kind="date" />;
    case 'number':
      return <Input {...common} type="number" data-kind="number" inputMode="decimal" />;
    case 'text':
    default:
      return <Input {...common} type="text" data-kind="text" maxLength={rule.of === 'text' ? rule.maxLength : undefined} />;
  }
}

/** One held record, shown with its provenance. */
function HeldRow({ definition, held, onEdit, onLabel, onForget }: {
  readonly definition: AttributeDefinition;
  readonly held: Held;
  readonly onEdit: (id: string, text: string) => void;
  readonly onLabel: (id: string, text: string) => void;
  readonly onForget: (id: string) => void;
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  const issued = held.asserted.by === 'issuer';
  return (
    <li data-held={held.id} data-about={held.about} className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        {/*
          * AN OPAQUE VALUE HAS NO SPACES IN IT, SO IT BREAKS ANYWHERE OR IT
          * BREAKS THE CARD. A shielded address is sixty-odd characters with
          * nothing a line-breaker can use, so wrapped on word boundaries it
          * runs straight out through the card's right edge and onto the page.
          * `break-all` is what `screens/settings.tsx` and `screens/approve.tsx`
          * already put on a host, an origin and a hash; `min-w-0` is what lets
          * a flex child shrink below the width of its own content at all.
          */}
        <span data-role="says" className="min-w-0 text-base break-all text-ink">
          {held.says.of === 'value'
            ? abbreviate(definition, held.says.value)
            /* A CLAIM, not a value. There is no text to abbreviate: what is
             * held is *this predicate, this answer*, and §3.2c is the whole
             * reason it can be shown at all without inventing a subject. */
            : `${held.says.predicate}: ${held.says.result ? 'yes' : 'no'}`}
        </span>
        {held.label !== '' && <span className="text-sm text-muted">({held.label})</span>}
        {/*
          * §3.1 — SELF AND ISSUER ARE NEVER SHOWN THE SAME WAY, ANYWHERE. A
          * self-typed name that renders like a verified one is a lie the
          * product tells on somebody else's behalf. And an issued record
          * NEVER appears without its date.
          */}
        {held.asserted.by === 'issuer' ? (
          <span data-provenance="issuer" className="text-sm text-good">
            {`Checked by ${held.asserted.issuer} on ${dateOf(held.asserted.issuedAt)}`}
            {held.asserted.expiresAt !== null
              && ` · good until ${dateOf(held.asserted.expiresAt)}`}
          </span>
        ) : (
          <span data-provenance="self" className="text-sm text-muted">
            You typed this. Nobody has checked it.
            {held.asserted.by === 'self' && held.asserted.formerly !== null
              && ` It was checked by ${held.asserted.formerly.issuer} on `
                + `${dateOf(held.asserted.formerly.issuedAt)} until you changed it.`}
          </span>
        )}
      </div>
      {held.asserted.by === 'issuer' && held.asserted.reachableAt !== null && (
        <p className="m-0 text-sm text-muted">
          {'If you ever lose this, ask them again: '}
          <span className="font-mono break-all">{held.asserted.reachableAt}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {held.says.of === 'value' ? (
          editing === null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(held.says.of === 'value' ? held.says.value : '')}
            >
              {`Change this ${definition.render.label.toLowerCase()}`}
            </Button>
          ) : (
            <>
              <Input
                aria-label={`New ${definition.render.label.toLowerCase()}`}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => { onEdit(held.id, editing); setEditing(null); }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              {issued && (
                <p className="m-0 basis-full text-sm text-warn" data-warn="drops-to-self">
                  Changing this removes the check. The signature is over what they said, so
                  edited text is no longer something they vouched for — it becomes something
                  you typed. You can ask them again afterwards.
                </p>
              )}
            </>
          )
        ) : (
          <span className="text-sm text-muted">
            This was proved about you. There is no text in it to change — it can only be
            proved again.
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => onForget(held.id)}>Remove</Button>
      </div>
      {/*
        * THE LABEL IS OFFERED WHERE IT IS THE ONLY WAY TO TELL TWO VALUES
        * APART, AND NOWHERE ELSE. It is still in the model and still in the
        * store — `relabel` is untouched — and a value that already carries one
        * still prints it beside itself above. What has gone is the box on
        * every row of every attribute, which was the loudest control on this
        * screen and the least useful on almost all of it.
        */}
      {/* A CLAIM HAS NOTHING TO TELL APART BY LOOKING. `not-listed: yes` is not
        * a string two of which could be confused, and `abbreviate` never
        * touches it — so the field belongs to held VALUES and not to every
        * record of an opaque attribute. */}
      {labelTellsThemApart(definition) && held.says.of === 'value' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`label-${held.id}`}>
            {`How you will recognise this ${definition.render.label.toLowerCase()} later`}
          </Label>
          <Input
            id={`label-${held.id}`}
            placeholder="work, personal…"
            defaultValue={held.label}
            onBlur={(e) => onLabel(held.id, e.target.value)}
          />
        </div>
      )}
    </li>
  );
}

function AddOne({ definition, onAdd }: {
  readonly definition: AttributeDefinition;
  readonly onAdd: (text: string, label: string) => string | null;
}): ReactNode {
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [says, setSays] = useState<string | null>(null);
  const id = `add-${definition.name}`;
  return (
    <div className="flex flex-col gap-2" data-add={definition.name}>
      {/* NOT the same words as the section heading above it. Two visible
        * labels reading identically is one label as far as a person is
        * concerned and two as far as a screen reader is. */}
      <Label htmlFor={id}>{`New ${definition.render.label.toLowerCase()}`}</Label>
      {/* THE HINT IS NOT PRINTED AGAIN HERE. The `Section` around this card
        * already carries `render.hint` as its description, and the same
        * sentence twice on one screen reads as two instructions until you
        * notice they are identical. One copy, under the heading. */}
      <FieldFor
        definition={definition}
        id={id}
        value={text}
        invalid={says !== null}
        onChange={(next) => { setText(next); setSays(null); }}
      />
      {/*
        * NOT GATED ON `multiple`, AND THAT WAS THE OLD MISTAKE. `multiple` is
        * `true` for all three shipped attributes, so gating on it put this box
        * on a first name, a last name and an email alike — and none of those
        * three needs one. It is gated on whether the VALUE can be told apart
        * by looking, which is a different question and the one that matters.
        * INLINE rather than behind a disclosure: where it is offered at all it
        * is the thing that makes the value findable later, and a control you
        * have to go looking for is one nobody sets.
        */}
      {labelTellsThemApart(definition) && (
        <div className="flex flex-col gap-1" data-label-field={definition.name}>
          <Label htmlFor={`${id}-label`}>
            {`How you will recognise this ${definition.render.label.toLowerCase()} later`}
          </Label>
          <Input
            id={`${id}-label`}
            placeholder="work, personal…"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      )}
      {says !== null && <p className="m-0 text-sm text-bad" role="alert">{says}</p>}
      <div>
        <Button
          size="sm"
          onClick={() => {
            const outcome = onAdd(text, label);
            if (outcome === null) { setText(''); setLabel(''); setSays(null); } else setSays(outcome);
          }}
        >
          {`Add ${definition.render.label.toLowerCase()}`}
        </Button>
      </div>
    </div>
  );
}

function StaleList({ stale }: { readonly stale: readonly Stale[] }): ReactNode {
  if (stale.length === 0) return null;
  return (
    <Alert tone="warning" role={null} title="Some of these have changed since you sent them">
      <ul className="m-0 flex list-none flex-col gap-1 p-0" data-stale>
        {stale.map((row, at) => (
          <li
            key={`${row.recipient.origin}-${row.about}-${at}`}
            className="text-sm break-words"
          >
            {/* The sentence wraps on its spaces; the ORIGIN and the VALUES are
              * opaque strings and break anywhere, or they leave the alert. */}
            {`${row.recipient.name} (`}
            <span className="break-all">{row.recipient.origin}</span>
            {') holds '}
            <strong className="break-all">{saysText(row.theyHold)}</strong>
            {` from ${dateOf(row.sentAt)}. `}
            {row.itNowSays === null ? 'You no longer hold that detail.' : (
              <>
                {'It now says '}
                <span className="break-all">{saysText(row.itNowSays)}</span>
                {'.'}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm">
        {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. This wallet can tell you
          * about the gap. It cannot close it, and it will not pretend to. */}
        This wallet cannot update them and cannot take anything back. If it matters, tell
        them yourself.
      </p>
    </Alert>
  );
}

/**
 * THE RECORD, GROUPED FOR READING — and the rule that constrains every line of
 * it: **GROUPING MAY SUMMARISE; IT MAY NEVER DROP AN EVENT.**
 *
 * Eighteen consecutive sign-ins were eighteen identical lines running down the
 * page, and a wall is not a record — nobody reads the eighteenth, so nobody
 * notices the nineteenth is a disclosure. Consecutive entries that say the SAME
 * THING collapse into one line that states how many and over what span, and
 * **every one of them is still rendered**, inside a `details` that opens.
 *
 * WHAT MAKES TWO ENTRIES THE SAME IS `keyOf`, AND IT DELIBERATELY IGNORES THE
 * DATE. Two events on different days that say the same thing are what a run is;
 * two events with different values are never one line, whatever their dates.
 *
 * A SIGN-IN AND A SEND ARE NEVER ONE RUN, and not because of a special case:
 * `keyOf` puts a sign-in in a class of its own, which is the rule falling
 * out of the grouping rather than being bolted onto it. They also carry
 * different marks, so the difference survives at arm's length from the screen.
 */
const keyOf = (row: Disclosure): string => (row.kind === 'sign-in'
  ? 'sign-in'
  : `sent:${row.sent.map((one) => saysText(one.says)).join('|')}`
    + `/declined:${[...row.declined].join('|')}`);

interface Run {
  readonly key: string;
  readonly rows: readonly Disclosure[];
}

function runsOf(disclosures: readonly Disclosure[]): readonly Run[] {
  const runs: { key: string; says: string; rows: Disclosure[] }[] = [];
  for (const row of disclosures) {
    const says = keyOf(row);
    const open = runs.length === 0 ? undefined : runs[runs.length - 1];
    if (open !== undefined && open.says === says) open.rows.push(row);
    else runs.push({ key: row.nonce, says, rows: [row] });
  }
  return runs;
}

/**
 * THE SENTENCE A RUN MAKES — one event or eighteen, through one function, so a
 * collapsed line cannot say something a single line would not have said.
 * With one row it is word-for-word what this screen has always printed.
 */
function sentenceOf(rows: readonly Disclosure[], from: string, to: string): string {
  const row = rows[0];
  if (row === undefined) return '';
  const when = from === to ? `On ${from}` : `Between ${from} and ${to}`;
  const many = rows.length > 1;
  /*
   * **A SIGN-IN IS NOT A DISCLOSURE THAT SENT NOTHING.** Both are recorded
   * here and both are normal; saying *you sent: nothing* for the first would be
   * this record telling a person the wrong true-sounding thing about the one
   * subject it exists to be true about.
   */
  if (row.kind === 'sign-in') {
    return `${when} you signed in${many ? ` ${rows.length} times` : ''}. `
      + 'Nothing about you was sent.';
  }
  const sent = row.sent.length === 0
    ? 'nothing'
    : row.sent.map((one) => saysText(one.says)).join(', ');
  const declined = row.declined.length === 0
    ? ''
    : `. You said no to: ${row.declined.join(', ')}`;
  return `${when} you sent${many ? ` the same thing ${rows.length} times` : ''}`
    + `: ${sent}${declined}`;
}

/**
 * THE MARK. Colour is never the only carrier — the word inside is the fact —
 * but at arm's length the mark is what separates a page of sign-ins from the
 * one line on it where something about a person left this wallet.
 */
function KindMark({ row }: { readonly row: Disclosure }): ReactNode {
  if (row.kind === 'sign-in') return <Badge tone="neutral">Signed in</Badge>;
  return row.sent.length === 0
    ? <Badge tone="neutral">Sent nothing</Badge>
    : <Badge tone="accent">Sent</Badge>;
}

/** One event, on one line, exactly as it has always read. */
function EventLine({ row }: { readonly row: Disclosure }): ReactNode {
  const on = dateOf(row.at);
  const line = sentenceOf([row], on, on);
  return (
    <>
      <KindMark row={row} />
      {row.kind === 'sign-in'
        ? <span data-sign-in-entry className="min-w-0 text-sm break-all">{line}</span>
        : <span className="min-w-0 text-sm break-all">{line}</span>}
    </>
  );
}

function RunEntry({ run }: { readonly run: Run }): ReactNode {
  const first = run.rows[0];
  if (first === undefined) return null;
  if (run.rows.length === 1) {
    return (
      <li className="flex flex-wrap items-baseline gap-2" data-entries="1">
        <EventLine row={first} />
      </li>
    );
  }
  /* MIN AND MAX RATHER THAN FIRST AND LAST: the span is a claim about when
   * these events happened, and it must not depend on the order they were
   * appended in. */
  const times = run.rows.map((row) => row.at);
  const line = sentenceOf(run.rows, dateOf(Math.min(...times)), dateOf(Math.max(...times)));
  return (
    <li data-entries={run.rows.length}>
      <details className="reveal">
        <summary>
          <span className="inline-flex flex-wrap items-baseline gap-2 align-middle">
            <KindMark row={first} />
            <span className="min-w-0 break-all">{line}</span>
          </span>
        </summary>
        {/* EVERY EVENT, STILL HERE, each with its own date. */}
        <ul
          className="m-0 mt-2 flex list-none flex-col gap-1 border-l border-line py-0 pr-0 pl-3"
          data-run-entries
        >
          {run.rows.map((row) => (
            <li key={row.nonce} className="flex flex-wrap items-baseline gap-2">
              <EventLine row={row} />
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function ProfileScreen({ identity, registry = REGISTRY, port = browserPort() }: {
  readonly identity: Identity;
  /** A PROP so §3.4's proof can drive this screen with one extra entry. */
  readonly registry?: Registry;
  readonly port?: Port;
}): ReactNode {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<Opened | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void load(port, identity).then((opened) => {
      if (!alive) return;
      setState(opened);
      setProfile(opened.of === 'profile' ? opened.profile : emptyProfile(Date.now()));
    });
    return () => { alive = false; };
  }, [identity, port]);

  const commit = useCallback((next: Profile) => {
    setProfile(next);
    void save(port, identity, next).catch((e: unknown) => {
      setProblem(e instanceof Error ? e.message : 'Nothing could be saved.');
    });
  }, [identity, port]);

  const guarded = useCallback((run: () => Profile): string | null => {
    try {
      commit(run());
      return null;
    } catch (e) {
      return e instanceof ProfileError ? e.message : 'That could not be done.';
    }
  }, [commit]);

  const stale = useMemo(() => (profile === null ? [] : changed(profile)), [profile]);

  if (profile === null || state === null) {
    return <><h1>My profile</h1><p className="muted">Opening…</p></>;
  }

  /*
   * A READ THAT COULD NOT OPEN MUST NOT LET THE NEXT WRITE DESTROY.
   * The store refuses to save over this state; the screen shows it rather than
   * quietly starting a fresh, empty profile over the top of somebody's facts.
   */
  if (state.of === 'unopenable') {
    const saying = sayingForUnopenable(state, heldWallets().length);
    return (
      <>
        <BackToWallet />
        <h1>My profile</h1>
        <Alert tone={saying.tone} title={saying.title}>
          <p className="m-0" data-unopenable-why>{saying.sentence}</p>
          <p className="m-0">
            Nothing has been changed or deleted.{!saying.anotherWalletHere && (
              <> If you have opened a different wallet in this browser, the details belong to
              the other one and will open when it does.</>
            )}
          </p>
        </Alert>
        <p style={{ marginTop: '1.5rem' }}>
          <a href={hrefOf('home')}>← Back to your wallet</a>
        </p>
      </>
    );
  }

  return (
    <>
      <BackToWallet />
      <h1>My profile</h1>
      <p className="lede">
        Facts about you, kept in this browser and nowhere else. They are encrypted here,
        no server of ours ever sees them, and nothing leaves this wallet unless you
        approve it, one detail at a time.
      </p>

      {problem !== null && <Alert tone="danger" title="Not saved">{problem}</Alert>}
      <StaleList stale={stale} />

      {registry.all.map((definition) => {
        const rows = heldAbout(profile, definition.name);
        return (
          <Section
            key={definition.name}
            title={definition.render.label}
            description={definition.render.hint === '' ? undefined : definition.render.hint}
          >
            <Card>
              {/* `pt-5` IS THE KIT'S TOP PADDING FOR A CARD WITH NO HEADER, and
                * it is what `screens/settings.tsx` writes on every one of its
                * eleven cards. `CardContent` alone is `px-5 pb-5` — designed to
                * sit under a `CardHeader` that already paid for the top — so
                * without it the first line of text is flush against the card's
                * border and the border runs into the words. */}
              <CardContent className="pt-5">
                {rows.length === 0 ? (
                  /*
                   * ONE QUIET LINE, NOT A ROOM. `EmptyState` draws a dashed
                   * box six lines tall; three of them stacked made a wallet
                   * with nothing typed in it yet read as unfinished rather
                   * than as new. **What was actually broken here was the
                   * SEPARATION from the add-row**, and the rule below fixes
                   * that on its own — the box was never the part that worked.
                   * `EmptyState` is still the right shape for a room a person
                   * expected to find something in; a field they have not
                   * filled in yet is not that.
                   */
                  <p className="m-0 text-sm text-muted" data-empty={definition.name}>
                    {`No ${definition.render.label.toLowerCase()} yet.`}
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {rows.map((held) => (
                      <HeldRow
                        key={held.id}
                        definition={definition}
                        held={held}
                        onEdit={(id, text) => {
                          setProblem(guarded(() => editValue(profile, registry, id, text, Date.now())));
                        }}
                        onLabel={(id, text) => {
                          setProblem(guarded(() => relabel(profile, id, text, Date.now())));
                        }}
                        onForget={(id) => {
                          setProblem(guarded(() => forgetValue(profile, id, Date.now())));
                        }}
                      />
                    ))}
                  </ul>
                )}
                {/*
                  * `selfAssertable: false` MEANS NO FIELD AT ALL, and the form
                  * has no idea why — it reads the flag. That is §3.4 working:
                  * a rule that lives in the definition rather than in a branch
                  * here.
                  */}
                {definition.selfAssertable && (rows.length === 0 || definition.multiple) ? (
                  <>
                    {/* THE ADD-ROW STARTS SOMEWHERE. Without a rule and a gap
                      * above it, *No first name yet.* and *New first name* are
                      * two stacked lines that read as one broken sentence. */}
                    <Separator decorative className="my-4" />
                    <AddOne
                      definition={definition}
                      onAdd={(text, label) => guarded(
                        () => selfAssert(
                          profile, registry, definition.name, text, label, Date.now()))}
                    />
                  </>
                ) : !definition.selfAssertable && (
                  <p className="m-0 mt-4 text-sm text-muted" data-issued-only={definition.name}>
                    This is not something you can state about yourself. It has to come from
                    whoever is in a position to check it.
                  </p>
                )}
              </CardContent>
            </Card>
          </Section>
        );
      })}

      <Section
        title="What you have sent, and to whom"
        description="What is sent, is sent. This is a record of what left this wallet — not a list of what anyone still holds, and not something this wallet can take back."
      >
        {profile.grants.length === 0 ? (
          <p className="m-0 text-sm text-muted" data-empty="grants">
            Nothing has been sent to anybody yet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {profile.grants.map((grant) => (
              <li
                key={`${grant.recipient.origin}-${grant.subwallet}`}
                data-grant={grant.recipient.origin}
                className="rounded-tight border border-line p-3"
              >
                {/* A COMPANY'S NAME WRAPS ON ITS SPACES; ITS ORIGIN HAS NONE
                  * AND BREAKS ANYWHERE. Both were leaving the card. */}
                <p className="m-0 text-base break-words text-ink">{grant.recipient.name}</p>
                <p className="m-0 font-mono text-sm break-all text-muted">
                  {`${grant.recipient.origin} · wallet ${grant.subwallet}`}
                </p>
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0" data-disclosures>
                  {grant.disclosures.length === 0 && (
                    <li className="text-sm text-muted">
                      Agreed, but nothing has been sent yet.
                    </li>
                  )}
                  {runsOf(grant.disclosures).map((run) => (
                    <RunEntry key={run.key} run={run} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <Card>
          <CardHeader><CardTitle>What this wallet cannot do</CardTitle></CardHeader>
          <CardContent>
            <p className="m-0 text-sm text-muted">
              You cannot un-tell a company something. Anything above has already been given
              to them and they keep their own copy — which is normally what you want, because
              it is how they pay you. This wallet can stop sending them anything new; it
              cannot reach into their records.
            </p>
          </CardContent>
        </Card>
      </Section>

      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('home')}>← Back to your wallet</a>
      </p>
    </>
  );
}

/* The check is re-exported for the approval screen, which fills in a missing
 * value with exactly the same rule rather than a second copy of it. */
export { check };
