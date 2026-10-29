/**
 * The three generated demo skins, shared by the demo builder and the social
 * preview. Every colour here is a constant this repository chose; nothing is
 * sampled from anyone's artwork.
 */
export const DEMOS = [
  {
    skinId: 'img_demo-ember_6b1f2c3d',
    name: 'Demo Ember',
    nameZh: '示例·余烬',
    still: [38, 30, 34],
    band: [193, 118, 74],
    accent: '#c1764a',
    record: {
      primary: '#2a1e22',
      accent: '#c1764a',
      neutrals: ['#1a1518', '#6a5550', '#efe4da'],
      secondaries: ['#c1764a', '#8fb3d9'],
      luma: 0.24,
      saturation: 'muted',
      temperature: 'warm',
      busyness: 'calm',
    },
  },
  {
    skinId: 'img_demo-frost_9c8d7e6f',
    name: 'Demo Frost',
    nameZh: '示例·霜白',
    still: [214, 222, 234],
    band: [63, 111, 176],
    accent: '#3f6fb0',
    record: {
      primary: '#d6deea',
      accent: '#3f6fb0',
      neutrals: ['#f2f5fa', '#9aa3b4', '#22262f'],
      secondaries: ['#3f6fb0', '#b4551f'],
      luma: 0.78,
      saturation: 'balanced',
      temperature: 'cool',
      busyness: 'moderate',
    },
  },
  {
    skinId: 'img_demo-teal_4d5e6f70',
    name: 'Demo Teal',
    nameZh: '示例·青碧',
    still: [26, 46, 46],
    band: [47, 156, 148],
    accent: '#2f9c94',
    record: {
      primary: '#1b2f2f',
      accent: '#2f9c94',
      neutrals: ['#121a1a', '#4a6464', '#dfe9e7'],
      secondaries: ['#2f9c94', '#c69a5f'],
      luma: 0.2,
      saturation: 'muted',
      temperature: 'cool',
      busyness: 'calm',
    },
  },
];

/** The gradient `tools/png.mjs` later encodes: top→bottom with a soft band. */
export function gradientPaint([top, bottom], band) {
  const lift = (color, by) => color.map((v) => Math.min(255, v + by));
  return (x, y, width, height) => {
    const t = (x / width) * 0.45 + (y / height) * 0.55;
    const inBand = band !== undefined && Math.abs(y - height * 0.62 - Math.sin(x / 70) * 18) < 26;
    const from = inBand ? band : top;
    const to = inBand ? band : lift(top, 26);
    return [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
  };
}
