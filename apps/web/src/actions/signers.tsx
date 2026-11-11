import { useState } from 'react';
import { AlertDescription, Badge, Button, Field, FieldDescription, FieldLabel, Section, SectionRow, useText } from 'vaults-ui';
import { APPROVALS, approvalsSentence, INVITE_KIND, ROLE } from '../adapters/invite.js';
import { READ } from '../adapters/reads.js';
import {
  REMOVAL_STATE, ROTATION, SIGNER_ACT, SIGNER_ACTED, VAULT_SECRETS_NOT_STARTED, WHY, admitSigner, approveSigner, changeVaultSecrets, giveYourKeys, removeSigner,
  type SignerAct, type SignerActed, type SignerWhy,
} from '../adapters/signer-acts.js';
import { rightsAreOverEveryVault, thresholdChangesWaiting, type SignerInvited } from '../adapters/signers.js';
import { useCompanyRecords } from '../records/company-records.js';
import { WithRecords } from '../records/parts.js';
import { ActDone, ActOutcome, ActStopped, type ActStep } from '../records/proposal-act.js';
import { useSession } from '../session.js';
import type { StepProps } from '../setup/step-ids.js';
import { ChangeThreshold } from './change-threshold.js';
import { CommitteeChange } from './committee-change.js';
import { InvitePeople } from './invite.js';

const STANDING = { seated: 'seated', finish: 'finish', accepted: 'accepted', notSeated: 'not-seated', waiting: 'waiting' } as const;
type Standing = (typeof STANDING)[keyof typeof STANDING];
const OPEN = 'open';
/** The id the vault secrets' press is marked with: it is for the company's vaults, not for a signer. */
const VAULTS = 'vaults';
/** What the wallet tells when some vault still owes its change after a press. */
const ROTATED_PARTLY = 'partial';
/** The marks the lines of how many vaults ended in each state are found by. */
const COUNT = { rotated: 'rotated', awaiting: 'awaiting', owed: 'owed', waiting: 'waiting', notChanged: 'notChanged' } as const;

function useWhySays(): Record<SignerWhy, string> {
  const t = useText();
  return {
    [WHY.notACompany]: t('signers.why.not-a-company'), [WHY.noSavedKeys]: t('signers.why.no-saved-keys'), [WHY.noSeat]: t('signers.why.no-seat'),
    [WHY.seatNotHeld]: t('signers.why.seat-not-held'), [WHY.notOnChain]: t('signers.why.not-on-chain'), [WHY.rosterNotOpened]: t('signers.why.roster-not-opened'),
    [WHY.notAProposal]: t('signers.why.not-a-proposal'), [WHY.notApproved]: t('signers.why.not-approved'), [WHY.withdrawn]: t('signers.why.withdrawn'),
    [WHY.mayBeSent]: t('signers.why.may-be-sent'), [WHY.notASigner]: t('signers.why.not-a-signer'), [WHY.notTheInvited]: t('signers.why.not-the-invited'),
    [WHY.alreadyCounted]: t('signers.why.already-counted'), [WHY.carriedOut]: t('signers.why.carried-out'),
    [WHY.notAdmitted]: t('signers.why.not-admitted'), [WHY.filedNotEntered]: t('signers.why.filed-not-entered'), [WHY.stopped]: t('signers.why.stopped'),
    [WHY.idTaken]: t('signers.why.id-taken'), [WHY.chainUnread]: t('signers.why.chain-unread'),
    [WHY.recordsKeyRefused]: t('signers.why.records-key-refused'), [WHY.entryNotFiled]: t('signers.why.entry-not-filed'), [WHY.other]: t('signers.why.other'),
    [WHY.notARemoval]: t('signers.why.not-a-removal'), [WHY.removalRefused]: t('signers.why.refused'), [WHY.notRaised]: t('signers.why.not-raised'),
    [WHY.notCarried]: t('signers.why.not-carried'), [WHY.notAsShown]: t('signers.why.not-as-shown'), [WHY.notRead]: t('signers.why.not-read'),
    [WHY.notReadToRaise]: t('signers.why.not-read'), [WHY.noSuchSeat]: t('signers.why.no-such-seat'), [WHY.noSuchSeatToRaise]: t('signers.why.no-such-seat'),
    [WHY.unreadSeatFirst]: t('signers.why.unread-seat-first'), [WHY.outrun]: t('signers.why.outrun'), [WHY.noPerson]: t('signers.why.no-person'),
    [WHY.notAVault]: t('signers.why.not-a-vault'),
  };
}

