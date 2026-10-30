export type HapticKind = 'light' | 'medium' | 'selection' | 'success' | 'warning';

interface HapticBridge { webkit?: { messageHandlers?: { tesseraHaptic?: { postMessage(kind: HapticKind): void } } } }

/** A tap of feedback in the iOS app, which defines the `tesseraHaptic` message handler (`window.tesseraNative.haptics`).
 * Elsewhere there is no handler and nothing happens: desktops have no haptics. */
export function haptic(kind: HapticKind): void {
  (window as unknown as HapticBridge).webkit?.messageHandlers?.tesseraHaptic?.postMessage(kind);
}
