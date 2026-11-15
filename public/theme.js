// Applies the saved theme before first paint so the page never flashes the wrong one.
// A separate file because the Content-Security-Policy blocks inline scripts.
(function () {
  var t = 'system';
  try { t = JSON.parse(localStorage.getItem('ccstats.ui') || '{}').theme || 'system'; } catch (e) { /* defaults */ }
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
