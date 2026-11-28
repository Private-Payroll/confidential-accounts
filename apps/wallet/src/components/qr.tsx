import jsQR from 'jsqr';
import QRCode from 'qrcode';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { describeFailure } from '../lib/failure-text.js';
import { CopyButton } from './ui.js';

/* Pairing payloads shown as QR codes with a text form, and read back. The two comparison digits must never pass
 * through here: each device computes its own number and a person compares them. */

/** A QR code, with its text underneath, for a payload this device produced. */
export function QrPanel({
  payload,
  caption,
  testId,
  bare = false
}: {
  readonly payload: string;
  readonly caption: string;
  readonly testId: string;
  /** Leaves out the text form and its copy button, for a caller that already shows both. */
  readonly bare?: boolean;
}): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
      .then((drawn) => {
        if (!stale) setSvg(drawn);
      })
      .catch(() => {
        if (!stale) setSvg(null);
      });
    return () => {
      stale = true;
    };
  }, [payload]);
  return (
    <div className="qr-block">
      {svg !== null && (
        <div
          className="qr-panel"
          role="img"
          aria-label={caption}
          /* Safe: the SVG is drawn locally from this device's own payload. */
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <p className="muted small qr-caption">{caption}</p>
      {!bare && (
        <details className="reveal">
          <summary>No camera on the other machine? Show it as text</summary>
          <div className="mono qr-text" data-testid={testId}>
            {payload}
          </div>
          <CopyButton text={payload} label="Copy it" />
        </details>
      )}
    </div>
  );
}

/** Reads a payload the other device shows, by camera where the browser offers one or by typing it. */
export function ScanInput({
  label,
  actionLabel,
  onPayload,
  disabled
}: {
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
  /* The latest handler, so a parent's re-render does not restart the camera. */
  const onPayloadRef = useRef(onPayload);
  useEffect(() => {
    onPayloadRef.current = onPayload;
  });

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const startCamera = async (): Promise<void> => {
    setCameraProblem(null);
    try {
      const granted = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
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

  /* Wired after the <video> mounts, never in the click handler, where the ref is still null after an await.
   * Its cleanup is the one place the stream is stopped: on unmount, on stop and on a decode. */
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
    void Promise.resolve(video.play()).catch(() => {
      /* autoplay refusals are fine */
    });

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

  const cameraPossible = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  return (
    <div className="scan-input">
      {cameraPossible && stream === null && (
        <p style={{ marginBottom: '0.6rem' }}>
          <button
            type="button"
            onClick={() => {
              void startCamera();
            }}
            disabled={disabled}
          >
            Scan it with this machine&rsquo;s camera
          </button>
        </p>
      )}
      {stream !== null && (
        <div className="scan-video-wrap">
          <video ref={videoRef} className="scan-video" playsInline muted />
          <button type="button" className="quiet" onClick={() => setStream(null)}>
            Stop the camera
          </button>
        </div>
      )}
      {cameraProblem !== null && (
        <div className="error" role="alert">
          {cameraProblem}
        </div>
      )}
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
