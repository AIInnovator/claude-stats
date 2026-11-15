// Single source for chart colours, one validated set per theme. Checked by scripts/check-palette.mjs.
// Categorical slots keep the same hue in both themes, so an entity looks like itself after a theme switch.
// Models get a stable slot so a colour never jumps when the filter changes; a 9th series folds into "Other".
export const MODEL_ORDER = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5-1', 'claude-opus-5'];

export const PALETTES = {
  dark: {
    SURFACE: '#0c0d10',
    CATEGORICAL: ['#e2794f', '#4ea3f0', '#d9b23a', '#6ee1d5', '#53ac8d', '#9050d3', '#e66b95', '#9bcf5a'],
    OTHER: '#5d6068',
    TOKEN_COLORS: { out: '#e2794f', in: '#4ea3f0', cw: '#d9b23a', cr: '#6b7384' },
    SEQUENTIAL: ['#1a1412', '#3a2219', '#5c3121', '#83432b', '#ad5a38', '#d77749', '#f1a074'], // rises in lightness
    STATUS: { good: '#4cc38a', warning: '#e9a23b', critical: '#ef5f5f' },
  },
  light: {
    SURFACE: '#ffffff',
    CATEGORICAL: ['#c4572c', '#2f7fd0', '#a37a06', '#0fa196', '#2e503e', '#6e3e91', '#c2416f', '#5b8a1c'],
    OTHER: '#9a9da5',
    TOKEN_COLORS: { out: '#c4572c', in: '#2f7fd0', cw: '#a37a06', cr: '#8790a0' },
    SEQUENTIAL: ['#f6ece6', '#f0d3c4', '#e7b096', '#dc8b66', '#cb6a3e', '#a94e24', '#7d3614'], // falls in lightness
    STATUS: { good: '#1f9a5f', warning: '#b46b00', critical: '#d43c3c' },
  },
};
