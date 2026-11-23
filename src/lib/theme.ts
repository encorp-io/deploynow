export const THEME_KEY = "dn-theme";

/** Runs before first paint (inlined in layout.tsx) so the page never flashes the wrong theme. */
export const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_KEY}")||"dark";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){document.documentElement.classList.add("dark");}})();`;
