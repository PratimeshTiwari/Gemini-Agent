/**
 * The wordmark, from the one font this app ships.
 *
 * Kept apart from `figfont.js` so that file stays a pure renderer with no
 * opinion about where fonts live or which one is ours. The font is parsed
 * once and cached: it is 30KB of text and the banner is drawn at startup.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseFont, renderFig } from './figfont.js';

const here = dirname(fileURLToPath(import.meta.url));
let cached = null;

export function bannerText(text) {
  if (!cached) cached = parseFont(readFileSync(join(here, 'fonts', 'Standard.flf'), 'utf8'));
  return renderFig(text, cached);
}
