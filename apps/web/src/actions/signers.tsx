import { useState } from 'react';
import { Alert, AlertDescription, Badge, Button, Section, SectionRow, useText } from 'vaults-ui';
import { APPROVALS, approvalsSentence, INVITE_KIND, ROLE } from '../adapters/invite.js';
import { READ } from '../adapters/reads.js';
import { SIGNER_ACT, SIGNER_ACTED, WHY, admitSigner, approveSigner, giveYourKeys, type SignerAct, type SignerActed, type SignerWhy } from '../adapters/signer-acts.js';
import type { SignerInvited } from '../adapters/signers.js';
import { ActRefused } from '../act-refused.js';
import { useCompanyRecords } from '../records/company-records.js';
import { WithRecords } from '../records/parts.js';
import { useSession } from '../session.js';
import type { StepProps } from '../setup/step-ids.js';
import { CommitteeChange } from './committee-change.js';
import { InvitePeople } from './invite.js';

const STANDING = { seated: 'seated', finish: 'finish', accepted: 'accepted', notSeated: 'not-seated' } as const;
type Standing = (typeof STANDING)[keyof typeof STANDING];
const OPEN = 'open';

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
  };
}

function useRoleSays(): Record<string, string> {
  const t = useText();
  return {
    [ROLE.admin]: t('invite.role.admin'), [ROLE.approver]: t('invite.role.approver'), [ROLE.initiator]: t('invite.role.initiator'),
    [ROLE.viewer]: t('invite.role.viewer'),
  };
}

function useStandingSays(): Record<Standing, string> {
  const t = useText();
  return {
    [STANDING.seated]: t('signers.standing.seated'), [STANDING.finish]: t('signers.standing.finish'),
    [STANDING.accepted]: t('signers.standing.accepted'), [STANDING.notSeated]: t('signers.standing.notSeated'),
  };
}

const barOf = (records: { readonly approvalsForSigners?: Parameters<typeof approvalsSentence>[0] }): number | null => approvalsSentence(records.approvalsForSigners)?.values.count ?? null;

const standingOf = (s: { accepted: boolean; seatOnChain: boolean }): Standing =>
  s.accepted ? (s.seatOnChain ? STANDING.finish : STANDING.accepted) : s.seatOnChain ? STANDING.seated : STANDING.notSeated;

/** What is being asked of the wallet: which act, for which invitation (its record id) or signer (their id). */
interface Pressed { readonly act: SignerAct; readonly id: string }
/** The act the wallet is working on and how far it has got; null when nothing is being asked of it. */
type Phase = { readonly on: Pressed; readonly step: number; readonly steps: number } | null;
type Result = { readonly on: Pressed; readonly act: SignerActed; readonly name: string };
const same = (a: Pressed, b: Pressed): boolean => a.act === b.act && a.id === b.id;

