/**
 * How wide a line of the app's own text is, in CSS pixels — which, inside the timeline's `<svg>`,
 * are its own viewBox units (its labels set `font-size` in px). Used to size the timeline's label
 * gutter from the labels it will actually draw (`#591`), not from a guess that a long or negative
 * amount in another locale or currency can outgrow.
 *
 * Measures with an `OffscreenCanvas` in the font the page itself uses (`--font` on `<body>`),
 * plus a small margin for a webfont not loaded yet. Where there is no canvas to measure with
 * (jsdom in the tests, an old browser), it falls back to a deliberately generous per-character
 * estimate, so a label is never under-sized.
 */

/** Per character, as a fraction of the font size: wider than Figtree's own digits (about 0.5) and its widest currency symbols. */
const FALLBACK_EM_PER_CHAR = 0.62;
/** Headroom over a measured width, for a fallback font standing in while the webfont loads. */
const MEASURED_MARGIN = 1.08;

let context: OffscreenCanvasRenderingContext2D | null | undefined;

function measuringContext(): OffscreenCanvasRenderingContext2D | null {
  if (context === undefined) {
    context = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  }
  return context;
}

export function estimateTextWidth(text: string, fontSizePx: number): number {
  return [...text].length * fontSizePx * FALLBACK_EM_PER_CHAR;
}

export function textWidth(text: string, fontSizePx: number, fontWeight = 400): number {
  const ctx = measuringContext();
  if (ctx === null) {
    return estimateTextWidth(text, fontSizePx);
  }
  const family = typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily || "sans-serif";
  ctx.font = `${fontWeight} ${fontSizePx}px ${family}`;
  return ctx.measureText(text).width * MEASURED_MARGIN;
}

/** The `font-size` of the timeline's own value labels (`.t-grid-l` in `Timeline.css`). */
const VALUE_LABEL_FONT_PX = 10;

/** `computeTimeline`'s own `valueLabelWidth`, from the very `money` formatter the labels are drawn with (`#591`). */
export function timelineValueLabelWidth(money: (cents: number) => string): (amountCents: number) => number {
  return (amountCents) => textWidth(money(amountCents), VALUE_LABEL_FONT_PX);
}
