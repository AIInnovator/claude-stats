// Colour checks for public/palette.js, per theme: contrast vs that theme's surface, adjacent-pair separation in
// OKLab (x100) under normal vision and simulated protan/deutan/tritan (Machado 2009, severity 1), and a monotonic
// sequential ramp. Run: node scripts/check-palette.mjs
import { PALETTES } from '../public/palette.js';

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = h => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const M = {
  normal: null,
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
function oklab(h, mode) {
  let rgb = hex(h).map(lin);
  if (M[mode]) rgb = M[mode].map(row => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
  const [r, g, b] = rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dE = (a, b, mode) => { const p = oklab(a, mode), q = oklab(b, mode); return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
for (const [theme, P] of Object.entries(PALETTES)) {
  console.log(`\n${theme}: categorical on ${P.SURFACE}`);
  for (const c of [...P.CATEGORICAL, ...Object.values(P.TOKEN_COLORS)]) report(contrast(c, P.SURFACE) >= 3, `${c} contrast ${contrast(c, P.SURFACE).toFixed(2)} (>= 3)`);
  for (let i = 0; i < P.CATEGORICAL.length - 1; i++) {
    const a = P.CATEGORICAL[i], b = P.CATEGORICAL[i + 1];
    const n = dE(a, b, 'normal'), cvd = Math.min(dE(a, b, 'protan'), dE(a, b, 'deutan'), dE(a, b, 'tritan'));
    report(n >= 15 && cvd >= 8, `${a} | ${b}  normal ${n.toFixed(1)} (>= 15)  worst CVD ${cvd.toFixed(1)} (>= 8)`);
  }
  const L = P.SEQUENTIAL.map(c => oklab(c, 'normal')[0]);
  const rising = theme === 'dark'; // the ramp moves away from the surface: up on dark, down on light
  report(L.every((v, i) => !i || (rising ? v > L[i - 1] : v < L[i - 1])), `sequential ${rising ? 'rises' : 'falls'}: ` + L.map(v => v.toFixed(2)).join(' '));
  for (const [k, c] of Object.entries(P.STATUS)) report(contrast(c, P.SURFACE) >= 3, `status ${k} ${c} contrast ${contrast(c, P.SURFACE).toFixed(2)}`);
}
console.log(fails ? `\npalette FAIL (${fails})` : '\npalette PASS');
process.exit(fails ? 1 : 0);
