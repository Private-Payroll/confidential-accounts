import { HugeiconsIcon } from '@hugeicons/react';
import type { IconSvgElement } from '@hugeicons/react';
import {
  Alert02Icon, AlertDiamondIcon, ArrowDownLeft01Icon, ArrowRight01Icon,
  ArrowUpRight01Icon, ChartUpIcon, CheckmarkCircle02Icon, CompassIcon, ContactBookIcon,
  GlobeIcon, Home01Icon, IdCardIcon, InboxIcon, InformationCircleIcon, Key01Icon, LockIcon,
  Moon02Icon, MonitorIcon,
  PencilEdit02Icon, PlusSignIcon, PrinterIcon,
  QrCode01Icon, ReceiptIcon, Settings02Icon, ShieldCheckIcon, Sun03Icon, Tick02Icon,
  UnfoldMoreIcon, Wallet01Icon,
} from '@hugeicons/core-free-icons';

/**
 * WHICH PICTURE MEANS WHAT, IN THE WALLET. The icons are HugeIcons, the kit's
 * set, and each is named here by what it stands for rather than by what it
 * shows, so a screen asks for `GLYPH.send` and every screen that sends shows
 * the same arrow.
 */
export type { IconSvgElement };

export const GLYPH = {
  /* places */
  home: Home01Icon,
  activity: ReceiptIcon,
  explore: CompassIcon,
  settings: Settings02Icon,

  /* actions and chrome */
  newAction: PlusSignIcon,
  send: ArrowUpRight01Icon,
  /* HOME'S QUICK ACTIONS AND ITS PENCIL. Five names, and they are named
   * here rather than at the call site for the reason this file exists: a
   * screen asks for `GLYPH.receive`, and what `receive` is DRAWN as stays one
   * decision in one file.
   *
   * `receive` MIRRORS `send` ON PURPOSE — the same arrow, turned round. They
   * are the pair a person reads fastest, and drawing them from different
   * families would make the pair the thing they have to decode.
   *
   * `rename` IS THE PENCIL, and the design says it is not cosmetic:
   * naming is what CREATES an account, so this glyph sits on the control that
   * adopts a slot. */
  receive: ArrowDownLeft01Icon,
  rename: PencilEdit02Icon,
  qr: QrCode01Icon,
  earn: ChartUpIcon,
  contacts: ContactBookIcon,
  /* MY PROFILE, AND IT IS ITS OWN NAME BECAUSE IT SITS BESIDE
   * `contacts` IN ONE BLOCK ON HOME. Two tiles side by side wearing one
   * drawing is two tiles a person has to READ rather than recognise, which is
   * the whole of what a glyph is for. `contacts` is the book of OTHER people;
   * this is the card that says who YOU are.
   *
   * IT IS NOT `passkey`, AND THAT IS A CLAIM RATHER THAN A TASTE. A key in
   * this wallet means a CREDENTIAL — the thing that opens an account, and the
   * thing a company is released. What this glyph sits on is a name and an
   * email that a person typed about themselves, which no key opens and nobody
   * has checked. Drawing the two alike would say they are the same kind of
   * thing.
   *
   * WHAT SEPARATES THE TWO DRAWINGS WAS READ OFF THE DATA, NOT ASSUMED. Both
   * carry a person. `ContactBookIcon` is a PORTRAIT book with a spine, three
   * marks down its left edge; `IdCardIcon` is a LANDSCAPE card with two rules
   * of type beside the face. The container is the difference, and both are
   * drawn at the same stroke, so neither is heavier than its neighbours. */
  details: IdCardIcon,
  /* THE HEADER CHEVRON, and it is `next` rather than `chevronRight`
   * because this file names the MEANING and lets the drawing be swappable.
   * It means *the place this card is a preview of*, and it has two callers.
   *
   * `ArrowRight01Icon` IS A CHEVRON, checked rather than assumed: its path
   * is one bent stroke with no shaft. `ArrowRight02Icon` is the one with a
   * shaft, and an arrow that carries a line reads as *go somewhere else*
   * rather than *open this*. */
  next: ArrowRight01Icon,
  lock: LockIcon,
  chosen: Tick02Icon,
  switcher: UnfoldMoreIcon,

  /* themes — one per entry in `shell/themes.ts`, plus the machine */
  themeDark: Moon02Icon,
  themeLight: Sun03Icon,
  themeSystem: MonitorIcon,

  /* the four severities of `StatusAlert` */
  info: InformationCircleIcon,
  success: CheckmarkCircle02Icon,
  warning: Alert02Icon,
  danger: AlertDiamondIcon,

  /* SETTINGS. Two names, and they are named here for this file's own
   * reason: a screen asks for `GLYPH.passkey`, and what a passkey is DRAWN as
   * stays one decision in one file.
   *
   * `passkey` IS A KEY AND NOT A FINGERPRINT, and that is a claim rather than
   * a taste. A fingerprint draws the GESTURE — the thing the person does on
   * one particular authenticator — and this wallet's passkeys are also opened
   * by a face, a PIN and a hardware key on a USB port. The credential is the
   * thing being listed, so the credential is what is drawn.
   *
   * `network` IS THE GLOBE because the section it heads is about hosts this
   * wallet dials, which is the only place in this product where something
   * leaves the machine. */
  passkey: Key01Icon,
  network: GlobeIcon,

  /* things the gallery draws, and screens will */
  inbox: InboxIcon,
  printer: PrinterIcon,
  secured: ShieldCheckIcon,
  wallet: Wallet01Icon,
} satisfies Record<string, IconSvgElement>;

/**
 * A glyph looked up by a name computed at runtime — which is what the theme
 * picker does, because the theme list is data and its entries name their own
 * glyphs. An unknown name falls back rather than throwing: a theme added to
 * `shell/themes.ts` without a glyph should look dull, not take the wallet down.
 */
export function glyphFor(name: string): IconSvgElement {
  const found = (GLYPH as Record<string, IconSvgElement | undefined>)[name];
  return found ?? GLYPH.themeSystem;
}

/**
 * A glyph beside words. It is hidden from screen readers, because the words
 * beside it already say what it means; a glyph that stands alone is given its
 * name by the control it sits in. It takes its size from where it sits: a
 * kit button sizes its icons, and anywhere else the caller says how large.
 */
export function Glyph({ icon, className }: {
  readonly icon: IconSvgElement;
  readonly className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={2}
      className={className === undefined ? 'shrink-0' : `shrink-0 ${className}`}
      aria-hidden="true"
      focusable="false"
    />
  );
}
