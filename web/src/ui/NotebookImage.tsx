import { createResource, splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ImageRef } from '../api/types';
import type { ApiClient } from '../api/client';
import { EMBEDDED } from '../demo/mode';

const caches = new WeakMap<ApiClient, Map<string, Promise<string | undefined>>>();
function objectUrl(api: ApiClient, sha: string) {
  let cache = caches.get(api);
  if (!cache) { cache = new Map(); caches.set(api, cache); }
  let url = cache.get(sha);
  if (!url) {
    url = api.image(sha).then(blob => URL.createObjectURL(blob), () => { cache!.delete(sha); return undefined; });
    cache.set(sha, url);
  }
  return url;
}

/** Immutable notebook objects retain their layout even while embedded bytes load. */
export function NotebookImage(props: { image: ImageRef; api: ApiClient } & Omit<JSX.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcset' | 'width' | 'height'>) {
  const [source, attributes] = splitProps(props, ['image', 'api']);
  const [url] = createResource(() => EMBEDDED ? source.image.sha256 : false, sha => objectUrl(source.api, sha));
  return <img {...attributes} src={EMBEDDED ? url() : source.api.imageUrl(source.image.sha256)} width={source.image.width} height={source.image.height} />;
}
