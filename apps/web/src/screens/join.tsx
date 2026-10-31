import { useEffect, useId, useState } from 'react';
import {
  Alert, AlertDescription, AlertTitle, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Item, ItemContent,
  ItemDescription, ItemTitle, PageLayout, Spinner, useText,
} from 'vaults-ui';
import { ActRefused } from '../act-refused.js';
import {
  CLOSED, FULL_TIME, joinTheCompany, openTheInvitation, SAYS_NOTHING_SENT, STOPPED, WAY, type ClosedWhy, type Joined, type Offered, type StoppedWhy,
} from '../adapters/join.js';
import type { ActRefusal } from '../adapters/refusals.js';
import { OF, signIn, type SignInRefusal } from '../adapters/session.js';
import { HOME } from '../pages.js';
import { useCalendarDay, useMoment } from '../records/parts.js';
import { forgetLink, go, homeOf, useCurrentPage, useHeldLink } from '../router.js';
import { useSessionIfAny } from '../session.js';
import { useVisitor } from '../visitor.js';
import { signInRefusedSays } from './landing.js';

/** What the page is showing, one at a time, compared by the code. */
const STATE = {
  noToken: 'no-token', opening: 'opening', closed: 'closed', offered: 'offered', working: 'working', refused: 'refused', stopped: 'stopped',
  done: 'done', notNow: 'not-now',
} as const;


type JoinState =
  | { readonly of: typeof STATE.noToken }
  | { readonly of: typeof STATE.opening }
  | { readonly of: typeof STATE.closed; readonly why: ClosedWhy; readonly expiresAt: string | null }
  | { readonly of: typeof STATE.offered; readonly offer: Offered }
  | { readonly of: typeof STATE.working; readonly offer: Offered; readonly step: number | null; readonly steps: number | null }
  | { readonly of: typeof STATE.refused; readonly offer: Offered; readonly why: ActRefusal }
  | { readonly of: typeof STATE.stopped; readonly offer: Offered; readonly why: StoppedWhy; readonly step: number; readonly steps: number; readonly handedOver: boolean }
  | { readonly of: typeof STATE.done; readonly offer: Offered }
  | { readonly of: typeof STATE.notNow };

interface JoinActions {
  readonly accept: () => void;
  readonly signIn: () => void;
  readonly leave: () => void;
  readonly goOn: () => void;
  readonly again: () => void;
}

interface JoinViewProps {
  readonly state: JoinState;
  readonly signedIn: boolean;
  readonly signingIn: boolean;
  readonly signInRefusal: { readonly why: SignInRefusal; readonly retryAfterSeconds: number | null } | null;
  readonly actions: JoinActions;
}

type Words = ReturnType<typeof useText>;

const kindSays = (t: Words, kind: Offered['kind']): string =>
  ({ employee: t('join.kind.employee'), vendor: t('join.kind.vendor'), signer: t('join.kind.signer') })[kind];
const roleSays = (t: Words, role: NonNullable<Offered['role']>): string =>
  ({ admin: t('invite.role.admin'), approver: t('invite.role.approver'), initiator: t('invite.role.initiator'), viewer: t('invite.role.viewer') })[role];
const classificationSays = (t: Words, c: NonNullable<Offered['classification']>): string =>
  (c === FULL_TIME ? t('invite.classification.fullTime') : t('invite.classification.partTime'));
const waySays = (t: Words, offer: Offered): string =>
  ({
    [WAY.seat]: t('join.way.seat'), [WAY.code]: offer.address === null ? t('join.way.code') : t('join.way.codeAt'), [WAY.claim]: t('join.way.claim'),
  })[offer.way];
const whenSays = (t: Words, moment: (at: string) => string, at: string): string =>
  t('join.when', { when: moment(at), zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const acceptSays = (t: Words, kind: Offered['kind']): string =>
  ({ employee: t('join.accept.person'), vendor: t('join.accept.person'), signer: t('join.accept.signer') })[kind];
const doneSays = (t: Words, way: Offered['way']): string =>
  ({ [WAY.seat]: t('join.done.seat'), [WAY.code]: t('join.done.code'), [WAY.claim]: t('join.done.claim') })[way];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Item size="xs" className="min-w-0 items-start">
      <ItemContent className="min-w-0">
        <ItemDescription>{label}</ItemDescription>
        <ItemTitle className="min-w-0 break-words">{children}</ItemTitle>
      </ItemContent>
    </Item>
  );
}

