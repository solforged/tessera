import { Show, createRenderEffect, createResource, createSignal, splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { api } from '../api/client';
import { EMBEDDED } from '../demo/mode';

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

// Lazy images can defer their cached load event until after mount; only their first decode needs a fade.
const loadedImages = new Set<string>();

function LoadedImage(props: { src: string; image: Omit<ResourceImageProps, 'snapshotId' | 'href'> }) {
  const [state, setState] = createSignal<'pending' | 'loaded' | 'instant'>('pending');
  let element!: HTMLImageElement;
  const image = <img {...props.image} ref={value => { element = value; if (typeof props.image.ref === 'function') props.image.ref(value); }} data-resource-image={state()} on:load={() => {
    if (state() === 'pending') setState(loadedImages.has(element.src) ? 'instant' : 'loaded');
    loadedImages.add(element.src);
  }} on:error={() => setState('instant')} />;
  createRenderEffect(() => {
    setState('pending');
    element.src = props.src;
    // A decoded cache hit is ready before the first paint and needs no entry fade.
    if (element.complete && element.naturalWidth > 0) { setState('instant'); loadedImages.add(element.src); }
  });
  return image;
}

export function ResourceImage(props: ResourceImageProps) {
  const [resource, image] = splitProps(props, ['snapshotId', 'href']);
  if (!EMBEDDED) return <LoadedImage image={image} src={api.resourceUrl(resource.snapshotId, resource.href)} />;
  const [url] = createResource(() => [resource.snapshotId, resource.href] as const, ([snapshotId, href]) => resourceUrl(snapshotId, href));
  return <Show when={url()}>{src => <LoadedImage image={image} src={src()} />}</Show>;
}
