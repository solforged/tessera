import { chromium } from 'playwright-core';
import { chromePath } from './lib/chrome';
import { correctness } from './correctness';

const service = process.env.TESSERA_SERVICE ?? 'http://127.0.0.1:4340';
const url = process.env.OUTLINE_URL ?? service;
const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath(),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const results = await correctness(await context.newPage(), url, service);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
} finally {
  await browser.close();
}
