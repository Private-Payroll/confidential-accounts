import { useEffect, useId, useState } from 'react';
import { UserGroupIcon } from '@hugeicons/core-free-icons';
import {
  AlertDescription, Button, EmptyState, Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, Input, RadioGroup, RadioGroupItem, Section, SectionRow, useText,
} from 'vaults-ui';
import { GRANTS_READ, readGrants, type ReaderHeld } from '../adapters/grants-here.js';
import {
  changeRole, CHANGE_ACTED, continueRoleChange, dropRoleChange, readRoles, roleChangeCosts, ROLE_PROBLEM, ROLE_TABLE, ROLE_WHY, ROLES_READ, SIGNER_ROLES, startedRoleChanges,
  type ChangeActed, type ChangeHolders, type RolesRead, type RoleRow, type RoleWhy, type SeatHeld,
} from '../adapters/roles-here.js';
import { watchPrivateMoneyReadable } from '../adapters/vault-private-money.js';
import { useSession } from '../session.js';
import { ActOutcome, ActDone, ActStopped, type ActPhase } from './proposal-act.js';

type Words = ReturnType<typeof useText>;
/** What a change ended as, with the person and role it was for, so what it says can name them. */
type Shown = { readonly acted: ChangeActed; readonly name: string; readonly role: string };

/** A role by its name on the page; a seat with none is the founding seat, which holds every right as an admin does. */
const roleName = (t: Words, role: string | null): string => (role === null || role === 'admin' ? t('invite.role.admin') : role === 'approver' ? t('invite.role.approver') : role === 'initiator' ? t('invite.role.initiator')
  : role === 'accountant' ? t('invite.role.accountant') : t('invite.role.limited'));

const purposeSays = (t: Words, purpose: string): string | null => {
  switch (purpose) {
    case 'people': return t('roles.reads.purpose.people');
    case 'payroll': return t('roles.reads.purpose.payroll');
    case 'roster': return t('roles.reads.purpose.roster');
    case 'policy': return t('roles.reads.purpose.policy');
    case 'proposals': return t('roles.reads.purpose.proposals');
    default: return null;
  }
};

const WHY_SAYS = (t: Words): Record<RoleWhy, string> => ({
  [ROLE_WHY.seat]: t('roles.change.why.seat'), [ROLE_WHY.removalUnderWay]: t('roles.change.why.removal-under-way'),
  [ROLE_WHY.fewerApprovalsFirst]: t('roles.change.why.fewer-approvals-first'), [ROLE_WHY.notAsStarted]: t('roles.change.why.not-as-started'),
  [ROLE_WHY.notStartedHere]: t('roles.change.why.not-started-here'), [ROLE_WHY.notAnAddress]: t('roles.change.why.not-an-address'),
  [ROLE_WHY.notAsAsked]: t('roles.change.why.not-as-asked'), [ROLE_WHY.stopped]: t('roles.change.why.stopped'), [ROLE_WHY.other]: t('roles.change.why.other'),
});

const problemSays = (t: Words, problem: string): string => {
  switch (problem) {
    case ROLE_PROBLEM.noName: return t('roles.change.problem.no-name');
    case ROLE_PROBLEM.badAddress: return t('roles.change.problem.bad-address');
    case ROLE_PROBLEM.sameRole: return t('roles.change.problem.same-role');
    case ROLE_PROBLEM.noSeat: return t('roles.change.problem.no-seat');
    default: return t('roles.change.problem.no-role');
  }
};

/** One change at a time: the steps it has reached, and how it ended; the seats are read again once it changed or may have changed them. */
function useRoleAct(onChanged: () => void): { readonly phase: ActPhase; readonly shown: Shown | null; readonly start: (named: { name: string; role: string }, run: (p: string, c: string, onStep: (step: number, steps: number) => void) => Promise<ChangeActed>) => void } {
  const { person, company } = useSession();
  const [phase, setPhase] = useState<ActPhase>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const start = (named: { name: string; role: string }, run: (p: string, c: string, onStep: (step: number, steps: number) => void) => Promise<ChangeActed>): void => {
    if (company === null || phase !== null) return;
    setShown(null);
    setPhase({ step: 0, steps: 0 });
    void run(person.id, company, (step, steps) => setPhase({ step, steps })).then((acted) => {
      setPhase(null);
      setShown({ acted, ...named });
      if (acted.of === CHANGE_ACTED.done || acted.of === CHANGE_ACTED.dropped || (acted.of === CHANGE_ACTED.stopped && (acted.partial || acted.handedOver))) onChanged();
    });
  };
  return { phase, shown, start };
}

const dropSays = (t: Words, state: string | null, name: string): string =>
  (state === 'dropped' ? t('roles.drop.done.dropped', { name }) : state === 'not-kept' ? t('roles.drop.done.not-kept', { name }) : t('roles.drop.done.unknown'));

