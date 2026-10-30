import { Format, checkPermissions, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner';
import { MOBILE } from '../demo/mode';

export interface PairingTarget { url: string; code: string }

/** `tessera://pair?hub=<url>&code=<code>`, the content of the Mac's pairing QR code. */
export function parsePairingLink(text: string): PairingTarget | null {
  let link: URL;
  try { link = new URL(text.trim()); } catch { return null; }
  if (link.protocol !== 'tessera:' || link.host !== 'pair') return null;
  const url = link.searchParams.get('hub');
  const code = link.searchParams.get('code');
  return url && code ? { url, code } : null;
}

/** What a person types for the Mac's address: a full URL, or a host with or without a port. HTTPS unless they say. */
export function normalizeHubUrl(text: string): string {
  const trimmed = text.trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** What a Mac is called from its address, as Tailscale names machines: `https://hyperion.tail1a2b.ts.net:4319` is Hyperion. */
export function macName(url: string): string {
  let host: string;
  try { host = new URL(url).hostname; } catch { return 'Your Mac'; }
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return host;
  const name = host.split('.')[0]!;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/** Scan the Mac's QR code with the camera. Null when the person backs out or the code is not a pairing link. */
export async function scanPairing(): Promise<PairingTarget | null> {
  let permission = await checkPermissions();
  if (permission !== 'granted') permission = await requestPermissions();
  if (permission !== 'granted') throw new Error('Tessera needs the camera to scan the code. You can type the code instead.');
  const result = await scan({ windowed: false, formats: [Format.QRCode] });
  return parsePairingLink(result.content);
}

/** The name the Mac lists this device under: on Android, the phone's own name from MainActivity's bridge
 * (Settings › About phone); iOS gives apps only the model. */
export function deviceName(): string {
  if (!MOBILE) return 'This computer';
  return (window as Window & { TesseraDevice?: { name(): string } }).TesseraDevice?.name()
    || /iPhone|iPad/.exec(navigator.userAgent)?.[0] || 'Android phone';
}
