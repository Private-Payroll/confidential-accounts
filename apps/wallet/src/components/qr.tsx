import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import QRCode from 'qrcode';
import * as jsqrNamespace from 'jsqr';
import { CopyButton } from './ui.js';
import { describeFailure } from '../lib/failure-text.js';

/* `jsqr` ships CommonJS with a default export; the bundler hands back the
 * function (sometimes under `.default`), the typechecker sees the namespace.
 * One narrow cast here, typed to exactly the call the scanner makes. */
type JsQrFn = (
  data: Uint8ClampedArray, width: number, height: number,
) => { readonly data: string } | null;
const jsQR: JsQrFn =
  (((jsqrNamespace as { default?: unknown }).default) ?? jsqrNamespace) as JsQrFn;

/**
 * THE TWO HALVES OF "SCAN A CODE" — showing one, and reading one.
 *
 * §1 says scan a code; the old harness's four copy-paste blobs are
 * the thing this replaces. Every message that crosses between the two devices
 * during pairing is shown as a QR code with the same payload available as
 * text underneath — because the machine doing the reading may have no camera
 * (a desktop, a headless test, a phone whose camera is refused), and a person
 * with no camera still deserves the flow.
 *
 * WHAT IS AND IS NOT ALLOWED THROUGH HERE. Pairing payloads — the code, the
 * commitment, the nonce, the revealed key, the sealed keys — are designed to
 * travel; showing them is the protocol working. THE TWO DIGITS ARE NOT A
 * PAYLOAD and must never pass through these components: each device computes
 * its own number and a person compares them. There is deliberately no
 * component here for "display a number that arrived in a message" — and
 * A test pins the rendered surface, not this comment.
 */

/**
 * A QR code for a payload THIS device produced, with the text underneath.
 * The SVG is generated locally by `qrcode` from our own base64url string —
 * nothing remote, nothing user-controlled beyond the payload itself.
 */
export function QrPanel({ payload, caption, testId, bare = false }: {
  readonly payload: string;
  readonly caption: string;
  readonly testId: string;
  /**
   * DROP THE TEXT REVEAL AND ITS COPY BUTTON, for a caller that already
   * has both. The pairing screens need them: the machine reading the code may
   * have no camera, and the payload has nowhere else to be shown. Home's
   * Receive popup is the opposite case — the address is printed in full on the
   * same panel, with its own copy control naming WHOSE address it is,
   * and this component's generic *"Copy it"* beside it would be a second,
   * weaker confirmation of the same value. Default `false`, so every existing
   * caller is unchanged.
   */
  readonly bare?: boolean;
}): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
      .then((drawn) => { if (!stale) setSvg(drawn); })
      .catch(() => { if (!stale) setSvg(null); });
    return () => { stale = true; };
  }, [payload]);
  return (
    <div className="qr-block">
      {svg !== null && (
        <div
          className="qr-panel"
          role="img"
          aria-label={caption}
          /* Locally generated SVG from this device's own payload — see above. */
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <p className="muted small qr-caption">{caption}</p>
      {!bare && (
        <details className="reveal">
          <summary>No camera on the other machine? Show it as text</summary>
          <div className="mono qr-text" data-testid={testId}>{payload}</div>
          <CopyButton text={payload} label="Copy it" />
        </details>
      )}
    </div>
  );
}

/**
 * Read a payload the OTHER device is showing: point the camera at its QR
 * code, or type/paste the text form. The camera path only appears where the
 * browser offers one; the typed path always exists.
 *
 * The video element and the scan loop are wired up in an EFFECT keyed
 * on the stream, never inside the async click handler — a state update after
 * an `await` is not flushed by the next line, so the version that read
 * `videoRef.current` right after `setScanning(true)` found null, returned
 * with the stream live, and never scheduled a single frame. The camera light
 * came on and nothing ever scanned. The effect runs after the `<video>` has
 * committed, and its cleanup is the single place the stream is stopped — so
 * unmounting mid-scan, pressing stop, and a successful decode all release
 * the camera through the same line.
 */
export function ScanInput({ label, actionLabel, onPayload, disabled }: {
  readonly label: string;
  readonly actionLabel: string;
  onPayload(text: string): void;
  readonly disabled?: boolean;
}): ReactNode {
  const [typed, setTyped] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraProblem, setCameraProblem] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mountedRef = useRef(true);
  /* The handler for a decoded payload, kept fresh without re-running the
   * camera effect when a parent re-renders. */
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  useEffect(() => () => { mountedRef.current = false; }, []);

  const startCamera = async (): Promise<void> => {
    setCameraProblem(null);
    try {
      const granted = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      /* A permission granted AFTER this input has gone away must not leave
       * the camera running for the life of the page. */
      if (!mountedRef.current) {
        granted.getTracks().forEach((track) => track.stop());
        return;
      }
      setStream(granted);
    } catch (e) {
      setCameraProblem(describeFailure(e));
    }
  };

  useEffect(() => {
    if (stream === null) return undefined;
    const video = videoRef.current;
    if (video === null) {
      /* The video renders whenever a stream is set, so this cannot happen —
       * but a stream nobody is looking at must still not stay live. */
      stream.getTracks().forEach((track) => track.stop());
      return undefined;
    }
    video.srcObject = stream;
    void Promise.resolve(video.play()).catch(() => { /* autoplay refusals are fine */ });

    const canvas = document.createElement('canvas');
    let live = true;
    let frame: number | null = null;
    const look = (): void => {
      if (!live) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(video, 0, 0);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(image.data, image.width, image.height);
          if (found && found.data.trim() !== '') {
            live = false;
            setStream(null); /* cleanup below stops the tracks */
            onPayloadRef.current(found.data.trim());
            return;
          }
        }
      }
      frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);

    return () => {
      live = false;
      if (frame !== null) cancelAnimationFrame(frame);
      stream.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  const cameraPossible = typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);

  return (
    <div className="scan-input">
      {cameraPossible && stream === null && (
        <p style={{ marginBottom: '0.6rem' }}>
          <button type="button" onClick={() => { void startCamera(); }} disabled={disabled}>
            Scan it with this machine&rsquo;s camera
          </button>
        </p>
      )}
      {stream !== null && (
        <div className="scan-video-wrap">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} className="scan-video" playsInline muted />
          <button type="button" className="quiet" onClick={() => setStream(null)}>
            Stop the camera
          </button>
        </div>
      )}
      {cameraProblem !== null && <div className="error" role="alert">{cameraProblem}</div>}
      <textarea
        rows={2}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder="or type it exactly as the other machine's text form shows it"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      <div style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          className="primary"
          disabled={disabled === true || typed.trim() === ''}
          onClick={() => {
            const text = typed.trim();
            setTyped('');
            onPayload(text);
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
