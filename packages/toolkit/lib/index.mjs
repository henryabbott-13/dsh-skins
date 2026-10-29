/**
 * dsh-skins toolkit — public surface.
 *
 * `derive.mjs` is the design engine the shipped skins use: a measured record in,
 * a complete token set and stylesheet out. `assemble.mjs` writes those into the
 * on-disk skin format the plugin reads. Nothing here decodes media: measurement
 * is the caller's job (the panel measures in the browser; scripts can measure
 * with any decoder they like), which keeps this package dependency-free.
 */
export {
  deriveDesign,
  buildTokens,
  themeCss,
  rgbToHsl,
  hslToRgb,
  luminance,
  contrastRatio,
  ensureContrast,
  parseHex,
  toHex,
} from './derive.mjs';

export { buildSkin, checkSkinDir, SKIN_FILE_NAMES } from './assemble.mjs';
