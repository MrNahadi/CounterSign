// Runs before first paint (DESIGN.md, Theme switching): light unless the visitor chose dark
// or their OS prefers it. Each app inlines it in <head>.
export const themeScript = `(function () {
  var saved = null;
  try { saved = localStorage.getItem("theme"); } catch (e) {}
  var dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
})();`;

// DESIGN.md's Google Fonts link. Loaded as a plain <link> so the family names match the tokens.
export const fontsHref =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=Geist+Mono:wght@400..600&family=Newsreader:opsz,wght@6..72,400..700&display=swap";
