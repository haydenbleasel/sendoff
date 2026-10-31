import type { Settings } from "../settings";
import { ensureContrast, mix, readableOn } from "./color";

const WHITE = "#ffffff";
const BLACK = "#000000";
const CALLOUT_TINT_LIGHT = 0.93;
const CALLOUT_TINT_DARK = 0.86;

export const light = {
  background: WHITE,
  border: "#e4e4e7",
  heading: "#09090b",
  muted: "#71717a",
  subtle: "#f4f4f5",
  text: "#27272a",
} as const;

export const dark = {
  background: "#0b0b0d",
  border: "#27272a",
  heading: "#fafafa",
  muted: "#a1a1aa",
  subtle: "#18181b",
  text: "#d4d4d8",
} as const;

export const fonts = {
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif',
} as const;

/** Content column width in CSS pixels. */
export const CONTENT_WIDTH = 560;

export interface Theme {
  /** Button background. */
  accent: string;
  /** Label color on top of the accent. */
  onAccent: string;
  /** Link color on the light background (accent nudged to AA if needed). */
  link: string;
  /** Link color on the dark background. */
  linkDark: string;
  callout: string;
  calloutDark: string;
}

export const createTheme = (settings: Pick<Settings, "accent">): Theme => {
  const { accent } = settings;

  return {
    accent,
    callout: mix(accent, light.background, CALLOUT_TINT_LIGHT),
    calloutDark: mix(accent, dark.background, CALLOUT_TINT_DARK),
    link: ensureContrast(accent, light.background, BLACK),
    linkDark: ensureContrast(accent, dark.background, WHITE),
    onAccent: readableOn(accent, WHITE, light.heading),
  };
};

/**
 * Class hooks for clients that honor `prefers-color-scheme` (Apple Mail,
 * iOS Mail, Outlook for Mac). Everything else uses the inline light styles.
 */
export const darkClass = {
  background: "so-bg",
  border: "so-border",
  callout: "so-callout",
  heading: "so-heading",
  link: "so-link",
  muted: "so-muted",
  subtle: "so-subtle",
  text: "so-text",
} as const;

export const darkModeCss = (theme: Theme): string =>
  [
    "@media (prefers-color-scheme: dark) {",
    `.${darkClass.background} { background-color: ${dark.background} !important; }`,
    `.${darkClass.text} { color: ${dark.text} !important; }`,
    `.${darkClass.heading} { color: ${dark.heading} !important; }`,
    `.${darkClass.muted} { color: ${dark.muted} !important; }`,
    `.${darkClass.link} { color: ${theme.linkDark} !important; }`,
    `.${darkClass.subtle} { background-color: ${dark.subtle} !important; }`,
    `.${darkClass.callout} { background-color: ${theme.calloutDark} !important; }`,
    `.${darkClass.border} { border-color: ${dark.border} !important; }`,
    "}",
  ].join("\n");