function Facts({ offer }: { offer: Offered }) {
  const t = useText();
  const day = useCalendarDay();
  const moment = useMoment();
  const start = offer.startDate === null ? '' : day(offer.startDate);
  const end = offer.endDate === null ? '' : day(offer.endDate);
  return (
    <div className="flex flex-col gap-1" data-offer-facts>
      <Row label={t('join.field.name')}>{offer.name}</Row>
      {offer.title === null ? null : <Row label={t('join.field.title')}>{offer.title}</Row>}
      {offer.role === null ? null : <Row label={t('join.field.role')}>{roleSays(t, offer.role)}</Row>}
      {offer.classification === null ? null : <Row label={t('join.field.time')}>{classificationSays(t, offer.classification)}</Row>}
      {start === '' ? null : <Row label={t('join.field.start')}>{start}</Row>}
      {end === '' ? null : <Row label={t('join.field.end')}>{end}</Row>}
      {offer.address === null ? null : <Row label={t('join.field.address')}><span className="font-mono break-all">{offer.address}</span></Row>}
      <Row label={t('join.field.until')}>{whenSays(t, moment, offer.expiresAt)}</Row>
    </div>
  );
}

function Shown({ of, title, body, children, footer }: {
  of: JoinState['of']; title: string; body?: string | undefined; children?: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <Card className="w-full max-w-lg" data-join-card={of}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {body === undefined ? null : <CardDescription>{body}</CardDescription>}
      </CardHeader>
      {children === undefined ? null : <CardContent className="flex flex-col gap-4">{children}</CardContent>}
      {footer === undefined ? null : <CardFooter className="flex flex-wrap gap-2">{footer}</CardFooter>}
    </Card>
  );
}

const closedSays = (t: Words, why: ClosedWhy): string => ({
  [CLOSED.notFound]: t('join.closed.notFound'), [CLOSED.withdrawn]: t('join.closed.withdrawn'), [CLOSED.expired]: t('join.closed.expired'),
  [CLOSED.used]: t('join.closed.used'), [CLOSED.notAccepted]: t('join.closed.notAccepted'), [CLOSED.notOpened]: t('join.closed.notOpened'),
  [CLOSED.superAdmin]: t('join.closed.superAdmin'), [CLOSED.reissue]: t('join.closed.reissue'), [CLOSED.seatByAddressOnly]: t('join.closed.seatByAddressOnly'),
  [CLOSED.unreachable]: t('join.closed.unreachable'),
})[why];

const stoppedSays = (t: Words, why: StoppedWhy, way: Offered['way'], handedOver: boolean): string => (handedOver && SAYS_NOTHING_SENT.has(why) ? t('join.stopped.sent') : why === STOPPED.notTaken && way === WAY.claim ? t('join.stopped.notTakenClaim') : ({
  [STOPPED.used]: t('join.stopped.used'), [STOPPED.expired]: t('join.stopped.expired'), [STOPPED.alreadySeated]: t('join.stopped.alreadySeated'),
  [STOPPED.usedByThisWallet]: t('join.stopped.usedByThisWallet'), [STOPPED.notHeld]: t('join.stopped.notHeld'),
  [STOPPED.noSavedKeys]: t('join.stopped.noSavedKeys'), [STOPPED.noSlots]: t('join.stopped.noSlots'), [STOPPED.notByAddress]: t('join.stopped.notByAddress'),
  [STOPPED.noOffer]: t('join.stopped.noOffer'), [STOPPED.anotherCompany]: t('join.stopped.anotherCompany'),
  [STOPPED.byPublicAddress]: t('join.stopped.byPublicAddress'), [STOPPED.notTaken]: t('join.stopped.notTaken'), [STOPPED.notSent]: t('join.stopped.notSent'),
  [STOPPED.notAsked]: t('join.stopped.notAsked'), [STOPPED.takenByAnother]: t('join.stopped.takenByAnother'),
  [STOPPED.noFreeSeat]: t('join.stopped.noFreeSeat'), [STOPPED.other]: t('join.stopped.other'),
})[why]);

