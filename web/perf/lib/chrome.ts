import { chromium } from 'playwright-core';

/**
 * The Chrome for Testing executable the perf scripts and `scripts/demo/test` drive: `CHROME_PATH`
 * when set, otherwise the build the locked `playwright-core` installs.
 */
export const chromePath = () => process.env.CHROME_PATH ?? chromium.executablePath();

// `scripts/demo/test` runs this file to learn the same default.
if (import.meta.main) console.log(chromePath());
