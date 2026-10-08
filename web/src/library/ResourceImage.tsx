import { Show, createResource, splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import { DEMO } from '../demo/mode';

// Snapshot resources are immutable. Keep URLs for the tab's lifetime so virtualized
// reader rows can remount without downloading the same image again.
const resourceUrls = new Map<string, Promise<string | undefined>>();

function resourceUrl(snapshotId: string, href: string): Promise<string | undefined> {
  const key = JSON.stringify([snapshotId, href]);
  let url = resourceUrls.get(key);
  if (!url) {
    // A missing or unsupported resource renders nothing, like a broken native image; retry on the next mount.
    url = api.resource(snapshotId, href).then(blob => URL.createObjectURL(blob), () => { resourceUrls.delete(key); return undefined; });
    resourceUrls.set(key, url);
  }
  return url;
}

export type ResourceImageProps = { snapshotId: string; href: string } & Omit<JSX.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcset'>;

export function ResourceImage(props: ResourceImageProps) {
  const [resource, image] = splitProps(props, ['snapshotId', 'href']);
  if (!DEMO) return <img {...image} src={api.resourceUrl(resource.snapshotId, resource.href)} />;
  const [url] = createResource(() => [resource.snapshotId, resource.href] as const, ([snapshotId, href]) => resourceUrl(snapshotId, href));
  return <Show when={url()}>{src => <img {...image} src={src()} />}</Show>;
}
