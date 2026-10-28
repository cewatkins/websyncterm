/**
 * Loading the built-in font data.
 *
 * The JSON asset lives in the render package and is fetched at runtime so
 * that the terminal can start before the fonts arrive.
 */

import { BuiltinFontSet, parseBuiltinFonts } from '@websyncterm/render';

let cached: Promise<BuiltinFontSet> | null = null;

/** The URL of the built-in font asset. */
export const BUILTIN_FONT_URL = new URL(
	`${import.meta.env.BASE_URL}assets/fonts/builtin-fonts.json`,
	import.meta.url,
).href;

/**
 * Load the built-in font set.
 *
 * The result is cached; a failed load is not cached so that a retry is
 * possible.
 */
export function loadBuiltinFonts(): Promise<BuiltinFontSet> {
	if (cached) return cached;
	const promise = fetch(BUILTIN_FONT_URL)
		.then((response) => {
			if (!response.ok) throw new Error(`Unable to load the fonts (${response.status})`);
			return response.text();
		})
		.then((text) => parseBuiltinFonts(text));
	cached = promise;
	promise.catch(() => {
		cached = null;
	});
	return promise;
}
