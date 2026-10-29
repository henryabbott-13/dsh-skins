/**
 * Shared skin derivation + emission.
 *
 * One background in, one complete skin out. Nothing is templated: the palette,
 * lightness ladder, radius scale, blur budget, shadow language and motion
 * timings are all computed from the measurements recorded in
 * output/plans/analysis_images.json and analysis_videos.json — the artwork's
 * own primary/secondary/accent hues, its mean luminance, saturation and
 * temperature, its material and lighting description, and how busy it is.
 *
 * The only thing that is shared across skins is the *code* that maps a
 * measurement onto a design decision, which is the point: the specification
 * stays identical, the outcome does not.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── colour maths ────────────────────────────────────────────────────────────
export const parseHex = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
export const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

export function rgbToHsl(hex) {
  const [r0, g0, b0] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r0) h = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) / 6;
  else if (max === g0) h = ((b0 - r0) / d + 2) / 6;
  else h = ((r0 - g0) / d + 4) / 6;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }) {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [conv(hue + 1 / 3) * 255, conv(hue) * 255, conv(hue - 1 / 3) * 255];
}

export const hsl = (h, s, l) => toHex(hslToRgb({ h, s, l }));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const chan = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = (hex) => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
};
export const contrastRatio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
};
export const mix = (from, to, weight) => {
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex(a.map((v, i) => v * (1 - weight) + b[i] * weight));
};
export const rgba = (hex, alpha) => {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
/** Nudge lightness until the pair clears `target`, searching away from the base. */
export function ensureContrast(color, against, target, { lighten = true } = {}) {
  let best = color;
  const { h, s, l } = rgbToHsl(color);
  for (let step = 0; step <= 40; step += 1) {
    const candidate = hsl(h, s, clamp(lighten ? l + step * 0.02 : l - step * 0.02, 0.02, 0.98));
    best = candidate;
    if (contrastRatio(candidate, against) >= target) return candidate;
  }
  return best;
}

/**
 * Normalise the many shapes `backgroundSuitability` arrived in.
 *
 * The image pass produced `{ "dark UI": "good — reason" }`, `{ dark: {rating,
 * reason} }` and flat verdicts; the video pass produced `{ "dark UI": "good" }`.
 * All of them have to mean the same thing here, so they collapse to
 * `{ dark, light }` with a lower-case verdict and the reason kept.
 */
export function normalizeSuitability(value) {
  if (value === null || value === undefined) return { dark: null, light: null };
  const verdictOf = (entry) => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry === 'string') {
      const verdict = /^(good|workable|poor)/iu.exec(entry);
      return { verdict: (verdict?.[1] ?? entry).toLowerCase(), reason: entry.replace(/^[a-z]+\s*[—:-]?\s*/iu, '') };
    }
    if (typeof entry === 'object') {
      const verdict = String(entry.rating ?? entry.verdict ?? '');
      return { verdict: verdict.toLowerCase(), reason: String(entry.reason ?? '') };
    }
    return { verdict: String(entry).toLowerCase(), reason: '' };
  };
  if (typeof value !== 'object') return { dark: null, light: null };
  const pick = (...keys) => verdictOf(keys.map((key) => value[key]).find((entry) => entry !== undefined));
  return { dark: pick('dark UI', 'dark', 'darkUI'), light: pick('light UI', 'light', 'lightUI') };
}

// ── design derivation ───────────────────────────────────────────────────────
/**
 * Turn one measured analysis record into the full design specification.
 * @param record - the analysis record (image) or a synthesised equivalent (video).
 * @param scan - the matching scanned file record.
 */
