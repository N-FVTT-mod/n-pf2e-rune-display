import { MODULE_ID, SETTINGS } from "./constants.mjs";

const RUNE_IMPROVE_URL = "https://www.patreon.com/Minstrel_N/posts/n-pf2e-runes-170689136";

export function registerSettings() {
  const definitions = [
    [SETTINGS.showRuneTooltip, "ShowRuneTooltip", true],
    [SETTINGS.showArmorRunesOnCharacterSheet, "ShowArmorRunesOnCharacterSheet", true],
    [SETTINGS.distinguishWeaponArmorColors, "DistinguishWeaponArmorColors", true],
  ];

  for (const [key, label, defaultValue] of definitions) {
    game.settings.register(MODULE_ID, key, {
      name: `NPFRD.Settings.${label}.Name`,
      hint: `NPFRD.Settings.${label}.Hint`,
      scope: "client",
      config: true,
      type: Boolean,
      default: defaultValue,
      onChange: () => Hooks.callAll(`${MODULE_ID}.settingsChanged`, key),
    });
  }
}

export function installRuneImprovePromo(app, html) {
  const root = app?.element ?? html;
  const main = root?.querySelector?.('[data-application-part="main"]');
  if (!main) return;

  const category = [...main.querySelectorAll("[data-category]")]
    .find((element) => element.dataset.category === MODULE_ID)
    ?? main.querySelector(`[data-tab="${MODULE_ID}"]`)
    ?? main.querySelector(`[name="${MODULE_ID}.${SETTINGS.showRuneTooltip}"]`)?.closest("[data-category], [data-tab]");
  if (!category || category.querySelector(".npfrd-lite-promo")) return;

  const banner = document.createElement("a");
  banner.className = "npfrd-lite-promo";
  banner.href = RUNE_IMPROVE_URL;
  banner.target = "_blank";
  banner.rel = "noopener noreferrer";

  for (const key of ["Eyebrow", "Title", "Point1", "Point2", "Cta"]) {
    const element = document.createElement(key.startsWith("Point") ? "strong" : "span");
    element.className = `npfrd-lite-promo__${key.startsWith("Point") ? "point" : key.toLowerCase()}`;
    element.textContent = game.i18n.localize(`NPFRD.Promo.${key}`);
    banner.append(element);
  }
  category.prepend(banner);
}
