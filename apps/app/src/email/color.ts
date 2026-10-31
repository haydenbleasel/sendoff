// Small color helpers for deriving an email palette from a single accent.
// Accents are validated as #rrggbb before they reach this module.

type Rgb = readonly [number, number, number];

const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
const SRGB_THRESHOLD = 0.04045;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const LUMINANCE_WEIGHTS: Rgb = [0.2126, 0.7152, 0.0722];
const CONTRAST_OFFSET = 0.05;
const MIX_STEP = 0.05;

/** WCAG AA contrast for normal-size text. */
export const AA_CONTRAST = 4.5;

const channelAt = (hex: string, index: number): number =>
  Number.parseInt(hex.slice(index, index + 2), HEX_RADIX);

const parseHex = (hex: string): Rgb => [
  channelAt(hex, 1),
  channelAt(hex, 3),
  channelAt(hex, 5),
];

const toHex = (rgb: Rgb): string =>
  `#${rgb.map((channel) => Math.round(channel).toString(HEX_RADIX).padStart(2, "0")).join("")}`;

const linearize = (channel: number): number => {
  const srgb = channel / CHANNEL_MAX;

  return srgb <= SRGB_THRESHOLD
    ? srgb / SRGB_LINEAR_DIVISOR
    : ((srgb + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA;
};

const luminance = (hex: string): number => {
  const [r, g, b] = parseHex(hex);
  const [wr, wg, wb] = LUMINANCE_WEIGHTS;

  return wr * linearize(r) + wg * linearize(g) + wb * linearize(b);
};

export const contrast = (a: string, b: string): number => {
  const first = luminance(a);
  const second = luminance(b);

  return (
    (Math.max(first, second) + CONTRAST_OFFSET) /
    (Math.min(first, second) + CONTRAST_OFFSET)
  );
};

/** Mix `color` toward `target` by `amount` (0 = color, 1 = target). */
export const mix = (color: string, target: string, amount: number): string => {
  const from = parseHex(color);
  const to = parseHex(target);

  return toHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
};

/** Whichever of `light` or `dark` reads better on `background`. */
export const readableOn = (
  background: string,
  light: string,
  dark: string
): string =>
  contrast(background, light) >= contrast(background, dark) ? light : dark;

/**
 * Move `color` toward `target` until it reaches AA contrast on `background`,
 * so a dark accent stays legible as link text on a dark background.
 */
export const ensureContrast = (
  color: string,
  background: string,
  target: string
): string => {
  let amount = 0;
  let result = color;

  while (contrast(result, background) < AA_CONTRAST && amount < 1) {
    amount = Math.min(1, amount + MIX_STEP);
    result = mix(color, target, amount);
  }

  return result;
};
