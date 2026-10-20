import { MODULE_ID } from "./constants.mjs";
import { registerSettings, installRuneImprovePromo } from "./settings.mjs";
import { initPF2eRuneDisplay, applyRuneColorMode, refreshRuneDisplay } from "./rune-display.mjs";

Hooks.once("init", () => {
  if (game.system.id !== "pf2e") return;

  registerSettings();
  initPF2eRuneDisplay();
  Hooks.on("renderSettingsConfig", installRuneImprovePromo);
  Hooks.on(`${MODULE_ID}.settingsChanged`, () => {
    applyRuneColorMode();
    if (game.ready) refreshRuneDisplay();
  });
});