/** The page, drawn from a state. Nothing here reads or sends anything. */
const MENDED_BY_PRESSING: ReadonlySet<StoppedWhy> = new Set<StoppedWhy>([
  STOPPED.notTaken, STOPPED.notSent, STOPPED.notAsked, STOPPED.other, STOPPED.usedByThisWallet,
]);

function JoinView({ state, signedIn, signingIn, signInRefusal, actions }: JoinViewProps) {
  const t = useText();
  const moment = useMoment();
  const stoppedId = useId();
  const home = <Button variant="outline" onClick={actions.goOn} data-action="go-on">{signedIn ? t('join.goOn') : t('join.goOn.visitor')}</Button>;
  const body = ((): React.ReactNode => {
    switch (state.of) {
      case STATE.noToken:
        return <Shown of={state.of} title={t('join.noToken.title')} body={t('join.noToken.body')} />;
      case STATE.opening:
        return (
          <Shown of={state.of} title={t('join.opening.title')}>
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner aria-label={t('join.opening.title')} />{t('join.opening.body')}</p>
          </Shown>
        );
      case STATE.closed:
        return (
          <Shown
            of={state.of} title={t('join.closed.title')}
            body={state.why === CLOSED.expired && state.expiresAt !== null ? t('join.closed.expiredAt', { when: whenSays(t, moment, state.expiresAt) }) : closedSays(t, state.why)}
            footer={(
              <>
                {state.why === CLOSED.unreachable ? <Button variant="outline" onClick={actions.again} data-action="try-again">{t('join.again')}</Button> : null}
                {home}
              </>
            )}
          />
        );
      case STATE.offered:
      case STATE.working:
      case STATE.refused:
      case STATE.stopped: {
        const offer = state.offer;
        const working = state.of === STATE.working;
        return (
          <Shown
            of={state.of} title={t('join.offer.title', { company: offer.companyName })} body={kindSays(t, offer.kind)}
            footer={(
              <>
                {signedIn ? (
                  <Button disabled={working || (state.of === STATE.stopped && !MENDED_BY_PRESSING.has(state.why))} aria-describedby={state.of === STATE.stopped ? stoppedId : undefined} onClick={actions.accept} data-action="accept">{acceptSays(t, offer.kind)}</Button>
                ) : (
                  <Button disabled={signingIn} onClick={actions.signIn} data-action="sign-in">{t('join.signIn')}</Button>
                )}
                <Button variant="ghost" disabled={working} onClick={actions.leave} data-action="not-now">{t('join.notNow')}</Button>
              </>
            )}
          >
            <Facts offer={offer} />
            <p className="text-sm text-muted-foreground" data-way={offer.way}>
              {waySays(t, offer)}
            </p>
            {signedIn ? null : <p className="text-sm text-muted-foreground">{t('join.signIn.why')}</p>}
            {signInRefusal === null ? null : (
              <Alert data-refusal={signInRefusal.why}>
                <AlertTitle>{t('signIn.refused.title')}</AlertTitle>
                <AlertDescription>{signInRefusedSays(t, signInRefusal.why, signInRefusal.retryAfterSeconds)}</AlertDescription>
              </Alert>
            )}
            {state.of === STATE.working ? (
              <p className="flex items-center gap-2 text-sm" role="status" data-working>
                <Spinner aria-label={t('join.working')} />
                {state.step === null || state.steps === null ? t('join.working') : t('join.working.step', { step: state.step, steps: state.steps })}
              </p>
            ) : null}
            {state.of === STATE.refused ? <ActRefused why={state.why} /> : null}
            {state.of === STATE.stopped ? (
              <Alert id={stoppedId} data-stopped={state.why}>
                <AlertTitle>{t('join.stopped.title')}</AlertTitle>
                <AlertDescription>
                  {t('join.stopped.where', { step: state.step, steps: state.steps })} {stoppedSays(t, state.why, offer.way, state.handedOver)}
                </AlertDescription>
              </Alert>
            ) : null}
          </Shown>
        );
      }
      case STATE.done:
        return (
          <Shown
            of={state.of} title={t('join.done.title', { company: state.offer.companyName })} body={doneSays(t, state.offer.way)}
            footer={home}
          />
        );
      case STATE.notNow:
        return (
          <Shown
            of={state.of} title={t('join.left.title')} body={t('join.left.body')}
            footer={home}
          />
        );
    }
  })();
  return body;
}

