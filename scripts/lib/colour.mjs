// Colour arithmetic for the companion app's theme — WCAG 2.0 contrast, and the
// walks that keep a client's palette readable. Pure functions, so they can be
// tested without rendering a page. Used by scripts/render-companion-app.mjs.

export const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function expandHex(h) {
  const v = h.slice(1);
  return v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
}

export function relativeLuminance(hex) {
  const v = expandHex(hex);
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a, b) {
  const l1 = relativeLuminance(a), l2 = relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of white / near-black reads better on `bg`. */
export function readableOn(bg) {
  return contrast(bg, "#ffffff") >= contrast(bg, "#12151d") ? "#ffffff" : "#12151d";
}

export function hexToRgb(hex) {
  const v = expandHex(hex);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}
export const toHexStr = (rgb) => `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
export const mix = (a, b, t) => toHexStr(hexToRgb(a).map((c, i) => c + (hexToRgb(b)[i] - c) * t));

/**
 * A brand colour used as TEXT has to clear 4.5:1 against the surface behind it.
 * A client's palette is chosen for their website, not for this page's dark mode:
 * most brand colours are dark, and pasting one straight into both themes makes
 * the wordmark, headings and links invisible on a dark background. So the text
 * role is derived per theme — the brand is walked toward white or black only as
 * far as it must go, which keeps the hue recognisably theirs.
 */
export function brandTextColor(brand, surface) {
  const target = readableOn(surface); // walk toward whichever end has headroom
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = mix(brand, target, t);
    if (contrast(c, surface) >= 4.5) return c;
  }
  return target;
}

/**
 * A colour used as a BACKGROUND behind text must clear 4.5:1 against some
 * foreground. Mid-greys are a dead zone: white and black both land near 4.4:1
 * there, so no choice of text colour rescues them. A brand that falls in that
 * band is walked out of it rather than trusted — otherwise the selected
 * navigation item fails for every client whose brand is a mid-tone.
 */
export function ensureTextSurface(bg, toward) {
  if (contrast(bg, readableOn(bg)) >= 4.5) return bg;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(bg, toward, t);
    if (contrast(c, readableOn(c)) >= 4.5) return c;
  }
  return toward;
}

/**
 * The surface and text colour for anything painted IN the brand colour — the
 * selected nav item, capability ID badges, journey stage headers.
 *
 * With no `preferredFg`, the text is whichever of white / near-black reads
 * better. That is right by the numbers and wrong for a brand like BAE's red,
 * which is always shown with white type: on #FF0033 near-black wins 5.0:1 to
 * 4.0:1. A theme's `onBrand` states the house convention; the surface is then
 * walked away from the text colour only as far as AA requires, so the brand
 * keeps its type colour AND the page stays accessible.
 */
export function selectedSurface(bg, preferredFg) {
  if (typeof preferredFg !== "string" || !HEX.test(preferredFg.trim())) {
    const surface = ensureTextSurface(bg, "#12151d");
    return { bg: surface, fg: readableOn(surface) };
  }
  const fg = preferredFg.trim();
  if (contrast(bg, fg) >= 4.5) return { bg, fg };
  const toward = relativeLuminance(fg) > 0.5 ? "#12151d" : "#ffffff";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(bg, toward, t);
    if (contrast(c, fg) >= 4.5) return { bg: c, fg };
  }
  return { bg: toward, fg };
}
