import { createContext, useContext } from 'solid-js';
import type { Accessor } from 'solid-js';

/**
 * Parts of a slip that fill in after it mounts (field rows, recent captures) register here so the popup can hold its
 * first frame until it has its full height, instead of growing while it fades in.
 */
export const SlipLoadingContext = createContext<(loading: Accessor<boolean>) => void>();

/** Registers asynchronous slip content. Outside a settling popup, such as the native capture panel, it does nothing. */
export function trackSlipLoading(loading: Accessor<boolean>) {
  useContext(SlipLoadingContext)?.(loading);
}
