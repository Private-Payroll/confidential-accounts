// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import { ScanInput } from './qr.js';

/*
 * THE CAMERA PATH, HEADLESS. The suite was green while the camera
 * never scanned, because every test drove the typed path; this file drives a
 * payload from a stubbed camera frame all the way through the REAL `jsQR`
 * decode to `onPayload`. The frame the "camera" produces is a real QR code,
 * rendered from the payload by the same `qrcode` library the panels use —
 * so the decode below is the genuine article, not a mock agreeing with
 * itself. Only the browser plumbing is stubbed: `getUserMedia`, the video
 * element's `play`/`readyState`/`srcObject`, `requestAnimationFrame`, and
 * the canvas 2D context that hands the frame over.
 */

/** A real QR code for `payload`, as the RGBA pixels a camera frame would carry. */
function qrFrame(payload: string): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = 4;
  const margin = 4 * scale;
  const dim = size * scale + margin * 2;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!qr.modules.get(row, col)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = ((margin + row * scale + dy) * dim + (margin + col * scale + dx)) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

const PAYLOAD = 'AZUia94oJS7zQAlnmtC4mJKjSwIKTzDrnKYGA60UbNcSAAABo';

let frames: FrameRequestCallback[] = [];
const pumpFrame = (): void => {
  const next = frames.shift();
  next?.(0);
};

const stopSpy = vi.fn();
const fakeStream = { getTracks: () => [{ stop: stopSpy }] } as unknown as MediaStream;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
  });
  /* jsdom's media elements do not play; the component only needs them to
   * accept a stream and report a decodable frame. */
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true, value: () => Promise.resolve(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true, set: () => {}, get: () => null,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true, get: () => 4 /* HAVE_ENOUGH_DATA */,
  });
  const frame = qrFrame(PAYLOAD);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
    getImageData: () => frame,
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLMediaElement.prototype, 'play');
  Reflect.deleteProperty(HTMLMediaElement.prototype, 'srcObject');
  Reflect.deleteProperty(HTMLMediaElement.prototype, 'readyState');
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('the camera path actually scans', () => {
  it('drives a QR frame through the real decoder to onPayload, then releases the camera', async () => {
    const onPayload = vi.fn();
    render(<ScanInput label="the code" actionLabel="Use it" onPayload={onPayload} />);

    fireEvent.click(screen.getByText('Scan it with this machine’s camera'));
    /* The video only exists once the stream lands — and the loop must start
     * anyway, which is exactly what the earlier version failed to do. */
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(frames.length).toBeGreaterThan(0);

    pumpFrame();
    await waitFor(() => expect(onPayload).toHaveBeenCalledWith(PAYLOAD));
    expect(onPayload).toHaveBeenCalledTimes(1);
    /* Decoding stops the camera — through the effect's cleanup, the one
     * place the stream is released. */
    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
    expect(document.querySelector('video')).toBeNull();
  });

  it('a frame with no code keeps looking instead of giving up', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(400).fill(255), width: 10, height: 10 }),
    } as unknown as CanvasRenderingContext2D);
    const onPayload = vi.fn();
    render(<ScanInput label="the code" actionLabel="Use it" onPayload={onPayload} />);
    fireEvent.click(screen.getByText('Scan it with this machine’s camera'));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    pumpFrame();
    pumpFrame();
    expect(onPayload).not.toHaveBeenCalled();
    /* Still scheduled — the loop is alive. */
    expect(frames.length).toBeGreaterThan(0);
  });

  it('"Stop the camera" stops the tracks and brings the button back', async () => {
    render(<ScanInput label="the code" actionLabel="Use it" onPayload={() => {}} />);
    fireEvent.click(screen.getByText('Scan it with this machine’s camera'));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    fireEvent.click(screen.getByText('Stop the camera'));
    expect(stopSpy).toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByText('Scan it with this machine’s camera')).toBeTruthy();
  });

  it('a permission granted after the screen has gone does not leave the camera running', async () => {
    let grant: (stream: MediaStream) => void = () => {};
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
      new Promise((resolve) => { grant = resolve; }));
    const view = render(<ScanInput label="the code" actionLabel="Use it" onPayload={() => {}} />);
    fireEvent.click(screen.getByText('Scan it with this machine’s camera'));
    view.unmount();
    grant(fakeStream);
    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
  });
});
