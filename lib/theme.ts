export type ThemePreference = "light" | "dark" | "system";

// No stored value means "system" (follow the device setting).
export const THEME_STORAGE_KEY = "amc-theme";
export const THEME_CHANGE_EVENT = "amc-theme-change";

// Runs synchronously in <head> before first paint so the page never flashes
// the wrong theme. Keep in sync with applyTheme() in
// components/theme/theme-controls.tsx.
export const THEME_INIT_SCRIPT =
  "(function(){try{var p=localStorage.getItem(" +
  JSON.stringify(THEME_STORAGE_KEY) +
  ');var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})()';