/** The reasons whose words differ for a removal, which an invitation's words would misname. */
function useRemovalWhySays(): Partial<Record<SignerWhy, string>> {
  const t = useText();
  return {
    [WHY.withdrawn]: t('signers.why.removal.withdrawn'), [WHY.carriedOut]: t('signers.why.removal.carried-out'),
    [WHY.alreadyCounted]: t('signers.why.removal.already-counted'), [WHY.mayBeSent]: t('signers.why.removal.may-be-sent'),
  };
}

function useRotationSays(): (code: (typeof ROTATION)[number]) => string {
  const t = useText();
  return (code) => {
    switch (code) {
      case 'rotated': return t('signers.rotation.rotated');
      case 'filed-not-anchored': return t('signers.rotation.filed-not-anchored');
      case 'rotated-elsewhere': return t('signers.rotation.rotated-elsewhere');
      case 'not-needed': return t('signers.rotation.not-needed');
      case 'waits': return t('signers.rotation.waits');
      case 'not-this-seat': return t('signers.rotation.not-this-seat');
      case 'not-rotated': return t('signers.rotation.not-rotated');
      case 'not-tried': return t('signers.rotation.not-tried');
    }
  };
}

function useRoleSays(): Record<string, string> {
  const t = useText();
  return {
    [ROLE.admin]: t('invite.role.admin'), [ROLE.approver]: t('invite.role.approver'), [ROLE.initiator]: t('invite.role.initiator'),
  };
}

function useStandingSays(): Record<Standing, string> {
  const t = useText();
  return {
    [STANDING.seated]: t('signers.standing.seated'), [STANDING.finish]: t('signers.standing.finish'),
    [STANDING.accepted]: t('signers.standing.accepted'), [STANDING.notSeated]: t('signers.standing.notSeated'),
    [STANDING.waiting]: t('signers.standing.waiting'),
  };
}

const barOf = (records: { readonly approvalsForSigners?: Parameters<typeof approvalsSentence>[0] }): number | null => approvalsSentence(records.approvalsForSigners)?.values.count ?? null;

const standingOf = (s: { accepted: boolean; seatOnChain: boolean; waiting?: true }): Standing =>
  s.waiting === true ? STANDING.waiting
    : s.accepted ? (s.seatOnChain ? STANDING.finish : STANDING.accepted) : s.seatOnChain ? STANDING.seated : STANDING.notSeated;

/** What is being asked of the wallet: which act, for which invitation (its record id) or signer (their id). */
interface Pressed { readonly act: SignerAct; readonly id: string }
/** The act the wallet is working on and how far it has got; null when nothing is being asked of it. */
type Phase = (ActStep & { readonly on: Pressed }) | null;
type Result = { readonly on: Pressed; readonly act: SignerActed; readonly name: string };
const same = (a: Pressed, b: Pressed): boolean => a.act === b.act && a.id === b.id;

/**
 * The signers of a company: where each stands, with you marked by the seat this device holds.
 * The invitations waiting for approvals have Approve on each this person may still approve, and what comes next on the others
 * (`nextOf`). A signer whose seat the network holds has Finish adding. A seat the network holds that nobody's request has
 * reached this page for is listed as "Someone the company invited", with the reload words and neither Finish adding nor Remove.
 * Every other seated signer, whose leaf the roster names, has Remove with the approvals the company should ask for afterwards
 * (optional): the wallet raises the removal, carries it out once the network counts its approvals and says where it got to,
 * with the company key's change and how many vaults ended in each state. Below the signers, Vault secrets has the one press
 * (Change vault secrets) a signer who stays makes when a vault's change is owed after a removal.
 * Give your keys is on your own seat while the company's directory holds no entry for it. Below them are the approvals the
 * company asks for, with the control that changes them (`ChangeThreshold`), Add a signer, and who holds the company, with the
 * change of the super admins a vault may be owed (the committee change).
 * The settings page shows it, and the setup wizard's signers step shows this same component (it is given the step's props
 * there, and then draws the invitation form itself); neither draws a copy.
 */
