type ViewportDevice = { userAgent: string; platform: string; maxTouchPoints: number };

/** WebKit honors pinch zoom but skips text-focus zoom with this iOS-only viewport limit. */
export function iosViewportContent(content: string, device: ViewportDevice): string {
  const ios = /iPad|iPhone|iPod/.test(device.userAgent)
    || (device.platform === 'MacIntel' || /Macintosh/.test(device.userAgent)) && device.maxTouchPoints > 1;
  if (!ios) return content;
  return /(?:^|,)\s*maximum-scale\s*=/i.test(content)
    ? content.replace(/((?:^|,)\s*maximum-scale\s*=)\s*[^,]+/i, (_, prefix: string) => `${prefix}1`)
    : `${content}, maximum-scale=1`;
}

export function installIosViewport(): void {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content = iosViewportContent(viewport.content, navigator);
}
