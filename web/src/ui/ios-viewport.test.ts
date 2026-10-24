import { describe, expect, test } from 'bun:test';
import { iosViewportContent } from './ios-viewport';

const viewport = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';

describe('iOS text-focus viewport', () => {
  test.each(['iPhone', 'iPad', 'iPod'])('limits text-focus zoom for %s Safari and WKWebView', device => {
    expect(iosViewportContent(viewport, { userAgent: `Mozilla/5.0 (${device}; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15`, platform: device, maxTouchPoints: 5 }))
      .toBe(`${viewport}, maximum-scale=1`);
  });
  test('recognizes iPadOS desktop user agents with touch', () => {
    expect(iosViewportContent(viewport, { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }))
      .toBe(`${viewport}, maximum-scale=1`);
  });
  test('keeps Android pinch zoom and desktop viewport unchanged', () => {
    for (const device of [
      { userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 },
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 },
      { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 10 },
    ]) expect(iosViewportContent(viewport, device)).toBe(viewport);
  });
  test('replaces a prior limit without accumulating viewport directives', () => {
    const ios = { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 };
    const limited = iosViewportContent(`${viewport}, maximum-scale=5`, ios);
    expect(limited).toBe(`${viewport}, maximum-scale=1`);
    expect(iosViewportContent(limited, ios)).toBe(limited);
  });
});
