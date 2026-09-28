import { Kbd, KbdGroup, useText } from 'vaults-ui';
import { SHORTCUTS, type Chord, type ShortcutId } from '../shortcuts.js';
import { useSession } from '../session.js';

/** How a key is shown when it is not a letter or a sign: ⌘ and ⇧ on a Mac, a word from the language file elsewhere, and ↵ for Enter everywhere. */
const SHOWN = { command: '⌘', shift: '⇧', enter: '↵' } as const;

/** One way to press a shortcut, as keys: on a Mac with its symbols, elsewhere with the language's name for Ctrl. */
export function ChordKeys({ chord, bare = false }: { chord: Chord; bare?: boolean }) {
  const t = useText();
  const { mac } = useSession();
  const keys: string[] = [];
  if (chord.command === true) keys.push(mac ? SHOWN.command : t('key.control'));
  /* Shift is shown for a letter or a named key; a sign such as ? is shown as the sign, which is what is pressed. */
  if (chord.shift === true && (chord.key.length > 1 || /^[a-z]$/.test(chord.key))) keys.push(mac ? SHOWN.shift : t('key.shift'));
  keys.push(chord.key === 'enter' ? SHOWN.enter : chord.key === 'escape' ? t('key.escape') : chord.key.toUpperCase());
  if (bare) return <span dir="ltr" className="inline-flex gap-1">{keys.map((k, i) => <span key={i}>{k}</span>)}</span>;
  return <KbdGroup dir="ltr">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</KbdGroup>;
}

/** Every way to press a shortcut from the table, the one shown first leading; `bare` shows that one alone. */
export function ShortcutKeys({ id, bare = false }: { id: ShortcutId; bare?: boolean }) {
  const t = useText();
  const chords = SHORTCUTS[id].chords;
  if (bare) return <ChordKeys chord={chords[0]!} bare />;
  return (
    <span className="inline-flex items-center gap-1" data-shortcut={id}>
      {chords.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-xs text-muted-foreground">{t('key.or')}</span> : null}
          <ChordKeys chord={c} />
        </span>
      ))}
    </span>
  );
}