export function Signers({ leadTo, onChanged }: Partial<StepProps>) {
  const t = useText();
  const { person, company } = useSession();
  const { reload } = useCompanyRecords();
  const [phase, setPhase] = useState<Phase>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [approvedHere, setApprovedHere] = useState<ReadonlySet<string>>(new Set());
  const busy = phase !== null;
  /* One act asks for one read of the company's records: a step that called this component re-reads them itself when told, and on the page the component does. */
  const changed = (): void => { if (onChanged === undefined) reload(); else onChanged(); };

  const run = async (on: Pressed, name: string, act: (onStep: (step: number, steps: number) => void) => Promise<SignerActed>): Promise<void> => {
    if (company === null || busy) return;
    setResult(null);
    setPhase({ on, step: 0, steps: 0 });
    const ended = await act((step, steps) => setPhase({ on, step, steps }));
    setPhase(null);
    setResult({ on, act: ended, name });
    if (on.act === SIGNER_ACT.approve && ended.of === SIGNER_ACTED.done) setApprovedHere((was) => new Set(was).add(on.id));
    if (ended.of === SIGNER_ACTED.done || (ended.of === SIGNER_ACTED.stopped && (ended.partial || ended.handedOver || ended.why === WHY.withdrawn))) changed();
  };

  return (
    <div className="flex max-w-xl flex-col gap-6" data-action="signers">
      <WithRecords>
        {(records) => (
          <>
            <StandingList records={records} busy={busy} result={result} phase={phase}
              onFinish={(s) => { void run({ act: SIGNER_ACT.admit, id: s.id }, s.name, (onStep) => admitSigner(person.id, company ?? '', { id: s.id, name: s.name }, onStep)); }}
              onGiveKeys={(s) => { void run({ act: SIGNER_ACT.giveKeys, id: s.id }, s.name, (onStep) => giveYourKeys(person.id, company ?? '', onStep)); }}
              onRemove={(s, leaf, threshold) => {
                void run({ act: SIGNER_ACT.remove, id: s.id }, s.name, (onStep) => removeSigner(person.id, company ?? '', { leaf, ...(threshold === undefined ? {} : { threshold }) }, onStep));
              }} />
            <VaultSecrets busy={busy} result={result} phase={phase}
              onChange={() => { void run({ act: SIGNER_ACT.rotate, id: VAULTS }, '', (onStep) => changeVaultSecrets(person.id, company ?? '', onStep)); }} />
            <ThresholdNow records={records} />
            <Section title={t('changeThreshold.title')} description={t('changeThreshold.description')} list={false} box={false} data-signers-change-threshold>
              <ChangeThreshold {...(onChanged === undefined ? {} : { onChanged })} />
            </Section>
            <WaitingList records={records} busy={busy} result={result} phase={phase} approvedHere={approvedHere}
              onApprove={(i) => { void run({ act: SIGNER_ACT.approve, id: i.proposal }, i.name, (onStep) => approveSigner(person.id, company ?? '', i, onStep)); }} />
          </>
        )}
      </WithRecords>
      <Section
        title={t('signers.add.title')} description={t('signers.add.description')} list={false} box={false}
        data-signers-add
      >
        <div><InvitePeople kind={INVITE_KIND.signer} {...(leadTo === undefined ? {} : { leadTo })} onInvited={leadTo === undefined ? () => { onChanged?.(); } : changed} /></div>
      </Section>
      <CommitteeChange {...(onChanged === undefined ? {} : { onChanged })} />
    </div>
  );
}

type Records = Parameters<Parameters<typeof WithRecords>[0]['children']>[0];