function ChangeOutcome({ phase, shown }: { phase: ActPhase; shown: Shown | null }) {
  const t = useText();
  const acted = shown?.acted ?? null;
  const done = acted?.of === CHANGE_ACTED.done ? acted : null;
  const stopped = acted?.of === CHANGE_ACTED.stopped ? acted : null;
  const role = shown === null ? '' : roleName(t, shown.role);
  const name = shown?.name ?? '';
  return (
    <ActOutcome phase={phase} refused={acted?.of === CHANGE_ACTED.refused ? acted.why : null}>
      {acted?.of === CHANGE_ACTED.problem ? <p className="text-sm" role="alert" data-change-problem={acted.problem}>{problemSays(t, acted.problem)}</p> : null}
      {acted?.of !== CHANGE_ACTED.dropped ? null : <ActDone data-change-dropped={acted.state ?? 'unknown'}>{dropSays(t, acted.state, name)}</ActDone>}
      {done === null ? null : (
        <ActDone data-change-done={done.stage ?? 'unknown'}>
          {done.stage === 'remove' ? (done.approvals !== null && done.needed !== null ? t('roles.change.done.remove', { name, role, approvals: done.approvals, needed: done.needed }) : t('roles.change.done.remove.unknown', { name, role }))
            : done.stage === 'invite' ? t('roles.change.done.invite', { name, role }) : t('roles.change.done.unknown')}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-change-stopped={stopped.why}>
          <AlertDescription>{stopped.handedOver && !stopped.partial ? t('roles.change.sent') : WHY_SAYS(t)[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('roles.change.partial')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}

/** What a role may do, one line for each thing the one list of roles says it may. */
function MayDo({ row }: { row: RoleRow }) {
  const t = useText();
  /* A reader's lines are each a purpose its grant names, marked with that purpose; a signer's carry no mark. */
  const lines: readonly { readonly says: string | null; readonly read?: string }[] = row.seat
    ? [row.mayRaise ? t('roles.may.raise') : null, row.mayApprove ? t('roles.may.approve') : null, row.mayHold ? t('roles.may.hold') : null,
      row.mayInvite ? t('roles.may.invite') : null, row.filesEvery ? t('roles.may.files') : null].map((says) => ({ says }))
    : row.reads.map((p) => ({ says: purposeSays(t, p), read: p }));
  return (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground" data-may-do>
      {lines.map((l) => (l.says === null ? null : <span key={l.says} data-read={l.read}>{l.says}</span>))}
    </div>
  );
}

function Holders({ seats, readers, row }: { seats: readonly SeatHeld[] | null; readers: readonly ReaderHeld[] | null; row: RoleRow }) {
  const t = useText();
  const known = row.seat ? seats : readers;
  if (known === null) return null;
  const names = row.seat
    ? (seats ?? []).filter((s) => (s.role ?? 'admin') === row.role).map((s) => ({
      key: s.leaf, name: s.name, marks: [s.you ? t('roles.list.you') : null, s.role === null ? t('roles.list.founding') : null, s.leaving ? t('roles.list.leaving') : null],
    }))
    : (readers ?? []).filter((r) => r.role === row.role).map((r) => ({ key: r.recipient, name: r.person, marks: [] as (string | null)[] }));
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-holders={row.role}>
      <span className="text-muted-foreground">{t('roles.list.held')}</span>
      {names.length === 0 ? <span>{t('roles.list.nobody')}</span> : names.map((n) => (
        <span key={n.key} data-holder={n.key}>{n.name}{n.marks.map((m) => (m === null ? null : <span key={m}> ({m})</span>))}</span>
      ))}
    </div>
  );
}

function RoleRows({ seats, readers }: { seats: readonly SeatHeld[] | null; readers: readonly ReaderHeld[] | null }) {
  const t = useText();
  return (
    <Section title={t('roles.list.title')} description={t('roles.list.description')} empty={null} data-role-list>
      {ROLE_TABLE.map((row) => (
        <SectionRow
          key={row.role} data-role-row={row.role} data-seat={row.seat} data-may-raise={row.mayRaise} data-may-approve={row.mayApprove} data-may-hold={row.mayHold}
          data-may-invite={row.mayInvite} data-files-every={row.filesEvery}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <span className="font-medium">{roleName(t, row.role)} <span className="font-normal text-muted-foreground">{row.seat ? t('roles.list.seat') : t('roles.list.noSeat')}</span></span>
            <MayDo row={row} />
            <Holders seats={seats} readers={readers} row={row} />
          </div>
        </SectionRow>
      ))}
      {seats?.some((s) => s.role === null) ? <SectionRow data-founding-says>{t('roles.list.foundingSays')}</SectionRow> : null}
      {seats === null ? <SectionRow data-roles-unread>{t('roles.list.unread')}</SectionRow> : null}
    </Section>
  );
}

function ChangeForm({ seats, holders, busy, onChange }: { seats: readonly SeatHeld[]; holders: ChangeHolders; busy: boolean; onChange: (seat: SeatHeld | null, role: string, address: string) => void }) {
  const t = useText();
  const [leaf, setLeaf] = useState('');
  const [role, setRole] = useState('');
  const [address, setAddress] = useState('');
  const ids = useId();
  const costs = roleChangeCosts(holders);
  const mine = seats.filter((s) => !s.leaving);
  return (
    <Section title={t('roles.change.title')} description={t('roles.change.description')} list={false} data-change-role>
      {mine.length === 0 ? <EmptyState icon={UserGroupIcon}>{t('roles.change.none')}</EmptyState> : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onChange(mine.find((s) => s.leaf === leaf) ?? null, role, address); }}>
          <FieldSet disabled={busy}>
            <FieldLegend variant="label">{t('roles.change.seat.label')}</FieldLegend>
            <RadioGroup value={leaf} onValueChange={setLeaf} data-field="seat">
              {mine.map((s) => (
                <Field key={s.leaf} orientation="horizontal">
                  <RadioGroupItem value={s.leaf} id={ids + s.leaf} disabled={busy} data-seat={s.leaf} />
                  <FieldLabel htmlFor={ids + s.leaf}>{s.name} ({roleName(t, s.role)})</FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <FieldSet disabled={busy}>
            <FieldLegend variant="label">{t('roles.change.role.label')}</FieldLegend>
            <RadioGroup value={role} onValueChange={setRole} data-field="role">
              {SIGNER_ROLES.map((r) => (
                <Field key={r} orientation="horizontal">
                  <RadioGroupItem value={r} id={ids + r} disabled={busy} data-role={r} />
                  <FieldContent><FieldLabel htmlFor={ids + r}>{roleName(t, r)}</FieldLabel></FieldContent>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor={ids}>{t('roles.change.address.label')}</FieldLabel>
            <Input id={ids} dir="ltr" value={address} disabled={busy} data-field="address" onChange={(e) => setAddress(e.target.value)} />
            <FieldDescription>{t('roles.change.address.hint')}</FieldDescription>
          </Field>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground" data-change-says>
            <p>{t('roles.change.needs', { needed: costs.needed })}</p>
            {costs.leaves && costs.joins ? <p data-change-public>{t('roles.change.public')}</p> : null}
            <p data-change-forgets>{t('roles.change.forgets')}</p>
          </div>
          <div><Button type="submit" disabled={busy} data-action="change-role">{t('roles.change.press')}</Button></div>
        </form>
      )}
    </Section>
  );
}

/** The five roles with what each may do and who holds each, and the change of a signer's role in its two steps. */
export function RolesList() {
  const t = useText();
  const { person, company } = useSession();
  const [roles, setRoles] = useState<RolesRead | null>(null);
  const [readers, setReaders] = useState<readonly ReaderHeld[] | null>(null);
  const [reads, setReads] = useState(0);
  const again = (): void => setReads((n) => n + 1);
  const act = useRoleAct(again);
  const busy = act.phase !== null;

  useEffect(() => (company === null ? undefined : watchPrivateMoneyReadable(company, again)), [company]);
  useEffect(() => {
    if (company === null) return undefined;
    let alive = true;
    void readRoles(person.id, company).then((r) => { if (alive) setRoles(r); });
    void readGrants(person.id, company).then((g) => { if (alive) setReaders(g.of === GRANTS_READ.read ? g.readers : null); });
    return () => { alive = false; };
  }, [person.id, company, reads]);

  const held = roles?.of === ROLES_READ.read ? roles : null;
  const begun = company === null ? [] : startedRoleChanges(company);
  const unattended = held?.seats.some((s) => s.leaving && !begun.some((b) => b.leaf === s.leaf)) ?? false;
  return (
    <>
      <RoleRows seats={held?.seats ?? null} readers={readers} />
      {held === null ? null : (
        <ChangeForm
          seats={held.seats} holders={held.holders} busy={busy}
          onChange={(seat, role, address) => act.start({ name: seat?.name ?? '', role }, (p, c, onStep) => changeRole(p, c, { leaf: seat?.leaf ?? '', current: seat?.role ?? null, role, address, name: seat?.name ?? '' }, onStep))}
        />
      )}
      {begun.length === 0 ? null : (
        <Section title={t('roles.continue.title')} description={t('roles.continue.description')} count={begun.length} empty={null} data-begun-changes>
          {begun.map((b) => (
            <SectionRow
              key={b.leaf} data-begun={b.leaf}
              actions={(
                <>
                  <Button size="sm" disabled={busy} data-action="continue-role" onClick={() => act.start({ name: b.name, role: b.role }, (p, c, onStep) => continueRoleChange(p, c, b.leaf, onStep))}>{t('roles.continue.press')}</Button>
                  <Button size="sm" variant="outline" disabled={busy} data-action="drop-role-change" onClick={() => act.start({ name: b.name, role: b.role }, (p, c, onStep) => dropRoleChange(p, c, b.leaf, onStep))}>{t('roles.drop.press')}</Button>
                </>
              )}
            >
              {t('roles.continue.says', { name: b.name, role: roleName(t, b.role) })}
              <span className="block text-sm text-muted-foreground" data-drop-says>{t('roles.drop.says')}</span>
            </SectionRow>
          ))}
        </Section>
      )}
      {unattended ? <p className="text-sm text-muted-foreground" data-leaving-note>{t('roles.leaving.note')}</p> : null}
      <ChangeOutcome phase={act.phase} shown={act.shown} />
    </>
  );
}
