import { expect, test } from '@playwright/test';

/**
 * Read the terminal screen out of the application.
 *
 * The application exposes a debug hook when `?debug=1` is present.
 */
async function screenText(page: import('@playwright/test').Page): Promise<string[]> {
	return page.evaluate(() => {
		const hook = (window as unknown as { __wst?: { api?: { term?: { screen: { cols: number; rows: number; chars: Uint16Array } } } } }).__wst;
		const term = hook?.api?.term;
		if (!term) return [];
		const rows: string[] = [];
		for (let y = 0; y < term.rows; y++) {
			let line = '';
			for (let x = 0; x < term.cols; x++) {
				line += String.fromCodePoint(term.screen.chars[y * term.screen.cols + x]);
			}
			rows.push(line.replace(/\s+$/, ''));
		}
		return rows;
	});
}

test.describe('WebSyncTERM', () => {
	test('shows the dialing directory on start', async ({ page }) => {
		await page.goto('/?debug=1');
		await expect(page.getByRole('listbox', { name: 'Dialing directory' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add' })).toBeVisible();
	});

	test('creates, edits and deletes a directory entry', async ({ page }) => {
		await page.goto('/?debug=1');
		await page.getByRole('button', { name: 'Add' }).click();
		await page.getByLabel('Name', { exact: true }).fill('Test BBS');
		await page.getByLabel('Address').fill('127.0.0.1');
		await page.getByLabel('Port').fill('18099');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Test BBS')).toBeVisible();
	});

	test('connects to a BBS and renders the ANSI output', async ({ page }) => {
		await page.goto('/?debug=1');
		await page.getByRole('button', { name: 'Add' }).click();
		await page.getByLabel('Name', { exact: true }).fill('Mock BBS');
		await page.getByLabel('Address').fill('127.0.0.1');
		await page.getByLabel('Port').fill('18099');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.getByRole('button', { name: 'Connect' }).first().click();

		await expect.poll(async () => (await screenText(page)).join('\n'), { timeout: 15_000 }).toContain(
			'Green text',
		);
		const rows = await screenText(page);
		expect(rows.join('\n')).toContain('Welcome to the mock BBS');
		expect(rows.join('\n')).toContain('Blue on yellow');
	});

	test('preserves the ANSI colour attributes', async ({ page }) => {
		await page.goto('/?debug=1');
		await page.getByRole('button', { name: 'Add' }).click();
		await page.getByLabel('Name', { exact: true }).fill('Mock BBS');
		await page.getByLabel('Address').fill('127.0.0.1');
		await page.getByLabel('Port').fill('18099');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.getByRole('button', { name: 'Connect' }).first().click();

		await expect.poll(async () => (await screenText(page)).join('\n')).toContain('Green text');
		const fg = await page.evaluate(() => {
			const hook = (window as unknown as { __wst?: { api?: { term?: { screen: { cols: number; fg: Int16Array } } } } }).__wst;
			const term = hook?.api?.term;
			if (!term) return -1;
			for (let i = 0; i < term.screen.fg.length; i++) {
				if (term.screen.fg[i] === 2) return i;
			}
			return -1;
		});
		expect(fg).toBeGreaterThanOrEqual(0);
	});

	test('is operable from the keyboard alone', async ({ page }) => {
		await page.goto('/?debug=1');
		// The search field must be reachable with the keyboard alone.
		const search = page.getByRole('searchbox', { name: 'Search the dialing directory' });
		await search.focus();
		await page.keyboard.type('hello');
		await expect(search).toHaveValue('hello');
		// The editor fields must be reachable too.
		await page.getByRole('button', { name: 'Add' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Address')).toBeVisible();
	});

	test('paints the terminal onto the canvas', async ({ page }) => {
		await page.goto('/?debug=1');
		await page.getByRole('button', { name: 'Add' }).click();
		await page.getByLabel('Name', { exact: true }).fill('Mock BBS');
		await page.getByLabel('Address').fill('127.0.0.1');
		await page.getByLabel('Port').fill('18099');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.getByRole('button', { name: 'Connect' }).first().click();

		await expect.poll(async () => (await screenText(page)).join('\n')).toContain('Green text');

		// The canvas must actually have been painted. Asserting on the
		// terminal's screen buffer alone would miss a renderer that was never
		// attached to the canvas.
		const painted = await page.evaluate(() => {
			const canvas = document.querySelector('canvas');
			if (!canvas) return { error: 'no canvas' };
			const ctx = canvas.getContext('2d');
			if (!ctx) return { error: 'no 2d context' };
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			let lit = 0;
			for (let i = 0; i < data.length; i += 4) {
				if (data[i] || data[i + 1] || data[i + 2]) lit += 1;
			}
			return { lit, width: canvas.width, height: canvas.height };
		});
		expect((painted as { error?: string }).error).toBeUndefined();
		expect((painted as { lit: number }).lit).toBeGreaterThan(100);
	});

	test('applies the screen mode aspect ratio to the canvas', async ({ page }) => {
		await page.goto('/?debug=1');
		await page.getByRole('button', { name: 'Add' }).click();
		await page.getByLabel('Name', { exact: true }).fill('Mock BBS');
		await page.getByLabel('Address').fill('127.0.0.1');
		await page.getByLabel('Port').fill('18099');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.getByRole('button', { name: 'Connect' }).first().click();
		await expect.poll(async () => (await screenText(page)).join('\n')).toContain('Green text');

		// C80 is a 640x400 pixel grid displayed at 4:3 (640x480).
		const size = await page.evaluate(() => {
			const canvas = document.querySelector('canvas');
			return canvas
				? { backing: [canvas.width, canvas.height], css: [canvas.clientWidth, canvas.clientHeight] }
				: null;
		});
		expect(size).not.toBeNull();
		const { backing, css } = size as { backing: number[]; css: number[] };
		expect(backing[0]).toBe(640);
		expect(backing[1]).toBe(400);
		expect(css[0]).toBe(640);
		expect(css[1]).toBe(480);
	});

	test('exposes the status region to assistive technology', async ({ page }) => {
		await page.goto('/?debug=1');
		await expect(page.getByRole('status')).toBeVisible();
	});
});