const offerOf = (s: JoinState): Offered | null =>
  (s.of === STATE.noToken || s.of === STATE.opening || s.of === STATE.closed || s.of === STATE.notNow ? null : s.offer);

interface Joining {
  readonly state: JoinState;
  readonly signingIn: boolean;
  readonly signInRefusal: JoinViewProps['signInRefusal'];
  readonly actions: JoinActions;
}

/**
 * The page's own state: the invitation the link carried opened once the token is held, the wallet act run on a press, and
 * the held link forgotten once the person has joined or left. A stopped act keeps the link, so pressing again goes on.
 */
function useJoining(person: string | null, signedInNow: (() => Promise<void>) | null, goOn: () => void): Joining {
  const t = useText();
  const { params } = useCurrentPage();
  const id = params.id ?? '';
  const token = useHeldLink(id);
  const [state, setState] = useState<JoinState>(token === null ? { of: STATE.noToken } : { of: STATE.opening });
  const [tried, setTried] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const [signInRefusal, setSignInRefusal] = useState<JoinViewProps['signInRefusal']>(null);

  useEffect(() => {
    if (token === null) { setState((s) => (s.of === STATE.done || s.of === STATE.notNow ? s : { of: STATE.noToken })); return; }
    let alive = true;
    setState({ of: STATE.opening });
    void openTheInvitation(id, token, person).then((o) => {
      if (alive) setState(o.of === STATE.offered ? { of: STATE.offered, offer: o.offer } : { of: STATE.closed, why: o.why, expiresAt: o.expiresAt });
    });
    return () => { alive = false; };
  }, [id, token, person, tried]);

  const accept = (): void => {
    const offer = offerOf(state);
    if (offer === null || person === null) return;
    setState({ of: STATE.working, offer, step: null, steps: null });
    void joinTheCompany(person, offer, (at) => setState({ of: STATE.working, offer, step: at.step, steps: at.steps })).then((r: Joined) => {
      if (r.of === STATE.done) { forgetLink(); setState({ of: STATE.done, offer }); return; }
      setState(r.of === STATE.stopped ? { of: STATE.stopped, offer, why: r.why, step: r.step, steps: r.steps, handedOver: r.handedOver } : { of: STATE.refused, offer, why: r.why });
    });
  };

  const startSignIn = (): void => {
    if (signedInNow === null) return;
    setSignInRefusal(null);
    setSigningIn(true);
    void signIn({ name: t('app.title'), purpose: t('signIn.purpose') }).then(async (r) => {
      if (r.of === OF.refused) { setSigningIn(false); setSignInRefusal({ why: r.why, retryAfterSeconds: r.retryAfterSeconds }); return; }
      await signedInNow();
    });
  };

  const actions: JoinActions = {
    accept, signIn: startSignIn, goOn, again: () => setTried((n) => n + 1),
    leave: () => { forgetLink(); setState({ of: STATE.notNow }); },
  };
  return { state, signingIn, signInRefusal, actions };
}

function MemberJoin({ person, goOn }: { person: string; goOn: () => void }) {
  const joining = useJoining(person, null, goOn);
  return <JoinView {...joining} signedIn={true} />;
}

function VisitorJoin() {
  const t = useText();
  const { signedInNow } = useVisitor();
  const joining = useJoining(null, signedInNow, () => go(HOME.visitor));
  return (
    <PageLayout>
      <div className="flex flex-col items-center gap-6" data-visitor-join>
        <p className="font-heading text-lg font-semibold" data-site>{t('app.title')}</p>
        <JoinView {...joining} signedIn={false} />
      </div>
    </PageLayout>
  );
}

/** The joining page: opens the invitation the link carried and offers the one act its kind and way need, to a visitor or to a signed-in person. */
export function Join() {
  const session = useSessionIfAny();
  if (session === null) return <div data-screen="join"><VisitorJoin /></div>;
  const goOn = (): void => { void session.companiesChanged().then(() => go(homeOf(session.viewer))); };
  return <div data-screen="join"><MemberJoin person={session.person.id} goOn={goOn} /></div>;
}
