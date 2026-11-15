// $ per million tokens: [input, output, cache read]. Cache writes: 5-minute = 1.25x input, 1-hour = 2x input.
// Source: claude-api skill price table (cached 2026-11-03). Verified 2026-11-12 against Claude Code's own
// `cost-state` totals: ratio 1.000 for opus-5-5, fable-5-2, fable-5, opus-4-8, sonnet-4-6, sonnet-5-5, haiku-5-5.
export const PRICES = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-mythos-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 1],
  'claude-mythos-5-1': [10, 50, 1],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
};
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const WEB_SEARCH = 0.01; // $10 per 1,000 searches

export function priceFor(model) {
  if (!model) return null;
  const id = model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  return PRICES[id] || PRICES[KEYS.find(k => id.startsWith(k))] || null;
}

/** USD for one API call, or -1 when the model has no known price. */
export function costOf(model, t) {
  const p = priceFor(model);
  if (!p) return -1;
  let mult = t.fast ? 2 : 1; // fast mode = 2x standard on every model that offers it
  // shortcut: Haiku 5.5 bills prompts over 100K tokens at 5x; per-call prompt size approximates the API's rule
  if (model.startsWith('claude-haiku-5-5') && t.in + t.cr + t.cw5 + t.cw1 > 100_000) mult *= 5;
  return mult * (t.in * p[0] + t.out * p[1] + t.cr * p[2] + t.cw5 * p[0] * 1.25 + t.cw1 * p[0] * 2) / 1e6 + (t.ws || 0) * WEB_SEARCH;
}
