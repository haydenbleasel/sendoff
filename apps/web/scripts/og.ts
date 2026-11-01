// Renders the homepage's share image (public/og.png) with Takumi, the renderer
// Blume uses for the docs pages' cards. It's the primary lockup on light flaps
// from the brand board: the ink mark tile, then SENDOFF on white split-flap
// tiles. Run it with `bun run og` after changing the design, and commit the PNG.
import { writeFile } from "node:fs/promises";

import { render } from "takumi-js";
import { container, googleFonts, image, text } from "takumi-js/helpers";
import type { Node } from "takumi-js/helpers";

const WIDTH = 1200;
const HEIGHT = 630;
const OUTPUT = new URL("../public/og.png", import.meta.url);

const GROUND = "#E6E3DA";
const INK = "#111111";
const LABEL = "#5A5853";
const SIGNAL = "#FFC20E";

// Tiles keep the board's 1 : 1.37 ratio. The split is a hairline across the
// middle, drawn over the glyph like a real flap's gap.
const TILE_WIDTH = 120;
const TILE_HEIGHT = 164;
const TILE_GAP = 10;
const TILE_RADIUS = 10;
const SPLIT_HEIGHT = 3;
const SPLIT_TOP = (TILE_HEIGHT - SPLIT_HEIGHT) / 2;

const DISPLAY = "Archivo";
const MONO = "JetBrains Mono";

// The arrow outline from public/logo.svg and _home/mark.astro, at weight 7.5.
const ARROW_SIZE = 88;
const ARROW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M21.25 16.25L47.75 16.25L47.75 42.75L40.25 42.75L40.25 29.05L19 50.3L13.7 45L34.95 23.75L21.25 23.75Z" fill="${SIGNAL}"/></svg>`;

const split = (color: string): Node =>
  container({
    style: {
      backgroundColor: color,
      height: SPLIT_HEIGHT,
      left: 0,
      position: "absolute",
      right: 0,
      top: SPLIT_TOP,
    },
  });

const tile = (children: Node[], style: Record<string, string>): Node =>
  container({
    children,
    style: {
      alignItems: "center",
      borderRadius: TILE_RADIUS,
      display: "flex",
      height: TILE_HEIGHT,
      justifyContent: "center",
      position: "relative",
      width: TILE_WIDTH,
      ...style,
    },
  });

const mark = tile(
  [
    image({
      height: ARROW_SIZE,
      src: `data:image/svg+xml;base64,${Buffer.from(ARROW).toString("base64")}`,
      width: ARROW_SIZE,
    }),
    split("#000000"),
  ],
  { backgroundImage: `linear-gradient(#1A1A1A 50%, ${INK} 50%)` }
);

const letter = (character: string): Node =>
  tile(
    [
      text(character, {
        color: INK,
        fontFamily: DISPLAY,
        fontSize: 126,
        fontStretch: "82%",
        fontWeight: 700,
        lineHeight: 1,
      }),
      split("#C9C5BA"),
    ],
    {
      backgroundImage: "linear-gradient(#FFFFFF 50%, #F4F3EE 50%)",
      boxShadow: "inset 0 0 0 1px #D8D4C9, 0 2px 0 #CFCBBF",
    }
  );

// A corner label, inset from the top and one side.
const LABEL_INSET = 48;

const label = (
  content: string,
  side: { left: number } | { right: number }
): Node =>
  text(content, {
    color: LABEL,
    fontFamily: MONO,
    fontSize: 15,
    letterSpacing: "0.08em",
    position: "absolute",
    top: 44,
    ...side,
  });

const card = container({
  children: [
    label("SENDOFF.DEV", { left: LABEL_INSET }),
    label("SELF-HOSTED · CLOUDFLARE + SES", { right: LABEL_INSET }),
    container({
      children: [mark, ...[..."SENDOFF"].map(letter)],
      style: { display: "flex", gap: TILE_GAP },
    }),
  ],
  style: {
    alignItems: "center",
    backgroundColor: GROUND,
    display: "flex",
    height: HEIGHT,
    justifyContent: "center",
    position: "relative",
    width: WIDTH,
  },
});

// Asking for a width other than 100 gets Archivo's variable file with its
// width axis; without it, Google serves a face that can't stretch and the
// letters render at full width.
const fonts = await googleFonts([
  { axes: { wdth: 82 }, name: DISPLAY, weight: 700 },
  { name: MONO, weight: 400 },
]);

const png = await render(card, { fonts, height: HEIGHT, width: WIDTH });

await writeFile(OUTPUT, png);