function Outcome({ phase, result, of, bar }: { phase: Phase; result: Result | null; of: Pressed; bar: number | null }) {
  const t = useText();
  const whySays = useWhySays();
  const removalWhySays = useRemovalWhySays();
  const mine = result !== null && same(result.on, of) ? result : null;
  const working = phase !== null && same(phase.on, of) ? phase : null;
  const act = mine?.act;
  const kind = mine?.on.act;
  const name = mine?.name ?? '';
  const ended = act?.of === SIGNER_ACTED.done ? act : null;
  const stopped = act?.of === SIGNER_ACTED.stopped ? act : null;
  const words = kind === SIGNER_ACT.remove ? removalSentence(t, ended?.state ?? null, name)
    : kind === SIGNER_ACT.giveKeys ? t('signers.done.keysGiven')
    : kind === SIGNER_ACT.admit ? (ended?.state === 'already-admitted' ? t('signers.done.alreadyAdmitted', { name }) : t('signers.done.admitted', { name }))
      : t('signers.done.approved', { name });
  const next = kind === SIGNER_ACT.remove ? null : kind === SIGNER_ACT.giveKeys ? t('signers.done.keysGivenNext')
    : kind === SIGNER_ACT.admit ? null
      : ended?.state === 'outrun' ? t('signers.done.outrun')
        : ended?.state === 'waiting-for-the-invitee' ? t('signers.done.complete', { name }) : bar === null ? t('signers.done.nextUnknown', { name }) : t('signers.done.next', { name, count: bar });
  return (
    <ActOutcome phase={working} refused={act?.of === SIGNER_ACTED.refused ? act.why : null}>
      {ended === null || kind === undefined || kind === SIGNER_ACT.rotate ? null : <ActDone data-acted={kind} next={next}>{words}</ActDone>}
      {ended === null || kind !== SIGNER_ACT.remove || ended.removal === undefined ? null : <RemovalTold removal={ended.removal} state={ended.state} />}
      {ended === null || kind !== SIGNER_ACT.rotate ? null : <VaultCounts vaults={ended.vaults?.vaults ?? null} partial={ended.state === ROTATED_PARTLY} unread />}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-signer-stopped={stopped.why}>
          <AlertDescription>{stopped.handedOver && !stopped.partial ? t('signers.sent') : (stopped.act === SIGNER_ACT.remove ? removalWhySays[stopped.why] : undefined) ?? whySays[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('signers.partial')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}

function StandingList({ records, busy, result, phase, onFinish, onGiveKeys, onRemove }: {
  records: Records; busy: boolean; result: Result | null; phase: Phase; onFinish: (s: { id: string; name: string }) => void;
  onGiveKeys: (s: { id: string; name: string }) => void; onRemove: (s: { id: string; name: string }, leaf: string, threshold: number | undefined) => void;
}) {
  const t = useText();
  /* The name the create step saves a founding seat under when its person gave none: shown beside the name, so it is never read as you. */
  const savedAsYou = t('setup.createCompany.you');
  const says = useStandingSays();
  const bar = barOf(records);
  const needed = records.approvalsNeeded.of === READ.read ? records.approvalsNeeded.value : null;
  const seatedRead = records.approvalsForSigners?.of === READ.read ? records.approvalsForSigners.value.seated : null;
  const seated = typeof seatedRead === 'number' ? seatedRead : null;
  const standings = records.signerStandings;
  if (standings === undefined || standings.of !== READ.read) {
    return (
      <Section title={t('signers.signers.title')} list={false}>
        <p className="text-sm text-muted-foreground" data-standings-unread>{t('signers.standing.unread')}</p>
      </Section>
    );
  }
  return (
    <Section title={t('signers.signers.title')} count={standings.value.length} empty={null} data-signers>
      {standings.value.map((s) => {
        const stands = standingOf(s);
        /* Only your own seat, seated, whose entry the directory read did not hold; an unread directory offers nothing. */
        const giveKeys = s.you === true && stands === STANDING.seated && s.entryFiled === false;
        const on: Pressed = giveKeys ? { act: SIGNER_ACT.giveKeys, id: s.id } : { act: SIGNER_ACT.admit, id: s.id };
        return (
          <SectionRow
            key={s.id} data-signer={s.id} data-standing={stands}
            actions={stands === STANDING.finish ? (
              <Button size="sm" disabled={busy} onClick={() => onFinish(s)} data-action="finish-adding">{t('signers.finish')}</Button>
            ) : giveKeys ? (
              <Button size="sm" disabled={busy} onClick={() => onGiveKeys(s)} data-action="give-vault-keys">{t('signers.giveKeys')}</Button>
            ) : undefined}
          >
            <span className="font-medium">{stands === STANDING.waiting ? t('signers.standing.waitingWho') : s.name}</span>
            {s.you === true ? <Badge data-you>{t('signers.you')}</Badge> : null}
            <Badge variant="outline">{says[stands]}</Badge>
            {s.you !== true && s.name === savedAsYou ? <p className="w-full text-sm text-muted-foreground" data-named-you>{t('signers.namedYou')}</p> : null}
            {s.seatOnChain && stands !== STANDING.waiting && typeof s.leaf === 'string'
              ? <RemoveControl signer={s} now={needed} seated={seated} busy={busy} onRemove={(threshold) => onRemove(s, s.leaf!, threshold)} /> : null}
            {giveKeys ? <p className="w-full text-sm text-muted-foreground" data-give-keys-why>{t('signers.giveKeys.why')}</p> : null}
            {stands === STANDING.accepted ? <p className="w-full text-sm text-muted-foreground" data-next-for-them>{t('signers.standing.acceptedNext')}</p> : null}
            {stands === STANDING.notSeated ? <p className="w-full text-sm text-muted-foreground" data-next-for-them>{t('signers.standing.notSeatedNext')}</p> : null}
            {stands === STANDING.waiting ? <p className="w-full text-sm text-muted-foreground" data-next-for-them>{t('signers.standing.waitingNext')}</p> : null}
            <div className="flex w-full flex-col gap-2">
              <Outcome phase={phase} result={result} of={on} bar={bar} />
              <Outcome phase={phase} result={result} of={{ act: SIGNER_ACT.remove, id: s.id }} bar={bar} />
            </div>
          </SectionRow>
        );
      })}
    </Section>
  );
}

/**
 * The approvals the company asks for now, and beside it each change of that number that waits: an open proposal to set it, with the
 * number it holds, and an open invitation that sets it once its seat is taken. A change shows only while the chain holds it open.
 */
function ThresholdNow({ records }: { records: Records }) {
  const t = useText();
  const now = records.approvalsNeeded;
  const changes = thresholdChangesWaiting(records.proposals.of === READ.read ? records.proposals.value : []);
  const invites = (records.signersInvited?.of === READ.read ? records.signersInvited.value : [])
    .flatMap((i) => ((i.status === OPEN || i.status === 'approved') && typeof i.threshold === 'string' ? [{ id: i.proposal, name: i.name, threshold: i.threshold }] : []));
  return (
    <Section title={t('signers.threshold.title')} list={false} data-threshold>
      <div className="flex flex-col gap-2 text-sm">
        {now.of === READ.read
          ? <p data-threshold-now>{t('signers.threshold.now', { count: now.value })}</p>
          : <p className="text-muted-foreground" data-threshold-unread>{t('signers.threshold.unread')}</p>}
        {changes.map((c) => <p key={c.id} className="text-muted-foreground" data-threshold-pending="change">{t('signers.threshold.pending.change', { count: c.count })}</p>)}
        {invites.map((i) => <p key={i.id} className="text-muted-foreground" data-threshold-pending="invite">{t('signers.threshold.pending.invite', { name: i.name, threshold: i.threshold })}</p>)}
      </div>
    </Section>
  );
}

function NeededSentence({ records }: { records: Records }) {
  const t = useText();
  const says = approvalsSentence(records.approvalsForSigners);
  if (says === null) return <p className="text-sm text-muted-foreground" data-needed-unknown>{t('signers.pending.neededUnknown')}</p>;
  const words = says.code === APPROVALS.account ? t('invite.approvals.account', says.values)
    : says.code === APPROVALS.raised ? t('invite.approvals.raised', says.values) : t('invite.approvals.raisedUnnamed', says.values);
  return <p className="text-sm text-muted-foreground" data-approvals-needed={says.code}>{words}</p>;
}

/** What comes next on an invitation: Approve, or instead Finish adding the invitee at the seat they took, or waiting for their request to reach this page. */
const NEXT = { approve: 'approve', finish: 'finish', seatWaiting: 'seat-waiting' } as const;

/**
 * Approve is offered on every invitation except one the chain says has taken its seat: it reached its bar and was carried
 * out, so the step owed is Finish adding. A seat request alone hides nothing, since the service or another invitee can file
 * one. Who raised it hides nothing either: the wallet refuses an approval the chain already counts, in words of its own.
 */
const nextOf = (i: SignerInvited): (typeof NEXT)[keyof typeof NEXT] =>
  i.seat === null ? NEXT.approve : i.seat.signer === null ? NEXT.seatWaiting : NEXT.finish;

function WaitingList({ records, busy, result, phase, approvedHere, onApprove }: {
  records: Records; busy: boolean; result: Result | null; phase: Phase; approvedHere: ReadonlySet<string>; onApprove: (i: SignerInvited) => void;
}) {
  const t = useText();
  const roleSays = useRoleSays();
  const bar = barOf(records);
  const shortOf = (hex: string): string => (hex.length <= 20 ? hex : t('signers.shortened', { start: hex.slice(0, 8), end: hex.slice(-8) }));
  const waiting = records.signersInvited;
  if (waiting === undefined || waiting.of !== READ.read) {
    return (
      <Section title={t('signers.pending.title')} list={false}>
        <p className="text-sm text-muted-foreground" data-pending-unread>{t('signers.pending.unread')}</p>
      </Section>
    );
  }
  const open = waiting.value.filter((i) => i.status === OPEN || i.status === 'approved');
  return (
    <Section
      title={t('signers.pending.title')} count={open.length} description={<NeededSentence records={records} />} data-pending-signers
      empty={<p className="text-sm text-muted-foreground" data-pending-none>{t('signers.pending.nobody')}</p>}
    >
      {open.map((i) => {
        const on: Pressed = { act: SIGNER_ACT.approve, id: i.proposal };
        const next = nextOf(i);
        return (
          <SectionRow
            key={i.proposal} data-invited={i.proposal} data-next-step={next}
            actions={i.coinKey === null || i.status === 'approved' || i.outrun === true || next !== NEXT.approve ? undefined : (
              <Button size="sm" disabled={busy || approvedHere.has(i.proposal)} onClick={() => onApprove(i)} data-action="approve-signer">{t('signers.approve')}</Button>
            )}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">{i.name}</span>
              <span className="text-muted-foreground">{t('signers.pending.role', { role: roleSays[i.role] ?? i.role })}</span>
              <span className="break-all font-mono text-xs text-muted-foreground" dir="ltr" data-address>{t('signers.pending.address', { address: i.address })}</span>
              <span className="break-all font-mono text-xs text-muted-foreground" dir="ltr" data-scope>{rightsAreOverEveryVault(i.scope) ? t('signers.pending.scope.every') : t('signers.pending.scope', { scope: shortOf(i.scope) })}</span>
              {i.coinKey === null ? null : <span className="break-all font-mono text-xs text-muted-foreground" dir="ltr" data-coin-key>{t('signers.pending.coinKey', { coinKey: shortOf(i.coinKey) })}</span>}
              {i.status === 'approved' ? (
                <>
                  <Badge variant="outline" className="w-fit" data-approved>{t('signers.pending.approved')}</Badge>
                  <span className="text-muted-foreground" data-approved-next>{t('signers.pending.approvedNext', { name: i.name })}</span>
                </>
              ) : (
                <span className="text-muted-foreground" data-approvals>
                  {i.approvals === null ? t('signers.pending.approvals.unknown') : t('signers.pending.approvals.known', { count: i.approvals })}
                </span>
              )}
              {next === NEXT.finish ? <span className="text-muted-foreground" data-next-after-approve>{t('signers.pending.seatTaken', { name: i.name })}</span> : null}
              {next === NEXT.seatWaiting ? <span className="text-muted-foreground" data-next-after-approve>{t('signers.pending.seatWaiting', { name: i.name })}</span> : null}
              {approvedHere.has(i.proposal) && i.status === OPEN ? <span className="text-muted-foreground" data-approved-here>{t('signers.approvedHere')}</span> : null}
              {i.outrun === true ? <span className="text-muted-foreground" data-outrun>{t('signers.pending.outrun')}</span> : null}
              {i.coinKey === null ? <span data-no-coin-key>{t('signers.pending.noCoinKey')}</span> : null}
              <Outcome phase={phase} result={result} of={on} bar={bar} />
            </div>
          </SectionRow>
        );
      })}
    </Section>
  );
}

/** The text of a removal's state: what the wallet told, never more. A state it did not tell is said so. */
function removalSentence(t: ReturnType<typeof useText>, state: string | null, name: string): string {
  if (state === REMOVAL_STATE.waiting) return t('signers.removal.waiting', { name });
  if (state === REMOVAL_STATE.ready) return t('signers.removal.ready', { name });
  if (state === REMOVAL_STATE.retirement) return t('signers.removal.retirement', { name });
  if (state === REMOVAL_STATE.carried) return t('signers.removal.carried', { name });
  return t('signers.removal.unknownState', { name });
}

/**
 * Remove, on the row of a seated signer: the approvals the company should ask for afterwards, stepped down or up from the number
 * in force (never below one, never above the signers who stay; none chosen keeps the number in force), and the one press. The
 * number is held as a number and only ever stepped, as `ChangeThreshold` steps it. The wallet names whose seat it is and asks for
 * the person's confirmation in its own window.
 */
function RemoveControl({ signer, now, seated, busy, onRemove }: {
  signer: { readonly id: string }; now: number | null; seated: number | null; busy: boolean; onRemove: (threshold: number | undefined) => void;
}) {
  const t = useText();
  const [chosen, setChosen] = useState<number | null>(null);
  const staying = seated === null ? null : seated - 1;
  const from = chosen ?? now ?? 1;
  const readable = now !== null && staying !== null;
  const canFewer = readable && from > 1;
  const canMore = readable && from < staying;
  const shown = chosen !== null ? t('changeThreshold.value', { count: chosen }) : now === null ? '' : t('changeThreshold.keeps', { count: now });
  return (
    <div className="flex w-full flex-col gap-2" data-remove={signer.id}>
      <Field>
        <FieldLabel>{t('signers.remove.threshold.label')}</FieldLabel>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || !canFewer} aria-label={t('changeThreshold.fewer')} data-action="remove-threshold-fewer" onClick={() => setChosen(Math.max(from - 1, 1))}>-</Button>
          <span className="min-w-32 text-center" data-remove-threshold-value>{shown}</span>
          <Button type="button" size="sm" variant="outline" disabled={busy || !canMore} aria-label={t('changeThreshold.more')} data-action="remove-threshold-more" onClick={() => setChosen(Math.min(from + 1, staying ?? from))}>+</Button>
          {chosen === null ? null : <Button type="button" size="sm" variant="ghost" disabled={busy} data-action="remove-threshold-keep" onClick={() => setChosen(null)}>{t('changeThreshold.keep')}</Button>}
        </div>
        <FieldDescription>{t('signers.remove.threshold.hint')}</FieldDescription>
      </Field>
      <div><Button size="sm" variant="outline" disabled={busy} onClick={() => onRemove(chosen ?? undefined)} data-action="remove-signer">{t('signers.remove')}</Button></div>
      <p className="text-sm text-muted-foreground">{t('signers.remove.why')}</p>
    </div>
  );
}

/** What a finished removal told besides where it stands: its approvals while it waits, the company key's change, and the vaults' secrets. */
function RemovalTold({ removal, state }: { removal: NonNullable<Extract<SignerActed, { of: 'done' }>['removal']>; state: string | null }) {
  const t = useText();
  const rotationSays = useRotationSays();
  const code = ROTATION.find((c) => c === removal.rotation);
  return (
    <>
      {state === REMOVAL_STATE.waiting && removal.approvals !== null && removal.needed !== null
        ? <p className="text-sm text-muted-foreground" data-removal-approvals>{t('signers.removal.counted', { approvals: removal.approvals, needed: removal.needed })}</p> : null}
      {code === undefined ? null : <p className="text-sm text-muted-foreground" data-removal-rotation={code}>{rotationSays(code)}</p>}
      {removal.vaultSecrets === VAULT_SECRETS_NOT_STARTED ? <p className="text-sm text-muted-foreground" data-removal-vaults-not-started>{t('signers.removal.vaultsNotStarted')}</p> : null}
      {removal.vaultSecrets !== VAULT_SECRETS_NOT_STARTED || removal.vaultSecretsWhy === null || removal.vaultSecretsWhy === 'error' ? null
        : <p className="text-sm text-muted-foreground" data-removal-vaults-not-started-why>{t('signers.removal.vaultsNotStartedWhy', { why: removal.vaultSecretsWhy.replace(/-/gu, ' ') })}</p>}
      {removal.vaults === null ? null : <VaultCounts vaults={removal.vaults} partial={false} unread={false} />}
    </>
  );
}

/** How many vaults ended in each state, one line for each state with any; nothing owed where every count is none. */
function VaultCounts({ vaults, partial, unread }: { vaults: { readonly rotated: number; readonly awaiting: number; readonly owed: number; readonly waiting: number; readonly notChanged: number } | null; partial: boolean; unread: boolean }) {
  const t = useText();
  if (vaults === null) return unread ? <p className="text-sm text-muted-foreground" data-vaults-unread>{t('signers.vaults.unread')}</p> : null;
  const lines: readonly (readonly [string, number, string])[] = [
    [COUNT.rotated, vaults.rotated, t('signers.vaults.rotated', { count: vaults.rotated })], [COUNT.awaiting, vaults.awaiting, t('signers.vaults.awaiting', { count: vaults.awaiting })],
    [COUNT.owed, vaults.owed, t('signers.vaults.owed', { count: vaults.owed })], [COUNT.waiting, vaults.waiting, t('signers.vaults.waiting', { count: vaults.waiting })],
    [COUNT.notChanged, vaults.notChanged, t('signers.vaults.notChanged', { count: vaults.notChanged })],
  ];
  const shown = lines.filter(([, n]) => n > 0);
  return (
    <>
      {shown.length === 0 ? <p className="text-sm text-muted-foreground" data-vaults-none>{t('signers.vaults.nothingOwed')}</p> : null}
      {shown.map(([name, , words]) => <p key={name} className="text-sm text-muted-foreground" data-vaults-count={name}>{words}</p>)}
      {partial ? <p className="text-sm text-muted-foreground" data-vaults-partial>{t('signers.vaults.partial')}</p> : null}
    </>
  );
}

/**
 * The company's vault secrets, after a signer left: the one press a signer who stays makes when a change is owed, what the vaults do
 * until the new secrets are held, and how the last press ended. It is always on the page; the wallet decides, for each vault, whether a
 * change is owed and whether this seat is the one to make it.
 */
function VaultSecrets({ busy, result, phase, onChange }: { busy: boolean; result: Result | null; phase: Phase; onChange: () => void }) {
  const t = useText();
  return (
    <Section title={t('signers.vaults.title')} description={t('signers.vaults.description')} list={false} data-vault-secrets>
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">{t('signers.vaults.promise')}</p>
        <div><Button size="sm" variant="outline" disabled={busy} onClick={onChange} data-action="change-vault-secrets">{t('signers.vaults.change')}</Button></div>
        <Outcome phase={phase} result={result} of={{ act: SIGNER_ACT.rotate, id: VAULTS }} bar={null} />
      </div>
    </Section>
  );
}
