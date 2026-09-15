/**
 * Per-environment colour, as four config values rather than four stylesheets.
 *
 * WHY THIS IS CONFIG AND NOT A THEME FILE. The fleet runs one build of this
 * plugin on every machine; only the config directory differs. A theme file
 * would have to be deployed alongside the code and would drift from it. Four
 * hex strings in config.toml cannot drift, and a new environment is a config
 * edit rather than a release.
 *
 * WHY ONLY FOUR. The page is already written against CSS custom properties, so
 * the whole surface can be re-tinted from a handful of roots. The neutrals --
 * panels, the background grid, hairlines -- are all small steps away from the
 * ground colour, so they are DERIVED from `bg` here instead of being asked for.
 * That keeps the palette impossible to get subtly wrong: you cannot set a
 * ground without the rules that sit on it following along.
 *
 * The derivation uses color-mix(), which the stylesheet already depends on
 * throughout, so this adds no new browser requirement.
 */

/** Three- and six-digit hex only. Anything else is rejected rather than coerced:
 *  these strings are interpolated into a <style> block, and a value that is not
 *  provably a colour has no business being written into the page. */
const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

export interface BrandPalette {
  /** The environment's signature colour: primary buttons, links, and the orb
   *  while the desk is speaking. */
  color?: string;
  /** The second tint, shown while *you* are speaking, so the orb says who has
   *  the floor. Pick something clearly apart from `color` in hue. */
  colorAlt?: string;
  /** The inside of the orb -- a deep, nearly-black version of the brand. */
  deep?: string;
  /** The page ground. Every neutral is derived from this one. */
  bg?: string;
}

/** Default ground, kept in step with `--bg` in styles.css. Used for the mobile
 *  browser chrome when an environment sets no ground of its own. */
export const DEFAULT_BACKGROUND = "#141318";

export function normalizeHexColour(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  const hex = value.trim().toLowerCase();
  if (!hex) return undefined;
  if (!HEX_COLOUR.test(hex)) {
    throw new Error(`${key} must be a hex colour such as #4d94ff, not ${JSON.stringify(value)}`);
  }
  return hex;
}

/** How far each neutral sits from the ground, as a percentage of white mixed in.
 *  Measured from the stock palette (#141318 ground, #1d1c22 grid, #1c1b21 panel,
 *  #25242b mass/line, #34323b strong rule) so a tinted ground reproduces the
 *  same depth relationships rather than a flatter or harsher version of them. */
const NEUTRAL_STEPS: ReadonlyArray<readonly [property: string, groundPercent: number]> = [
  ["--grid", 96],
  ["--panel", 95],
  ["--mass", 92],
  ["--line", 92],
  ["--line-strong", 86],
];

/**
 * The `<style>` body that re-tints the page, or "" when the environment has
 * asked for no colour of its own and the stylesheet's own defaults should stand.
 *
 * Emitted per-property rather than as a whole palette so that setting one key
 * is legal: an environment that only wants its own accent keeps the stock
 * ground, and one that only wants its own ground keeps the stock gold.
 */
export function paletteCss(palette: BrandPalette): string {
  const declarations: string[] = [];

  if (palette.bg) {
    declarations.push(`--bg:${palette.bg}`);
    // Primary buttons put ink ON the accent, so the ink is the ground itself --
    // which is what keeps that text legible no matter which accent is chosen.
    declarations.push(`--spot-ink:${palette.bg}`);
    for (const [property, groundPercent] of NEUTRAL_STEPS) {
      declarations.push(
        `${property}:color-mix(in srgb, ${palette.bg} ${groundPercent}%, #ffffff)`,
      );
    }
  }

  if (palette.color) {
    // --spot is the flat UI accent; --o-gold is the orb's "desk is talking"
    // tint. They are one idea in two places, so one config value drives both.
    declarations.push(`--spot:${palette.color}`);
    declarations.push(`--o-gold:${palette.color}`);
  }
  if (palette.colorAlt) declarations.push(`--o-aqua:${palette.colorAlt}`);
  if (palette.deep) declarations.push(`--o-plum:${palette.deep}`);

  // The orb's aurora is a colour wheel through six stops, two of which the stock
  // palette fixes as indigo and rose. Left alone they dominate the inside of the
  // orb and every environment ends up with the same weather in the middle of an
  // otherwise re-tinted page. They are DERIVED rather than asked for: blends of
  // the colours already given, so the wheel travels only through this
  // environment's own range and the palette stays four keys wide.
  if (palette.colorAlt && palette.deep) {
    declarations.push(
      `--o-indigo:color-mix(in srgb, ${palette.colorAlt} 55%, ${palette.deep})`,
    );
  }
  if (palette.color && palette.colorAlt) {
    declarations.push(`--o-rose:color-mix(in srgb, ${palette.color} 65%, ${palette.colorAlt})`);
  }

  return declarations.length > 0 ? `:root{${declarations.join(";")}}` : "";
}

/** What the phone paints its browser chrome with. Matching the ground is most
 *  of what makes the page read as a different environment at a glance on a
 *  handset, where the chrome is a third of what you can see. */
export function themeColour(palette: BrandPalette): string {
  return palette.bg ?? DEFAULT_BACKGROUND;
}
