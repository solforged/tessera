import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { correctness } from './correctness';

const service = process.env.TESSERA_SERVICE ?? 'http://127.0.0.1:4340';
const url = process.env.OUTLINE_URL ?? service;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? join(process.env.HOME!, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const results = await correctness(await context.newPage(), url, service);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
} finally { await browser.close(); }