/**
 * The signers of a company: where each stands, with you marked by the seat this device holds; the invitations waiting for
 * approvals with Approve on each this person may still approve and what comes next on the others (`nextOf`); Finish adding
 * for a signer whose seat the network holds; Give your keys on your own seat while the company's directory holds no entry
 * for it; Add a signer, and below them who holds the company, with the change of the super admins a vault may be owed
 * (the committee change). The settings page shows it, and the setup wizard's signers step shows this same component (it
 * is given the step's props there, and then draws the invitation form itself); neither draws a copy.
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
              onGiveKeys={(s) => { void run({ act: SIGNER_ACT.giveKeys, id: s.id }, s.name, (onStep) => giveYourKeys(person.id, company ?? '', onStep)); }} />
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

function Working({ phase, of }: { phase: Phase; of: Pressed }) {
  const t = useText();
  if (phase === null || !same(phase.on, of)) return null;
  return (
    <p role="status" className="text-sm text-muted-foreground" data-working>
      {phase.steps > 0 ? t('signers.working.step', { step: phase.step, steps: phase.steps }) : t('signers.working')}
    </p>
  );
}

function Outcome({ result, of, bar }: { result: Result | null; of: Pressed; bar: number | null }) {
  const t = useText();
  const whySays = useWhySays();
  if (result === null || !same(result.on, of)) return null;
  const { act, name } = result;
  const kind = result.on.act;
  if (act.of === SIGNER_ACTED.done && kind === SIGNER_ACT.giveKeys) {
    return (
      <>
        <p className="text-sm" data-acted={kind}>{t('signers.done.keysGiven')}</p>
        <p className="text-sm text-muted-foreground" data-next-steps>{t('signers.done.keysGivenNext')}</p>
      </>
    );
  }
  if (act.of === SIGNER_ACTED.done) {
    const words = kind === SIGNER_ACT.admit
      ? (act.state === 'already-admitted' ? t('signers.done.alreadyAdmitted', { name }) : t('signers.done.admitted', { name }))
      : t('signers.done.approved', { name });
    const next = kind === SIGNER_ACT.admit ? null : act.state === 'waiting-for-the-invitee' ? t('signers.done.complete', { name }) : bar === null ? t('signers.done.nextUnknown', { name }) : t('signers.done.next', { name, count: bar });
    return (
      <>
        <p className="text-sm" data-acted={kind}>{words}</p>
        {next === null ? null : <p className="text-sm text-muted-foreground" data-next-steps>{next}</p>}
      </>
    );
  }
  if (act.of === SIGNER_ACTED.refused) return <ActRefused why={act.why} />;
  return (
    <Alert data-signer-stopped={act.why} variant={act.partial || act.handedOver ? 'default' : 'destructive'}>
      <AlertDescription>{act.handedOver && !act.partial ? t('signers.sent') : whySays[act.why]}</AlertDescription>
      {act.partial ? <AlertDescription data-partial>{t('signers.partial')}</AlertDescription> : null}
    </Alert>
  );
}

function StandingList({ records, busy, result, phase, onFinish, onGiveKeys }: {
  records: Records; busy: boolean; result: Result | null; phase: Phase; onFinish: (s: { id: string; name: string }) => void;
  onGiveKeys: (s: { id: string; name: string }) => void;
}) {
  const t = useText();
  /* The name the create step saves a founding seat under when its person gave none: shown beside the name, so it is never read as you. */
  const savedAsYou = t('setup.createCompany.you');
  const says = useStandingSays();
  const bar = barOf(records);
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
            <span className="font-medium">{s.name}</span>
            {s.you === true ? <Badge data-you>{t('signers.you')}</Badge> : null}
            <Badge variant="outline">{says[stands]}</Badge>
            {s.you !== true && s.name === savedAsYou ? <p className="w-full text-sm text-muted-foreground" data-named-you>{t('signers.namedYou')}</p> : null}
            {giveKeys ? <p className="w-full text-sm text-muted-foreground" data-give-keys-why>{t('signers.giveKeys.why')}</p> : null}
            {stands === STANDING.accepted ? <p className="w-full text-sm text-muted-foreground" data-next-for-them>{t('signers.standing.acceptedNext')}</p> : null}
            {stands === STANDING.notSeated ? <p className="w-full text-sm text-muted-foreground" data-next-for-them>{t('signers.standing.notSeatedNext')}</p> : null}
            <div className="flex w-full flex-col gap-2">
              <Working phase={phase} of={on} />
              <Outcome result={result} of={on} bar={bar} />
            </div>
          </SectionRow>
        );
      })}
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
            actions={i.coinKey === null || i.status === 'approved' || next !== NEXT.approve ? undefined : (
              <Button size="sm" disabled={busy || approvedHere.has(i.proposal)} onClick={() => onApprove(i)} data-action="approve-signer">{t('signers.approve')}</Button>
            )}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">{i.name}</span>
              <span className="text-muted-foreground">{t('signers.pending.role', { role: roleSays[i.role] ?? i.role })}</span>
              <span className="break-all font-mono text-xs text-muted-foreground" dir="ltr" data-address>{t('signers.pending.address', { address: i.address })}</span>
              <span className="break-all font-mono text-xs text-muted-foreground" dir="ltr" data-scope>{t('signers.pending.scope', { scope: shortOf(i.scope) })}</span>
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
              {i.coinKey === null ? <span data-no-coin-key>{t('signers.pending.noCoinKey')}</span> : null}
              <Working phase={phase} of={on} />
              <Outcome result={result} of={on} bar={bar} />
            </div>
          </SectionRow>
        );
      })}
    </Section>
  );
}