export function deriveDesign(record, scan) {
  const primary = record.primaryColor ?? '#7a7a7a';
  const accentMeasured = record.accentColor ?? primary;
  const neutrals = record.neutrals ?? ['#222222', '#888888', '#dddddd'];
  const secondaries = record.secondaryColors ?? [];
  const proposal = record.paletteProposal ?? null;
  const isVideo = scan.kind === 'video';

  const luma = typeof record.luminance === 'number' ? record.luminance : 0.4;
  const saturation = record.saturation ?? 'muted';
  const temperature = record.temperature ?? 'neutral';
  const busyness = record.busyness ?? 'moderate';
  const material = record.material ?? '';
  const lighting = record.lighting ?? '';

  // ── 1. which polarity does the artwork ask for? ──────────────────────────
  // Mean luminance decides, exactly as Project_2's derivation does; the
  // analysis' own suitability verdicts can override it. A "large" frame drift
  // is a warning rather than a downgrade: it means the loop changes brightness,
  // so whichever polarity is chosen must hold at the darkest sampled frame.
  const suitability = normalizeSuitability(record.backgroundSuitability);
  const darkVerdict = suitability.dark?.verdict ?? '';
  const lightVerdict = suitability.light?.verdict ?? '';
  let anchorScheme = luma >= 0.5 ? 'light' : 'dark';
  if (lightVerdict === 'good' && darkVerdict !== 'good') anchorScheme = 'light';
  else if (darkVerdict === 'good' && lightVerdict !== 'good') anchorScheme = 'dark';
  else if (lightVerdict === 'poor' && darkVerdict !== 'poor') anchorScheme = 'dark';
  else if (darkVerdict === 'poor' && lightVerdict !== 'poor') anchorScheme = 'light';

  // ── 2. hues ──────────────────────────────────────────────────────────────
  // The interface hue is taken from the artwork; the measured accent is only
  // reused when the artwork actually reads as a field of that colour. A small
  // accent blob (low field share) makes a poor interactive colour, which is
  // exactly why the sample skin swapped it for the artwork's cool family.
  const primaryHsl = rgbToHsl(primary);
  const accentHsl = rgbToHsl(accentMeasured);
  const coolSecondary = secondaries.find((c) => {
    const { h } = rgbToHsl(c);
    return h * 360 >= 150 && h * 360 <= 280;
  });
  const warmSecondary = secondaries.find((c) => {
    const { h } = rgbToHsl(c);
    return h * 360 <= 60 || h * 360 >= 330;
  });
  /**
   * Prefer the analyst's own accent when it is recognisably the same hue as the
   * measured accent. They routinely lift the measured value a little to clear a
   * contrast threshold, so an exact string match is the wrong test — comparing
   * hue (with saturation/lightness ignored) is the right one. The accent is
   * only substituted when the artwork's most saturated colour is a different
   * hue from the measured accent blob, which is the case the substitution was
   * introduced for.
   */
  const hueDistance = (a, b) => {
    const d = Math.abs(a - b);
    return Math.min(d, 1 - d);
  };
  const proposalMatchesAccent = proposal !== null
    && typeof proposal.accent === 'string'
    && hueDistance(rgbToHsl(proposal.accent).h, accentHsl.h) <= 0.04;
  const useMeasuredAccent = proposalMatchesAccent || proposal === null;
  const accentSource = useMeasuredAccent ? accentMeasured : coolSecondary ?? accentMeasured;
  const accentHue = rgbToHsl(accentSource).h;
  const interfaceHue = accentHue;
  // Companion is deliberately taken from the opposite temperature family.
  const companionSource = coolSecondary !== undefined && accentSource !== coolSecondary
    ? warmSecondary ?? primary
    : coolSecondary ?? (temperature === 'warm' ? primary : secondaries[0] ?? primary);
  const companionHue = rgbToHsl(companionSource).h;

  // ── 3. saturation budget from the artwork ───────────────────────────────
  const satBase = saturation === 'vivid' ? 0.52 : saturation === 'balanced' ? 0.42 : 0.3;

  // ── 4. surfaces ─────────────────────────────────────────────────────────
  // Surface anchors. Light sits a little above the artwork's own light neutral
  // and dark a little below its dark one, so there is headroom for the text
  // ladder to reach its contrast floors on every background.
  const castHue = primaryHsl.h;
  const castSat = temperature === 'neutral' ? 0.06 : 0.1;
  const lightBase = hsl(castHue, castSat, 0.92);
  const darkBase = hsl(castHue, castSat + 0.02, 0.07);
  const anchorBase = anchorScheme === 'dark' ? darkBase : lightBase;

  // ── 5. accents, de-collided from the surface and legibility-corrected ────
  //
  // The accent has three jobs at once, and they pin its lightness:
  //   * at least 3:1 against the panel it sits on (graphics, borders, focus);
  //   * its own button label at 4.5:1;
  //   * and it must carry *link text* at 4.5:1 — because `--dsw-alias-link` is
  //     bound to the same value, and the user can switch color scheme at will.
  // The last requirement is what the first cut missed: a mid-lightness accent
  // reads on a dark panel but fails as link text on a light one, so the whole
  // skin became unusable the moment the preference flipped. The search below
  // therefore insists on DARK ink on the accent, which is available for any
  // accent light enough to clear 4.5:1, and that same lightness also clears
  // 4.5:1 against both the light and the dark panel. One accent, correct on
  // both panels, with no dependency on the active preference.
  const INK_ON_ACCENT = '#12161c';
  const accentFor = (surface, hue, minLightness) => {
    const sat = clamp(satBase, 0.3, 0.62);
    for (let step = 0; step <= 40; step += 1) {
      const lightness = clamp(minLightness + step * 0.02, 0.05, 0.95);
      const candidate = hsl(hue, sat, lightness);
      if (contrastRatio(candidate, surface) < 3) continue;
      if (contrastRatio(INK_ON_ACCENT, candidate) < 4.5) continue;
      return { accent: candidate, ink: INK_ON_ACCENT };
    }
    // No lightness satisfied everything: keep the most legible candidate and let
    // the build's self-check report it rather than shipping something unreadable.
    const fallback = ensureContrast(hsl(hue, sat, minLightness), surface, 3, { lighten: true });
    return { accent: fallback, ink: contrastRatio('#ffffff', fallback) > contrastRatio(INK_ON_ACCENT, fallback) ? '#ffffff' : INK_ON_ACCENT };
  };
  /**
   * One accent for both schemes.
   *
   * The candidate is searched from the *light* panel upwards, because the light
   * panel is the harder surface: a value that clears 3:1 over a near-white panel
   * is also clear of a near-black one only if it is dark enough, and a value
   * found from the dark panel can land lighter than the light panel itself —
   * which is exactly how two teal accents ended up at 1.15:1 on light. So the
   * search starts dark and walks up, and both panels are asserted.
   */
  const accentForBothPanels = (hue) => {
    const sat = clamp(satBase, 0.3, 0.62);
    for (let step = 0; step <= 40; step += 1) {
      const lightness = clamp(0.3 + step * 0.02, 0.05, 0.9);
      const candidate = hsl(hue, sat, lightness);
      if (contrastRatio(candidate, lightBase) < 3) continue;
      if (contrastRatio(candidate, darkBase) < 3) continue;
      if (contrastRatio(INK_ON_ACCENT, candidate) < 4.5) continue;
      return { accent: candidate, ink: INK_ON_ACCENT };
    }
    const fallback = ensureContrast(hsl(hue, sat, 0.42), lightBase, 3, { lighten: false });
    return { accent: fallback, ink: contrastRatio('#ffffff', fallback) > contrastRatio(INK_ON_ACCENT, fallback) ? '#ffffff' : INK_ON_ACCENT };
  };
  const sharedAccent = accentForBothPanels(interfaceHue);
  const lightAccent = sharedAccent.accent;
  const darkAccent = sharedAccent.accent;
  const lightInkOnAccent = sharedAccent.ink;
  const darkInkOnAccent = sharedAccent.ink;

  const ladder = (base, scheme) => {
    const { h, s, l } = rgbToHsl(base);
    const up = scheme === 'light' ? 1 : -1;
    return {
      layer1: hsl(h, s, clamp(l + up * 0.035, 0.02, 0.98)),
      layer2: hsl(h, s, clamp(l + up * 0.07, 0.02, 0.98)),
      layer3: hsl(h, s, clamp(l + up * 0.11, 0.02, 0.98)),
      overlay: hsl(h, s, clamp(l + up * 0.05, 0.02, 0.98)),
    };
  };
  const lightLadder = ladder(lightBase, 'light');
  const darkLadder = ladder(darkBase, 'dark');

  // Text ladder: derive ink from the artwork's own neutrals, then guarantee
  // 4.5:1 against the anchor surface (and 7:1 where the artwork is calm enough
  // to afford it — busy artwork needs a stronger ink to stay readable).
  //
  // The secondary/tertiary ink must be *pushed away* from the surface, not
  // mixed towards it: mixing towards the base is what produces a "secondary"
  // colour that is nearly the same lightness as the surface it sits on. On a
  // light scheme that means going darker, on a dark scheme lighter.
  const inkFloor = busyness === 'busy' ? 7 : 4.6;
  const lightInk = ensureContrast(hsl(castHue, 0.16, 0.12), lightBase, inkFloor, { lighten: false });
  const darkInk = ensureContrast(hsl(castHue, 0.08, 0.94), darkBase, inkFloor, { lighten: true });
  const lightInk2 = ensureContrast(hsl(castHue, 0.13, rgbToHsl(lightInk).l + 0.16), lightBase, 4.5, { lighten: false });
  const darkInk2 = ensureContrast(hsl(castHue, 0.07, rgbToHsl(darkInk).l - 0.16), darkBase, 4.5, { lighten: true });
  const lightInk3 = ensureContrast(hsl(castHue, 0.1, rgbToHsl(lightInk2).l + 0.16), lightBase, 3, { lighten: false });
  const darkInk3 = ensureContrast(hsl(castHue, 0.06, rgbToHsl(darkInk2).l - 0.16), darkBase, 3, { lighten: true });

  // ── 6. how much of the artwork to let through ───────────────────────────
  // Busy or low-contrast artwork needs a heavier veil; calm artwork can be
  // shown more openly. This is the single most visible consequence of the
  // measured `busyness` and `contrast` fields.
  const veilBase = busyness === 'busy' ? 0.44 : busyness === 'moderate' ? 0.36 : 0.28;
  const contrastPenalty = record.contrast === 'low' ? 0.08 : 0;
  const lightVeil = clamp(veilBase + contrastPenalty + (luma > 0.6 ? 0.04 : 0), 0.2, 0.72);
  const darkVeil = clamp(veilBase + contrastPenalty + (luma < 0.3 ? 0.04 : 0), 0.24, 0.76);

  // ── 7. geometry & material from the artwork's own texture ───────────────
  const stone = /stone|sand|rock|plaster|sandstone|石|砂岩|砌/u.test(material);
  const metal = /metal|bronze|steel|copper|iron|polish|金属|铜|钢|抛光/u.test(material);
  const fabric = /silk|chiffon|drape|velvet|linen|cloth|纱|绸|缎|绒|织/u.test(material);
  const glassy = /glass|mirror|lacquer|gloss|wet|polished|镜|玻璃|漆|湿/u.test(material);
  const radius = metal ? { none: '0px', xs: '1px', sm: '1px', md: '2px', lg: '2px', pill: '2px' }
    : stone ? { none: '0px', xs: '1px', sm: '2px', md: '3px', lg: '4px', pill: '3px' }
      : fabric ? { none: '0px', xs: '2px', sm: '4px', md: '6px', lg: '8px', pill: '9999px' }
        : glassy ? { none: '0px', xs: '2px', sm: '3px', md: '5px', lg: '7px', pill: '9999px' }
          : { none: '0px', xs: '1px', sm: '3px', md: '4px', lg: '6px', pill: '9999px' };

  // Hard directional light -> zero-blur offset shadows. Soft diffuse light ->
  // blurred ambient shadows. This is read straight out of the lighting text.
  const hardLight = /hard|direct|strong|harsh|sun|sunlight|beam|spot|硬|强|直射|阳光|聚光|光束/u.test(lighting);
  const softLight = /diffus|soft|haze|ambient|overcast|mist|漫射|柔|雾|阴天|弥散/u.test(lighting);
  const shadowStyle = hardLight && !softLight ? 'hard' : softLight && !hardLight ? 'soft' : 'mixed';
  const shadowOffset = shadowStyle === 'hard' ? '2px' : shadowStyle === 'soft' ? '1px' : '2px';

  const blurPanel = busyness === 'busy' ? '4px' : busyness === 'moderate' ? '3px' : '2px';
  const blurOverlay = busyness === 'busy' ? '14px' : busyness === 'moderate' ? '12px' : '10px';

  // ── 8. motion from the artwork's energy ────────────────────────────────
  // A quiet, near-monochrome scene gets slow, reverent timings; a vivid, busy
  // scene gets quick, decisive ones.
  const energy = (saturation === 'vivid' ? 2 : saturation === 'balanced' ? 1 : 0) + (busyness === 'busy' ? 1 : 0);
  const motionProfiles = {
    0: { fast: '150ms', base: '240ms', slow: '420ms', ambience: '9000ms', lang: '缓慢庄重，像一次呼吸；无回弹，只有轻微的收束。' },
    1: { fast: '130ms', base: '200ms', slow: '360ms', ambience: '7000ms', lang: '克制而平稳，过渡有明确落点但不抢注意力。' },
    2: { fast: '110ms', base: '160ms', slow: '280ms', ambience: '5200ms', lang: '干脆利落，接近材质本身的硬度；位移小、时间短。' },
    3: { fast: '90ms', base: '130ms', slow: '220ms', ambience: '4200ms', lang: '短促有力，像石块或金属落位；几乎不用缓入缓出。' },
  };
  const motion = motionProfiles[clamp(energy, 0, 3)];

  const grainOpacity = busyness === 'busy' ? 0.04 : 0.055;
  const grainSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='160' height='160' filter='url(%23g)' opacity='0.5'/></svg>";

  // ── 9. assembly ────────────────────────────────────────────────────────
  const schemeOf = (scheme, base, l, ink, ink2, ink3, accent, inkOnAccent) => ({
    scheme,
    base,
    layer1: scheme === 'light' ? lightLadder.layer1 : darkLadder.layer1,
    layer2: scheme === 'light' ? lightLadder.layer2 : darkLadder.layer2,
    layer3: scheme === 'light' ? lightLadder.layer3 : darkLadder.layer3,
    overlay: scheme === 'light' ? lightLadder.overlay : darkLadder.overlay,
    ink,
    inkSecondary: ink2,
    inkTertiary: ink3,
    inkOnAccent,
    accent,
    accentHover: scheme === 'light'
      ? hsl(interfaceHue, clamp(satBase + 0.06, 0.3, 0.7), clamp(rgbToHsl(accent).l + 0.06, 0.05, 0.95))
      : hsl(interfaceHue, clamp(satBase + 0.06, 0.3, 0.7), clamp(rgbToHsl(accent).l - 0.05, 0.05, 0.95)),
    accentSoft: rgba(accent, scheme === 'light' ? 0.14 : 0.2),
    companion: hsl(companionHue, clamp(satBase, 0.24, 0.55), scheme === 'light' ? 0.42 : 0.68),
    borderInk: scheme === 'light' ? '#1c1a17' : '#f2efe9',
    veilAlpha: scheme === 'light' ? lightVeil : darkVeil,
    shadow: scheme === 'light' ? rgba('#1c1a17', 0.2) : rgba('#000000', 0.5),
    shadowSoft: scheme === 'light' ? rgba('#1c1a17', 0.1) : rgba('#000000', 0.3),
  });

  const light = schemeOf('light', lightBase, luma, lightInk, lightInk2, lightInk3, lightAccent, lightInkOnAccent);
  const dark = schemeOf('dark', darkBase, luma, darkInk, darkInk2, darkInk3, darkAccent, darkInkOnAccent);

  const barrier = (from, to, weight, scheme) =>
    scheme === 'light' ? mix(from, to, weight) : mix(from, to, weight);
  for (const [scheme, s] of [['light', light], ['dark', dark]]) {
    s.borderL1 = rgba(s.borderInk, scheme === 'light' ? 0.1 : 0.12);
    s.borderL2 = rgba(s.borderInk, scheme === 'light' ? 0.16 : 0.18);
    s.borderL3 = rgba(s.borderInk, scheme === 'light' ? 0.24 : 0.26);
    s.veil = rgba(s.base, s.veilAlpha);
    s.layer1Veil = rgba(s.layer1, clamp(s.veilAlpha + 0.06, 0, 0.9));
    s.layer2Veil = rgba(s.layer2, clamp(s.veilAlpha + 0.12, 0, 0.92));
    s.overlayVeil = rgba(s.overlay, clamp(s.veilAlpha + 0.12, 0, 0.92));
    void barrier;
  }

  const shadowTokens = shadowStyle === 'hard'
    ? {
        raised: `${shadowOffset} ${shadowOffset} 0 0 var(--dsh-skin-shadow)`,
        floating: `4px 4px 0 0 var(--dsh-skin-shadow-soft), 2px 2px 0 0 var(--dsh-skin-shadow)`,
        overlay: `8px 8px 0 0 var(--dsh-skin-shadow-soft), 3px 3px 0 0 var(--dsh-skin-shadow)`,
        rationale: `shadows are pure offsets with no blur, because the artwork's light is hard and directional (measured lighting: ${lighting.slice(0, 60)}…)`,
      }
    : shadowStyle === 'soft'
      ? {
          raised: `0 1px 3px ${'var(--dsh-skin-shadow-soft)'}, 0 1px 2px var(--dsh-skin-shadow)`,
          floating: `0 4px 14px var(--dsh-skin-shadow-soft), 0 1px 3px var(--dsh-skin-shadow)`,
          overlay: `0 16px 48px var(--dsh-skin-shadow-soft), 0 2px 8px var(--dsh-skin-shadow)`,
          rationale: `shadows are soft and ambient, because the artwork's light is diffuse (measured lighting: ${lighting.slice(0, 60)}…)`,
        }
      : {
          raised: `${shadowOffset} ${shadowOffset} 6px ${'var(--dsh-skin-shadow-soft)'}, 1px 1px 0 var(--dsh-skin-shadow)`,
          floating: `4px 4px 16px var(--dsh-skin-shadow-soft), 2px 2px 0 var(--dsh-skin-shadow)`,
          overlay: `8px 8px 32px var(--dsh-skin-shadow-soft), 3px 3px 0 var(--dsh-skin-shadow)`,
          rationale: 'shadows mix a directional offset with a soft bloom, because the artwork has both a key light and ambient haze',
        };

  const design = {
    summary:
      `从画面的实测特征推导：平均明度 ${luma.toFixed(2)} 决定锚定 ${anchorScheme === 'dark' ? '深色' : '浅色'}，` +
      `${saturation} 饱和度与 ${temperature} 色温决定强调色的饱和预算，` +
      `材质（${material || '未记录'}）决定圆角与描边，` +
      `光影（${lighting ? lighting.slice(0, 30) + '…' : '未记录'}）决定阴影语言，` +
      `细节密度 ${busyness} 决定面板遮罩厚度。`,
    concept: [
      `${anchorScheme === 'dark' ? '深色' : '浅色'}锚定，${temperature === 'warm' ? '暖' : temperature === 'cool' ? '冷' : '中性'}色偏贯穿全部面板`,
      `${shadowStyle === 'hard' ? '硬方向光 → 无模糊偏移阴影' : shadowStyle === 'soft' ? '柔漫射光 → 模糊环境阴影' : '方向光 + 环境雾 → 混合阴影'}`,
      `${metal ? '金属：直角、1px 描边' : stone ? '石材：近方角、2px 台阶描边' : fabric ? '织物：柔和圆角、无硬描边' : glassy ? '玻璃/漆面：中等圆角、高光顶边' : '通用：小圆角、发丝描边'}`,
      `${busyness === 'busy' ? '画面细节密集 → 加厚遮罩' : busyness === 'calm' ? '画面平静 → 可以让背景更多透出' : '细节适中 → 中等遮罩'}`,
    ],
    derivedFrom: [
      `primaryColor ${primary} → 面板色相与冷暖偏移`,
      `accentColor ${accentMeasured} → ${useMeasuredAccent ? '作为交互强调色' : `不作为交互色（画面里只是一小块，面积占比不足），改用次级色 ${accentSource} 的色相`}`,
      `neutrals ${neutrals.join(' / ')} → 文字层次基线`,
      `luminance ${luma.toFixed(2)} → 锚定 ${anchorScheme} 极性`,
      `saturation ${saturation} / temperature ${temperature} → 强调色饱和度预算 ${satBase.toFixed(2)}、面板色偏 ${castSat}`,
      `material「${material || '—'}」→ 圆角尺度 ${radius.sm}–${radius.lg}`,
      `lighting「${(lighting || '—').slice(0, 48)}」→ ${shadowStyle} 阴影语言`,
      `busyness ${busyness} → 面板遮罩 ${Math.round((anchorScheme === 'dark' ? darkVeil : lightVeil) * 100)}%`,
    ],
  };

  return {
    anchorScheme,
    primary,
    accentMeasured,
    accentUsed: useMeasuredAccent ? accentMeasured : accentSource,
    accentWasSubstituted: !useMeasuredAccent,
    light,
    dark,
    radii: radius,
    shadowStyle,
    shadowTokens,
    blur: { panel: blurPanel, overlay: blurOverlay, none: '0px' },
    motion: {
      language: motion.lang,
      durations: { instant: motion.fast === '90ms' ? '70ms' : '80ms', fast: motion.fast, base: motion.base, slow: motion.slow, ambience: motion.ambience },
      easings: {
        standard: shadowStyle === 'hard' ? 'cubic-bezier(0.2, 0, 0.2, 1)' : 'cubic-bezier(0.32, 0.08, 0.24, 1)',
        enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      distance: shadowStyle === 'hard' ? '2px' : '4px',
      ambience: `背景以 scale 1.0↔1.0${shadowStyle === 'hard' ? '2' : '4'} 的 ${motion.ambience} 周期缓慢推拉；reduce 时完全停止`,
    },
    texture: {
      grain: { enabled: true, svg: grainSvg, opacityLight: grainOpacity, opacityDark: grainOpacity + 0.015, blendLight: 'multiply', blendDark: 'overlay' },
      hairlines: true,
      bevel: shadowStyle === 'hard' || glassy,
    },
    design,
    isVideo,
  };
}

// ── emission ────────────────────────────────────────────────────────────────
const typographyStacks = {
  default: "'Inter', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  display: "'Inter Tight', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
};

function schemeVars(s) {
  return {
    '--p-base': s.base,
    '--p-layer1': s.layer1,
    '--p-layer2': s.layer2,
    '--p-layer3': s.layer3,
    '--p-overlay': s.overlay,
    '--p-ink': s.ink,
    '--p-ink2': s.inkSecondary,
    '--p-ink3': s.inkTertiary,
    '--p-ink-on-accent': s.inkOnAccent,
    '--p-accent': s.accent,
    '--p-accent-hover': s.accentHover,
    '--p-accent-soft': s.accentSoft,
    '--p-companion': s.companion,
    '--p-veil': s.veil,
    '--p-veil-1': s.layer1Veil,
    '--p-veil-2': s.layer2Veil,
    '--p-veil-overlay': s.overlayVeil,
    '--p-border-l1': s.borderL1,
    '--p-border-l2': s.borderL2,
    '--p-border-l3': s.borderL3,
    '--p-shadow': s.shadow,
    '--p-shadow-soft': s.shadowSoft,
    '--p-scrim-top': rgba(s.base, 0.7),
    '--p-scrim-mid': rgba(s.base, 0.22),
    '--p-scrim-bottom': rgba(s.base, 0.76),
    '--p-scheme': s.scheme,
  };
}

function schemeBlock(label, s) {
  return `  /* ${label} */
  --dsh-skin-scheme: ${s.scheme};
  --dsw-alias-bg-base: ${s.base};
  --dsw-alias-bg-layer-1: ${s.layer1};
  --dsw-alias-bg-layer-2: ${s.layer2};
  --dsw-alias-bg-layer-3: ${s.layer3};
  --dsw-alias-bg-overlay: ${s.overlay};
  --dsw-alias-bg-module-platform: ${s.layer1};
  --dsw-specific-sidebar-fill: ${s.layer1};
  --dsw-specific-input-major: ${s.layer2};
  --dsw-specific-bubble: ${s.layer2};
  --dsw-alias-tooltip-bg: ${s.layer3};
  --dsw-alias-toast-bg: ${s.layer3};
  --dsw-alias-label-primary: ${s.ink};
  --dsw-alias-label-primary-foreground: ${s.inkOnAccent};
  --dsw-alias-label-secondary: ${s.inkSecondary};
  --dsw-alias-label-tertiary: ${s.inkTertiary};
  --dsw-alias-label-dimmed: ${s.inkTertiary};
  --dsw-alias-label-caption: ${s.inkTertiary};
  --dsw-alias-brand-primary: ${s.accent};
  --dsw-alias-brand-text: ${s.accent};
  --dsw-alias-link: ${s.accent};
  --dsw-alias-state-business-primary: ${s.accent};
  --dsw-specific-sidebar-nav-item-active-accent: ${s.accent};
  --dsw-alias-button-primary-fill: ${s.accent};
  --dsw-alias-button-primary-hover: ${s.accentHover};
  --dsw-alias-interactive-bg-hover: ${s.accentSoft};
  --dsw-alias-border-l1: ${s.borderL1};
  --dsw-alias-border-l2: ${s.borderL2};
  --dsw-alias-border-l3: ${s.borderL3};
  --dsw-alias-scrollbar-bg-l1: ${s.borderL2};
  --dsw-alias-scrollbar-hover-l1: ${s.borderL3};
  --dsh-skin-accent-soft: ${s.accentSoft};
  --dsh-skin-companion: ${s.companion};
  --dsh-skin-veil: ${s.veil};
  --dsh-skin-veil-1: ${s.layer1Veil};
  --dsh-skin-veil-2: ${s.layer2Veil};
  --dsh-skin-veil-overlay: ${s.overlayVeil};
  --dsh-skin-shadow: ${s.shadow};
  --dsh-skin-shadow-soft: ${s.shadowSoft};`;
}

/** The stylesheet. Identical structure for every skin; values come from tokens. */
export function themeCss(spec, meta) {
  const r = spec.radii;
  const m = spec.motion;
  const t = typographyStacks[spec.shadowStyle === 'hard' ? 'default' : 'display'];
  const grain = spec.texture.grain;
  const id = meta.skinId;
  const slug = meta.slug;
  return `/* ==========================================================================
   ${meta.name} (${meta.nameZh}) — ${id}
   ==========================================================================
   Generated by output/_scan/build_all_skins.mjs from the measurements in
   ${meta.analysisRecord}. Do not hand-edit: edit the analysis or the generator.

   dsh has no stylesheet-level skin format. The supported entry point is
   \`ctx.theme.overrideTokens(source, { light, dark })\` with #rgb/#rrggbb pairs;
   the shell's presenter then writes them as inline custom properties on <body>
   and owns \`body[data-ds-dark-theme]\`. This file is the stylesheet half of the
   same skin (for preview and for the plugin's own chrome); every rule is scoped
   to \`[data-skin="${id}"]\` so skins cannot leak into each other.
   ========================================================================== */

[data-skin="${id}"] {
  color-scheme: light;
${schemeBlock('light scheme', spec.light)}

  /* typography */
  --dsh-skin-font: ${t};
  --dsh-skin-font-mono: 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace;
  --dsh-content-font-size: 14px;
  --dsh-skin-text-xs: 11px;
  --dsh-skin-text-sm: 12px;
  --dsh-skin-text-base: 14px;
  --dsh-skin-text-lg: 16px;
  --dsh-skin-text-xl: 20px;
  --dsh-skin-tracking-caps: 0.08em;

  /* radii (from material "${spec.design.concept[2]}") */
  --dsh-skin-radius-none: ${r.none};
  --dsh-skin-radius-xs: ${r.xs};
  --dsh-skin-radius-sm: ${r.sm};
  --dsh-skin-radius-md: ${r.md};
  --dsh-skin-radius-lg: ${r.lg};
  --dsh-skin-radius-pill: ${r.pill};
  --dsh-skin-radius-full: 9999px;

  /* spacing */
  --dsh-skin-space-1: 4px;
  --dsh-skin-space-2: 8px;
  --dsh-skin-space-3: 12px;
  --dsh-skin-space-4: 16px;
  --dsh-skin-space-5: 20px;
  --dsh-skin-space-6: 24px;
  --dsh-skin-space-8: 32px;
  --dsh-skin-sidebar-width: 260px;
  --dsh-skin-rightbar-width: 320px;
  --dsh-skin-titlebar-height: 36px;
  --dsh-skin-composer-max: 760px;

  /* blur (${spec.blur.panel} panels / ${spec.blur.overlay} overlays) */
  --dsh-skin-blur-panel: ${spec.blur.panel};
  --dsh-skin-blur-overlay: ${spec.blur.overlay};

  /* elevation: ${spec.shadowStyle} light */
  --dsh-skin-shadow-flat: none;
  --dsh-skin-shadow-raised: ${spec.shadowTokens.raised};
  --dsh-skin-shadow-floating: ${spec.shadowTokens.floating};
  --dsh-skin-shadow-overlay: ${spec.shadowTokens.overlay};
  --dsh-skin-bevel-top: ${spec.texture.bevel ? 'inset 0 1px 0 0 rgba(255, 255, 255, 0.35)' : 'none'};

  /* opacity */
  --dsh-skin-opacity-disabled: 0.42;
  --dsh-skin-opacity-muted: 0.66;
  --dsh-skin-opacity-hover: 0.08;
  --dsh-skin-opacity-active: 0.14;
  --dsh-skin-opacity-selected: 0.18;
  --dsh-skin-opacity-scrim: 0.5;

  /* motion */
  --dsh-skin-dur-instant: ${m.durations.instant};
  --dsh-skin-dur-fast: ${m.durations.fast};
  --dsh-skin-dur-base: ${m.durations.base};
  --dsh-skin-dur-slow: ${m.durations.slow};
  --dsh-skin-dur-ambience: ${m.durations.ambience};
  --dsh-skin-ease: ${m.easings.standard};
  --dsh-skin-ease-enter: ${m.easings.enter};
  --dsh-skin-ease-exit: ${m.easings.exit};
  --dsh-skin-move: ${m.distance};

  font-family: var(--dsh-skin-font);
  font-size: var(--dsh-skin-text-base);
  color: var(--dsw-alias-label-primary);
  background-color: var(--dsw-alias-bg-base);
  -webkit-font-smoothing: antialiased;
}

[data-skin="${id}"][data-ds-dark-theme] {
  color-scheme: dark;
${schemeBlock('dark scheme', spec.dark)}
}

/* artwork layer */
[data-skin="${id}"] [data-skin-layer] {
  position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none;
  background-color: var(--dsw-alias-bg-base);
}
[data-skin="${id}"] [data-skin-layer] > .skin-media {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; object-position: center 46%; display: block;
}
[data-skin="${id}"] [data-skin-layer] > .skin-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to bottom,
    var(--p-scrim-top) 0%, var(--p-scrim-mid) 34%,
    var(--p-scrim-mid) 58%, var(--p-scrim-bottom) 100%);
}
[data-skin="${id}"] [data-skin-layer] > .skin-grain {
  position: absolute; inset: 0;
  opacity: ${grain.opacityLight}; mix-blend-mode: ${grain.blendLight};
  background-image: url("${grain.svg}"); background-size: 160px 160px;
}
[data-skin="${id}"][data-ds-dark-theme] [data-skin-layer] > .skin-grain {
  opacity: ${grain.opacityDark}; mix-blend-mode: ${grain.blendDark};
}
[data-skin="${id}"] [data-skin-layer] > .skin-poster { z-index: 0; }
[data-skin="${id}"] [data-skin-layer] > .skin-video { z-index: 1; }
@media (prefers-reduced-motion: reduce) {
  [data-skin="${id}"] [data-skin-layer] > .skin-video { display: none; }
}
[data-skin="${id}"] .skin-surface { position: relative; z-index: 1; }

/* keyframes */
@keyframes dsh-skin-ambience-${slug} {
  0%   { transform: scale(1) translate3d(0, 0, 0); }
  50%  { transform: scale(1.02) translate3d(-0.6%, -0.4%, 0); }
  100% { transform: scale(1) translate3d(0, 0, 0); }
}
@keyframes dsh-skin-shimmer-${slug} {
  0%   { background-position: -180% 0; }
  100% { background-position: 180% 0; }
}
@keyframes dsh-skin-sweep-${slug} {
  0%   { transform: translateX(-110%); }
  100% { transform: translateX(210%); }
}
[data-skin="${id}"] [data-skin-layer] > .skin-media[data-animate='true'] {
  animation: dsh-skin-ambience-${slug} var(--dsh-skin-dur-ambience) var(--dsh-skin-ease) infinite;
}
@media (prefers-reduced-motion: reduce) {
  [data-skin="${id}"] [data-skin-layer] > .skin-media { animation: none !important; }
}

/* sidebar / navigation */
[data-skin="${id}"] .skin-sidebar {
  background: var(--dsh-skin-veil-1);
  backdrop-filter: blur(var(--dsh-skin-blur-panel)) saturate(112%);
  border-inline-end: 1px solid var(--dsw-alias-border-l1);
}
[data-skin="${id}"] .skin-nav-item {
  display: flex; align-items: center; gap: var(--dsh-skin-space-2);
  padding: var(--dsh-skin-space-2) var(--dsh-skin-space-3);
  border-radius: var(--dsh-skin-radius-sm);
  border-inline-start: 2px solid transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  transition: background-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease),
              color var(--dsh-skin-dur-fast) var(--dsh-skin-ease),
              border-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[data-skin="${id}"] .skin-nav-item[aria-current='page'] {
  background: var(--dsh-skin-accent-soft); border-inline-start-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
[data-skin="${id}"] .skin-nav-item:active { background: var(--dsh-skin-veil-2); }

/* header */
[data-skin="${id}"] .skin-header {
  height: var(--dsh-skin-titlebar-height); display: flex; align-items: center;
  gap: var(--dsh-skin-space-3); padding-inline: var(--dsh-skin-space-4);
  background: var(--dsh-skin-veil-1);
  backdrop-filter: blur(var(--dsh-skin-blur-panel));
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[data-skin="${id}"] .skin-caption {
  font-size: var(--dsh-skin-text-xs); letter-spacing: var(--dsh-skin-tracking-caps);
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}

/* cards */
[data-skin="${id}"] .skin-card {
  position: relative; background: var(--dsh-skin-veil-2);
  backdrop-filter: blur(var(--dsh-skin-blur-panel)) saturate(112%);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsh-skin-radius-md);
  box-shadow: var(--dsh-skin-shadow-raised), var(--dsh-skin-bevel-top);
  padding: var(--dsh-skin-space-4);
  transition: box-shadow var(--dsh-skin-dur-base) var(--dsh-skin-ease),
              transform var(--dsh-skin-dur-base) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-card[data-interactive='true']:hover {
  transform: translate(-1px, -1px); box-shadow: var(--dsh-skin-shadow-floating), var(--dsh-skin-bevel-top);
}
[data-skin="${id}"] .skin-card[data-elevated='true'] { background: var(--dsh-skin-veil-overlay); box-shadow: var(--dsh-skin-shadow-overlay); }
[data-skin="${id}"] .skin-divider { height: 1px; border: 0; background: var(--dsw-alias-border-l1); }
[data-skin="${id}"] .skin-hairline-accent { height: 2px; border: 0; background: linear-gradient(to right, var(--dsw-alias-brand-primary), transparent); }

/* buttons */
[data-skin="${id}"] .skin-btn {
  appearance: none; display: inline-flex; align-items: center; gap: var(--dsh-skin-space-2);
  padding: var(--dsh-skin-space-2) var(--dsh-skin-space-4);
  font: inherit; font-size: var(--dsh-skin-text-sm); font-weight: 500; letter-spacing: 0.01em;
  color: var(--dsw-alias-label-primary); background: var(--dsh-skin-veil-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsh-skin-radius-sm);
  cursor: pointer;
  transition: background-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease),
              border-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease),
              transform var(--dsh-skin-dur-instant) var(--dsh-skin-ease),
              box-shadow var(--dsh-skin-dur-fast) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-btn:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsh-skin-veil-overlay); }
[data-skin="${id}"] .skin-btn:active { transform: translateY(1px); }
[data-skin="${id}"] .skin-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
[data-skin="${id}"] .skin-btn[disabled], [data-skin="${id}"] .skin-btn[aria-disabled='true'] {
  opacity: var(--dsh-skin-opacity-disabled); cursor: not-allowed; box-shadow: none;
}
[data-skin="${id}"] .skin-btn-primary {
  color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-button-primary-fill);
  border-color: transparent; box-shadow: var(--dsh-skin-shadow-raised);
}
[data-skin="${id}"] .skin-btn-primary:hover { background: var(--dsw-alias-button-primary-hover); }
[data-skin="${id}"] .skin-btn-primary:active { transform: translateY(1px); box-shadow: none; }
[data-skin="${id}"] .skin-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
[data-skin="${id}"] .skin-btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[data-skin="${id}"] .skin-btn-icon { padding: var(--dsh-skin-space-2); aspect-ratio: 1; }

/* inputs */
[data-skin="${id}"] .skin-input, [data-skin="${id}"] .skin-textarea, [data-skin="${id}"] .skin-select {
  width: 100%; font: inherit; font-size: var(--dsh-skin-text-sm);
  color: var(--dsw-alias-label-primary); background: var(--dsh-skin-veil-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsh-skin-radius-sm);
  padding: var(--dsh-skin-space-2) var(--dsh-skin-space-3);
  transition: border-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease),
              box-shadow var(--dsh-skin-dur-fast) var(--dsh-skin-ease),
              background-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-input::placeholder, [data-skin="${id}"] .skin-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
[data-skin="${id}"] .skin-input:hover, [data-skin="${id}"] .skin-select:hover { border-color: var(--dsw-alias-border-l3); }
[data-skin="${id}"] .skin-input:focus, [data-skin="${id}"] .skin-textarea:focus, [data-skin="${id}"] .skin-select:focus {
  outline: none; background: var(--dsh-skin-veil-overlay);
  border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px var(--dsh-skin-accent-soft);
}
[data-skin="${id}"] .skin-input[disabled], [data-skin="${id}"] .skin-textarea[disabled] { opacity: var(--dsh-skin-opacity-disabled); cursor: not-allowed; }
[data-skin="${id}"] .skin-field-label {
  display: block; margin-bottom: var(--dsh-skin-space-1); font-size: var(--dsh-skin-text-xs);
  letter-spacing: var(--dsh-skin-tracking-caps); text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}
[data-skin="${id}"] .skin-select {
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 16px) 52%, calc(100% - 11px) 52%;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
  padding-inline-end: var(--dsh-skin-space-8);
}

/* popover / menu / modal */
[data-skin="${id}"] .skin-menu {
  min-width: 200px; padding: var(--dsh-skin-space-1);
  background: var(--dsh-skin-veil-overlay);
  backdrop-filter: blur(var(--dsh-skin-blur-overlay)) saturate(118%);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsh-skin-radius-md);
  box-shadow: var(--dsh-skin-shadow-floating);
}
[data-skin="${id}"] .skin-menu-item {
  display: flex; justify-content: space-between; gap: var(--dsh-skin-space-4);
  padding: var(--dsh-skin-space-2) var(--dsh-skin-space-3);
  border-radius: var(--dsh-skin-radius-xs); font-size: var(--dsh-skin-text-sm);
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  transition: background-color var(--dsh-skin-dur-instant) var(--dsh-skin-ease), color var(--dsh-skin-dur-instant) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[data-skin="${id}"] .skin-menu-item[data-danger='true']:hover { background: #b3261e; color: #fff; }
[data-skin="${id}"] .skin-menu-sep { height: 1px; margin: var(--dsh-skin-space-1) 0; background: var(--dsw-alias-border-l1); }
[data-skin="${id}"] .skin-scrim-mask {
  position: fixed; inset: 0; z-index: 40; display: grid; place-items: center;
  background: rgb(0 0 0 / var(--dsh-skin-opacity-scrim));
  animation: dsh-skin-fade-in var(--dsh-skin-dur-base) var(--dsh-skin-ease-enter);
}
@keyframes dsh-skin-fade-in { from { opacity: 0; } to { opacity: 1; } }
[data-skin="${id}"] .skin-dialog {
  width: min(520px, 90vw); padding: var(--dsh-skin-space-6);
  background: var(--dsh-skin-veil-overlay);
  backdrop-filter: blur(var(--dsh-skin-blur-overlay)) saturate(118%);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsh-skin-radius-lg);
  box-shadow: var(--dsh-skin-shadow-overlay);
  animation: dsh-skin-rise var(--dsh-skin-dur-slow) var(--dsh-skin-ease-enter);
}
@keyframes dsh-skin-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

/* tabs */
[data-skin="${id}"] .skin-tabs {
  display: inline-flex; gap: 2px; padding: 2px; background: var(--dsh-skin-veil-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsh-skin-radius-pill);
}
[data-skin="${id}"] .skin-tab {
  appearance: none; border: 0; background: transparent; font: inherit; font-size: var(--dsh-skin-text-sm);
  color: var(--dsw-alias-label-secondary); padding: var(--dsh-skin-space-1) var(--dsh-skin-space-4);
  border-radius: var(--dsh-skin-radius-pill); cursor: pointer;
  transition: background-color var(--dsh-skin-dur-fast) var(--dsh-skin-ease), color var(--dsh-skin-dur-fast) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-tab:hover { color: var(--dsw-alias-label-primary); }
[data-skin="${id}"] .skin-tab[aria-selected='true'] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); box-shadow: var(--dsh-skin-shadow-raised); }
[data-skin="${id}"] .skin-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

/* tags */
[data-skin="${id}"] .skin-tag {
  display: inline-flex; align-items: center; gap: var(--dsh-skin-space-1);
  padding: 1px var(--dsh-skin-space-2); font-size: var(--dsh-skin-text-xs); letter-spacing: 0.02em;
  color: var(--dsh-skin-companion); background: var(--dsh-skin-veil-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsh-skin-radius-xs);
}
[data-skin="${id}"] .skin-tag-accent { color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-brand-primary); border-color: transparent; }
[data-skin="${id}"] .skin-tag-outline { color: var(--dsw-alias-brand-primary); background: var(--dsh-skin-accent-soft); border-color: var(--dsw-alias-brand-primary); }

/* switch */
[data-skin="${id}"] .skin-switch {
  appearance: none; position: relative; width: 38px; height: 22px;
  background: var(--dsh-skin-veil-2); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsh-skin-radius-pill); cursor: pointer;
  transition: background-color var(--dsh-skin-dur-base) var(--dsh-skin-ease), border-color var(--dsh-skin-dur-base) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  background: var(--dsw-alias-label-secondary); border-radius: var(--dsh-skin-radius-full);
  transition: transform var(--dsh-skin-dur-base) var(--dsh-skin-ease), background-color var(--dsh-skin-dur-base) var(--dsh-skin-ease);
}
[data-skin="${id}"] .skin-switch:checked { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
[data-skin="${id}"] .skin-switch:checked::after { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground); }
[data-skin="${id}"] .skin-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
[data-skin="${id}"] .skin-switch[disabled] { opacity: var(--dsh-skin-opacity-disabled); cursor: not-allowed; }

/* scrollbar */
[data-skin="${id}"] .skin-scroll { overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent; }
[data-skin="${id}"] .skin-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
[data-skin="${id}"] .skin-scroll::-webkit-scrollbar-track { background: transparent; }
[data-skin="${id}"] .skin-scroll::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1); border: 3px solid transparent;
  border-radius: var(--dsh-skin-radius-pill); background-clip: content-box;
}
[data-skin="${id}"] .skin-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); background-clip: content-box; }

/* code block */
[data-skin="${id}"] .skin-code {
  position: relative; margin: 0; padding: var(--dsh-skin-space-4);
  font-family: var(--dsh-skin-font-mono); font-size: var(--dsh-skin-text-sm); line-height: 1.6;
  color: var(--dsw-alias-label-primary); background: var(--dsh-skin-veil-2);
  border: 1px solid var(--dsw-alias-border-l2); border-inline-start: 2px solid var(--dsw-alias-brand-primary);
  border-radius: var(--dsh-skin-radius-sm); overflow-x: auto;
}
[data-skin="${id}"] .skin-code .tok-key { color: var(--dsw-alias-brand-primary); }
[data-skin="${id}"] .skin-code .tok-str { color: var(--dsh-skin-companion); }
[data-skin="${id}"] .skin-code .tok-com { color: var(--dsw-alias-label-tertiary); }

/* loading */
[data-skin="${id}"] .skin-skeleton { position: relative; overflow: hidden; background: var(--dsh-skin-veil-2); border-radius: var(--dsh-skin-radius-xs); }
[data-skin="${id}"] .skin-skeleton::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, var(--dsh-skin-accent-soft), transparent);
  background-size: 180% 100%; animation: dsh-skin-shimmer-${slug} 1.4s linear infinite;
}
[data-skin="${id}"] .skin-spinner {
  width: 18px; height: 18px; border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary); border-radius: var(--dsh-skin-radius-full);
  animation: dsh-skin-spin 700ms linear infinite;
}
@keyframes dsh-skin-spin { to { transform: rotate(360deg); } }
[data-skin="${id}"] .skin-progress { height: 3px; overflow: hidden; background: var(--dsh-skin-veil-2); border-radius: var(--dsh-skin-radius-pill); }
[data-skin="${id}"] .skin-progress > span {
  display: block; height: 100%; width: 42%; background: var(--dsw-alias-brand-primary);
  animation: dsh-skin-sweep-${slug} 1.6s var(--dsh-skin-ease) infinite;
}
@media (prefers-reduced-motion: reduce) {
  [data-skin="${id}"] .skin-skeleton::after, [data-skin="${id}"] .skin-spinner, [data-skin="${id}"] .skin-progress > span { animation: none; }
  [data-skin="${id}"] .skin-spinner { border-top-color: var(--dsw-alias-border-l3); }
}

/* video readability + fallback */
[data-skin="${id}"] .skin-video-wrap { position: relative; }
[data-skin="${id}"] .skin-video-wrap[data-fallback='poster'] .skin-video { display: none; }
[data-skin="${id}"] .skin-video-badge {
  display: inline-flex; align-items: center; gap: var(--dsh-skin-space-1);
  font-size: var(--dsh-skin-text-xs); letter-spacing: var(--dsh-skin-tracking-caps);
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}

/* focus ring */
[data-skin="${id}"] :focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  [data-skin="${id}"] *, [data-skin="${id}"] *::before, [data-skin="${id}"] *::after {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important;
  }
}
`;
}

export function buildTokens(spec, meta) {
  /**
   * Turn one `#rrggbb` into `rgba(...)` at the scheme's veil alpha.
   *
   * This exists because dsh's own shell paints its surfaces from the alias
   * tokens — `.BynINW_frame` and `.BynINW_centerCol` both set
   * `background: var(--dsw-alias-bg-base)` — so a fully opaque value hides the
   * artwork completely. The desktop skin therefore has to publish translucent
   * values for the tokens the shell paints, while `colors.*` keeps the solid
   * values the preview and theme.css use.
   */
  const tint = (hex, alpha) => {
    const [r, g, b] = parseHex(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  /** The `{ light, dark }` pairs a plugin hands to ctx.theme.overrideTokens. */
  const presentedTokens = () => {
    const pairs = {};
    const put = (name, pick) => {
      pairs[name] = { light: pick(spec.light), dark: pick(spec.dark) };
    };
    // Surfaces the shell actually paints: translucent so the artwork stays visible.
    put('--dsw-alias-bg-base', (s) => tint(s.base, s.veilAlpha));
    put('--dsw-alias-bg-layer-1', (s) => tint(s.layer1, Math.min(0.94, s.veilAlpha + 0.06)));
    put('--dsw-alias-bg-layer-2', (s) => tint(s.layer2, Math.min(0.95, s.veilAlpha + 0.12)));
    put('--dsw-alias-bg-layer-3', (s) => tint(s.layer3, 0.96));
    put('--dsw-alias-bg-overlay', (s) => tint(s.overlay, 0.96));
    put('--dsw-alias-bg-module-platform', (s) => tint(s.layer1, Math.min(0.94, s.veilAlpha + 0.06)));
    put('--dsw-specific-sidebar-fill', (s) => tint(s.layer1, Math.min(0.94, s.veilAlpha + 0.06)));
    put('--dsw-specific-input-major', (s) => tint(s.layer2, Math.min(0.95, s.veilAlpha + 0.12)));
    put('--dsw-specific-bubble', (s) => tint(s.layer2, Math.min(0.95, s.veilAlpha + 0.12)));
    put('--dsw-alias-tooltip-bg', (s) => tint(s.layer3, 0.96));
    put('--dsw-alias-toast-bg', (s) => tint(s.layer3, 0.96));
    // Text and borders stay solid: translucency there costs legibility and buys nothing.
    put('--dsw-alias-label-primary', (s) => s.ink);
    put('--dsw-alias-label-secondary', (s) => s.inkSecondary);
    put('--dsw-alias-label-tertiary', (s) => s.inkTertiary);
    put('--dsw-alias-label-dimmed', (s) => s.inkTertiary);
    put('--dsw-alias-label-caption', (s) => s.inkTertiary);
    put('--dsw-alias-label-primary-foreground', (s) => s.inkOnAccent);
    put('--dsw-alias-border-l1', (s) => s.borderL1);
    put('--dsw-alias-border-l2', (s) => s.borderL2);
    put('--dsw-alias-border-l3', (s) => s.borderL3);
    put('--dsw-alias-brand-primary', (s) => s.accent);
    put('--dsw-alias-brand-text', (s) => s.accent);
    put('--dsw-alias-link', (s) => s.accent);
    put('--dsw-alias-state-business-primary', (s) => s.accent);
    put('--dsw-specific-sidebar-nav-item-active-accent', (s) => s.accent);
    put('--dsw-alias-button-primary-fill', (s) => s.accent);
    put('--dsw-alias-button-primary-hover', (s) => s.accentHover);
    put('--dsw-alias-interactive-bg-hover', (s) => s.accentSoft);
    put('--dsw-alias-scrollbar-bg-l1', (s) => s.borderL2);
    put('--dsw-alias-scrollbar-hover-l1', (s) => s.borderL3);
    return pairs;
  };

  const schemePair = (s) => ({
    base: s.base, layer1: s.layer1, layer2: s.layer2, layer3: s.layer3, overlay: s.overlay,
    ink: s.ink, inkSecondary: s.inkSecondary, inkTertiary: s.inkTertiary, inkOnAccent: s.inkOnAccent,
    accent: s.accent, accentHover: s.accentHover, companion: s.companion,
    veil: s.veil, veilAlpha: s.veilAlpha,
    borderL1: s.borderL1, borderL2: s.borderL2, borderL3: s.borderL3,
    shadow: s.shadow, shadowSoft: s.shadowSoft,
  });
  const ratios = {
    'light: ink on base': contrastRatio(spec.light.ink, spec.light.base),
    'light: ink on layer2': contrastRatio(spec.light.ink, spec.light.layer2),
    'light: secondary on base': contrastRatio(spec.light.inkSecondary, spec.light.base),
    'light: accent on base': contrastRatio(spec.light.accent, spec.light.base),
    'light: accent on layer2': contrastRatio(spec.light.accent, spec.light.layer2),
    'light: accent on layer3': contrastRatio(spec.light.accent, spec.light.layer3),
    'light: button label on accent': contrastRatio(spec.light.inkOnAccent, spec.light.accent),
    'dark: ink on base': contrastRatio(spec.dark.ink, spec.dark.base),
    'dark: ink on layer2': contrastRatio(spec.dark.ink, spec.dark.layer2),
    'dark: secondary on base': contrastRatio(spec.dark.inkSecondary, spec.dark.base),
    'dark: accent on base': contrastRatio(spec.dark.accent, spec.dark.base),
    'dark: accent on layer2': contrastRatio(spec.dark.accent, spec.dark.layer2),
    'dark: accent on layer3': contrastRatio(spec.dark.accent, spec.dark.layer3),
    'dark: button label on accent': contrastRatio(spec.dark.inkOnAccent, spec.dark.accent),
  };
  const wcag = Object.fromEntries(Object.entries(ratios).map(([key, value]) => [key, {
    ratio: value,
    bodyText: value >= 4.5,
    largeText: value >= 3,
    graphics: value >= 3,
  }]));
  return {
    $schema: 'dsh-skin-tokens/1',
    skinId: meta.skinId,
    name: meta.name,
    kind: meta.kind,
    generatedFrom: meta.analysisRecord,
    note: 'tokens.json is the source of truth; theme.css is emitted from it. The --dsw-alias-* values are the pairs a dsh plugin passes to ctx.theme.overrideTokens(source, { light, dark }) and are all #rgb/#rrggbb.',
    colors: {
      light: schemePair(spec.light),
      dark: schemePair(spec.dark),
      artwork: {
        primaryColor: meta.artwork.primaryColor,
        secondaryColors: meta.artwork.secondaryColors,
        accentColor: meta.artwork.accentColor,
        neutrals: meta.artwork.neutrals,
        temperature: meta.artwork.temperature,
        saturation: meta.artwork.saturation,
        luminance: meta.artwork.luminance,
        contrast: meta.artwork.contrast,
      },
      accentSubstituted: spec.accentWasSubstituted,
      accentUsed: spec.accentUsed,
      semanticMapping: {
        '--dsw-alias-bg-base': 'base', '--dsw-alias-bg-layer-1': 'layer1', '--dsw-alias-bg-layer-2': 'layer2',
        '--dsw-alias-bg-layer-3': 'layer3', '--dsw-alias-bg-overlay': 'overlay', '--dsw-specific-sidebar-fill': 'layer1',
        '--dsw-alias-label-primary': 'ink', '--dsw-alias-label-secondary': 'inkSecondary',
        '--dsw-alias-label-tertiary': 'inkTertiary', '--dsw-alias-brand-primary': 'accent',
        '--dsw-alias-link': 'accent', '--dsw-alias-button-primary-fill': 'accent',
        '--dsw-alias-label-primary-foreground': 'inkOnAccent',
      },
    },
    typography: {
      fontFamily: typographyStacks[spec.shadowStyle === 'hard' ? 'default' : 'display'],
      fontFamilyMono: "'JetBrains Mono', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      sizes: { xs: '11px', sm: '12px', base: '14px', lg: '16px', xl: '20px' },
      weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
      lineHeights: { tight: 1.2, base: 1.55, loose: 1.75 },
      letterSpacing: { tight: '-0.01em', base: '0', wide: '0.02em', caps: '0.08em' },
      contentFontSize: { min: '10px', max: '22px', default: '14px' },
    },
    radii: spec.radii,
    shadows: { ...spec.shadowTokens, light: spec.light.shadow, lightSoft: spec.light.shadowSoft, dark: spec.dark.shadow, darkSoft: spec.dark.shadowSoft },
    spacing: {
      unit: '4px',
      scale: { '0': '0px', '1': '4px', '2': '8px', '3': '12px', '4': '16px', '5': '20px', '6': '24px', '8': '32px', '10': '40px', '12': '48px' },
      layout: { sidebarWidth: '260px', rightSidebarWidth: '320px', titlebarHeight: '36px', composerMaxWidth: '760px', contentMaxWidth: '900px' },
    },
    opacity: { disabled: 0.42, muted: 0.66, hover: 0.08, active: 0.14, selected: 0.18, scrim: 0.5, videoScrimTop: 0.7, videoScrimMiddle: 0.22, videoScrimBottom: 0.76 },
    blur: spec.blur,
    borders: {
      width: { hairline: '1px', emphasis: '2px', focus: '2px' },
      style: 'solid',
      light: { l1: spec.light.borderL1, l2: spec.light.borderL2, l3: spec.light.borderL3 },
      dark: { l1: spec.dark.borderL1, l2: spec.dark.borderL2, l3: spec.dark.borderL3 },
      focusRing: '2px solid var(--dsw-alias-brand-primary), offset 2px',
    },
    motion: spec.motion,
    texture: spec.texture,
    contrast: { formula: 'WCAG 2.x relative luminance', ratios, wcag },
    presentedTokens: presentedTokens(),
    ...(meta.kind === 'video' ? {
      video: {
        attributes: { muted: true, loop: true, playsInline: true, autoPlay: true, preload: 'metadata' },
        poster: 'assets/poster.webp',
        fallbackStill: 'assets/poster.webp',
        source: meta.source,
        width: meta.sourceSize.width,
        height: meta.sourceSize.height,
        durationSeconds: meta.durationSeconds,
        bitrateMbps: meta.bitrateMbps,
        scrim: {
          top: 'rgba(base, 0.70)', middle: 'rgba(base, 0.22)', bottom: 'rgba(base, 0.76)',
          rationale: 'A vertical gradient rather than a flat scrim, so the artwork keeps its own contrast through the middle while the header and composer bands stay legible.',
        },
        reducedMotion: { behavior: 'Hide <video>, keep the poster still, disable the ambience scale.', selector: '@media (prefers-reduced-motion: reduce)' },
        performance: { note: 'No transcode, no copy: the host serves the original file with Range support.', mountPolicy: 'poster-only until selected and visible; pause on hidden/error/timeout' },
      },
    } : {}),
  };
}
