import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/?debug=1');
await page.getByRole('button', { name: 'Add' }).click();
await page.getByLabel('Name', { exact: true }).fill('Mock BBS');
await page.getByLabel('Address').fill('127.0.0.1');
await page.getByLabel('Port').fill('18099');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByRole('button', { name: 'Connect' }).first().click();
await page.waitForTimeout(2500);

const probe = async (label) => {
  const r = await page.evaluate(() => {
    const t = window.__wst?.api?.term;
    const c = document.querySelector('canvas');
    const ctx = c.getContext('2d');
    const scale = c.width / (t.cols * 8);
    const i = 3 * t.cols;                 // the "Bright blue background" row
    const d = ctx.getImageData(Math.round(2 * scale), Math.round(3 * 16 * scale + 8 * scale), 1, 1).data;
    return { ice: t.iceColors, cellBg: t.screen.bg[i], blinkBit: t.screen.flags[i] & 2,
             pixel: [d[0], d[1], d[2]] };
  });
  console.log(label, JSON.stringify(r));
};
await probe('iCE (default):');
await page.selectOption('#ice-select', 'blink');
await page.waitForTimeout(1500);
await probe('blink         :');
await page.selectOption('#ice-select', 'ice');
await page.waitForTimeout(1500);
await probe('iCE again     :');
await browser.close();
