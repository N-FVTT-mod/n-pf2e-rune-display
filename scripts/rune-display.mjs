// src/pf2e-rune-display.mjs

import { MODULE_ID, SETTINGS } from "./constants.mjs";

const DISPLAY_TAG_CLASS = "npfrd-property-rune-tag";
const TOOLTIP_CLASS = "npfrd-rune-tooltip";
const ARMOR_RUNE_SECTION_CLASS = "npfrd-armor-rune-section";
const ARMOR_RUNE_TAGS_CLASS = "npfrd-armor-rune-tags";
const NPC_ARMOR_RUNE_SECTION_CLASS = "npfrd-npc-armor-rune-section";
const NPC_ARMOR_RUNE_TAGS_CLASS = "npfrd-npc-armor-rune-tags";
const SUPPORTED_ITEM_TYPES = ["weapon", "armor"];

let runeStoneIndexPromise = null;
const runeDescriptionCache = new Map();
const actorInventoryObservers = new WeakMap();
const runeTooltipPromises = new WeakMap();

function isPF2eSystem() {
  return game?.system?.id === "pf2e";
}

function getSetting(key, fallback = false) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function areTooltipsEnabled() {
  return getSetting(SETTINGS.showRuneTooltip, true) === true;
}

function showArmorRunesOnCharacterSheet() {
  return getSetting(SETTINGS.showArmorRunesOnCharacterSheet, true) === true;
}

function getRootElement(html) {
  if (html instanceof HTMLElement) return html;
  return html?.[0] instanceof HTMLElement ? html[0] : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ");
}

function normalizeRuneKey(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function toEnglishWords(slug) {
  return String(slug ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
}

function startsWithNameBoundary(name, prefix) {
  if (!name.startsWith(prefix) || name === prefix) return false;
  const next = name.slice(prefix.length, prefix.length + 1);
  return /[\s（(【\[—–\-:：]/u.test(next);
}

function getSystemRuneLabel(type, slug) {
  const key = type === "weapon"
    ? `PF2E.WeaponPropertyRune.${slug}.Name`
    : `PF2E.ArmorPropertyRune${String(slug).charAt(0).toUpperCase()}${String(slug).slice(1)}`;

  if (game.i18n.has(key)) return game.i18n.localize(key);
  return toEnglishWords(slug) || String(slug ?? "");
}

function getRuneImproveCustomRunes(item) {
  const module = game?.modules?.get?.("n-pf2-runes-improve");
  const getter = module?.active ? module.api?.getSelectedCustomRunes : null;
  if (typeof getter !== "function") return [];

  try {
    const selected = getter.call(module.api, item);
    if (!Array.isArray(selected)) return [];

    return selected.map((entry, index) => {
      const definition = entry?.definition ?? entry?.rune ?? entry;
      const label = String(
        definition?.name
          ?? definition?.label
          ?? definition?.title
          ?? entry?.name
          ?? entry?.label
          ?? ""
      ).trim();
      const id = String(
        definition?.uid
          ?? definition?.id
          ?? definition?.slug
          ?? entry?.uid
          ?? entry?.id
          ?? entry?.slug
          ?? `${label}-${index}`
      );
      return {
        id,
        label,
        slug: String(definition?.slug ?? entry?.slug ?? ""),
        usage: String(definition?.usage ?? entry?.usage ?? ""),
      };
    }).filter((rune) => rune.label);
  } catch (error) {
    console.warn(`[${MODULE_ID}] 无法读取 N PF2E Runes Improve 的自定义符文：`, error);
    return [];
  }
}

function getDisplayedPropertyRunes(item) {
  if (!item?.isOfType?.(...SUPPORTED_ITEM_TYPES)) return [];

  const type = item.type;
  const systemRunes = Array.isArray(item.system?.runes?.property) ? item.system.runes.property : [];
  const customRunes = getRuneImproveCustomRunes(item);
  const result = [];
  const labels = new Set();

  for (const slug of systemRunes) {
    if (!slug) continue;
    const label = getSystemRuneLabel(type, slug);
    const normalizedLabel = normalizeText(label);
    if (!normalizedLabel || labels.has(normalizedLabel)) continue;
    labels.add(normalizedLabel);
    result.push({
      key: `system:${type}:${slug}`,
      type,
      slug,
      label,
      usage: "",
      custom: false,
    });
  }

  for (const rune of customRunes) {
    const label = String(rune.label ?? "").trim();
    const normalizedLabel = normalizeText(label);
    if (!label || labels.has(normalizedLabel)) continue;
    labels.add(normalizedLabel);
    result.push({
      key: `custom:${type}:${rune.id}`,
      type,
      slug: rune.slug || null,
      label,
      usage: String(rune.usage ?? ""),
      custom: true,
    });
  }

  return result;
}

function getWorldItemCandidates() {
  return (game?.items?.contents ?? []).map((item) => ({
    name: item.name,
    type: item.type,
    slug: item.system?.slug ?? item.slug ?? null,
    sourceRank: 0,
    load: async () => item,
  }));
}

async function getCompendiumItemCandidates() {
  const candidates = [];
  const packs = [...(game?.packs?.values?.() ?? [])].filter((pack) => pack.documentName === "Item");

  for (const pack of packs) {
    try {
      const index = await pack.getIndex({ fields: ["name", "type", "system.slug"] });
      for (const entry of index) {
        candidates.push({
          name: entry.name,
          type: entry.type,
          slug: entry.system?.slug ?? null,
          sourceRank: pack.collection === "pf2e.equipment-srd" ? 1 : 2,
          load: async () => pack.getDocument(entry._id),
        });
      }
    } catch (error) {
      console.warn(`[N PF2E Rune Display]  无法读取物品合集索引 ${pack.collection}：`, error);
    }
  }

  return candidates;
}

async function getRuneStoneIndex() {
  runeStoneIndexPromise ??= (async () => [
    ...getWorldItemCandidates(),
    ...await getCompendiumItemCandidates(),
  ])();
  return runeStoneIndexPromise;
}

function candidateMatchScore(candidate, rune) {
  const name = normalizeText(candidate.name);
  const label = normalizeText(rune.label);
  if (!name || !label) return Infinity;

  let score = Infinity;

  if (name === label) score = 0;
  else if (startsWithNameBoundary(name, label)) score = 10;

  if (!rune.custom && rune.slug) {
    const runeKey = normalizeRuneKey(rune.slug);
    const itemSlugKey = normalizeRuneKey(candidate.slug);
    if (itemSlugKey && itemSlugKey === runeKey) score = Math.min(score, 20);

    const englishName = normalizeText(toEnglishWords(rune.slug));
    if (englishName) {
      if (name === englishName) score = Math.min(score, 30);
      else if (startsWithNameBoundary(name, englishName)) score = Math.min(score, 35);
      else {
        const words = englishName.split(" ").filter(Boolean);
        if (words.length > 0 && words.every((word) => name.includes(word))) {
          score = Math.min(score, 40);
        }
      }
    }
  }

  if (!Number.isFinite(score)) return score;

  if (candidate.type === "equipment") score -= 2;
  else score += 25;
  return score + candidate.sourceRank / 10;
}

async function findRuneStone(rune) {
  const candidates = await getRuneStoneIndex();
  const matches = candidates
    .map((candidate) => ({ candidate, score: candidateMatchScore(candidate, rune) }))
    .filter((match) => Number.isFinite(match.score))
    .sort((a, b) => a.score - b.score);

  const best = matches[0];
  if (!best) return null;

  try {
    return await best.candidate.load();
  } catch (error) {
    console.warn(`[N PF2E Rune Display]  无法载入符文石“${best.candidate.name}”：`, error);
    return null;
  }
}

async function getItemDescriptionHTML(item) {
  if (!item) return "";

  try {
    if (typeof item.getDescription === "function") {
      const description = await item.getDescription({
        includeAddendum: false,
        secrets: false,
      });
      if (description?.value) return description.value;
    }
  } catch (error) {
    console.warn(`[N PF2E Rune Display]  无法读取“${item.name}”的描述：`, error);
  }

  return String(item.system?.description?.value ?? "");
}

async function resolveRuneDescription(rune) {
  if (runeDescriptionCache.has(rune.key)) return runeDescriptionCache.get(rune.key);

  const promise = (async () => {
    const runeStone = await findRuneStone(rune);
    if (!runeStone) return null;

    const description = await getItemDescriptionHTML(runeStone);
    if (!description) return null;

    return {
      itemName: runeStone.name,
      description,
    };
  })();

  runeDescriptionCache.set(rune.key, promise);
  return promise;
}

function getRuneUsageHTML(rune) {
  const usage = String(rune?.usage ?? "").trim();
  if (!rune?.custom || !usage) return "";
  return foundry.utils.escapeHTML(usage).replace(/\r?\n/g, "<br>");
}

function buildTooltipHTML(data, rune) {
  const title = foundry.utils.escapeHTML(data.itemName);
  const usage = getRuneUsageHTML(rune);
  const usageBlock = usage
    ? `<div class="npfrd-rune-tooltip-usage"><strong>使用方式</strong><div>${usage}</div></div><div class="npfrd-rune-tooltip-divider" aria-hidden="true"></div>`
    : "";
  return `<div class="npfrd-rune-tooltip-content">${usageBlock}<strong class="npfrd-rune-tooltip-title">${title}</strong><div class="npfrd-rune-tooltip-description">${data.description}</div></div>`;
}

function prepareRuneTooltip(tag, rune) {
  if (tag.dataset.npfrdRuneTooltipReady === "true") return Promise.resolve();

  const existing = runeTooltipPromises.get(tag);
  if (existing) return existing;

  const promise = (async () => {
    const data = await resolveRuneDescription(rune);

    if (!data) {
      const usage = getRuneUsageHTML(rune);
      if (usage) {
        delete tag.dataset.tooltipText;
        tag.dataset.tooltipHtml = buildTooltipHTML({
          itemName: rune.label,
          description: `<p class="npfrd-rune-tooltip-missing">未找到“${foundry.utils.escapeHTML(rune.label)}”对应的符文石描述。</p>`,
        }, rune);
      } else {
        delete tag.dataset.tooltipHtml;
        tag.dataset.tooltipText = `未找到“${rune.label}”对应的符文石描述。`;
      }
    } else {
      delete tag.dataset.tooltipText;
      tag.dataset.tooltipHtml = buildTooltipHTML(data, rune);
    }

    tag.dataset.npfrdRuneTooltipReady = "true";
  })();

  runeTooltipPromises.set(tag, promise);
  return promise;
}

function attachRuneTooltip(tag, rune) {
  // Keep the existing eager description preparation: some Foundry/PF2E tooltip
  // lifecycles fail to populate reliably when the description is first loaded
  // only after pointerenter. The setting controls visibility, not preload timing.
  const enabled = areTooltipsEnabled();
  if (enabled) {
    tag.dataset.tooltipClass = TOOLTIP_CLASS;
    tag.addEventListener("pointerenter", () => {
      if (tag.dataset.npfrdRuneTooltipReady === "true") return;

      void prepareRuneTooltip(tag, rune).then(() => {
        if (tag.matches(":hover") && (tag.dataset.tooltipHtml || tag.dataset.tooltipText)) {
          game.tooltip?.activate?.(tag);
        }
      });
    }, { passive: true });
  }

  void prepareRuneTooltip(tag, rune).then(() => {
    if (!enabled) {
      delete tag.dataset.tooltipHtml;
      delete tag.dataset.tooltipText;
      delete tag.dataset.tooltipClass;
    }
  });
}

function matchRuneTagMetrics(tag, referenceTag, { matchRenderedWidth = false } = {}) {
  if (!(referenceTag instanceof HTMLElement)) return;

  const boxStyle = getComputedStyle(referenceTag);
  const boxProperties = [
    "box-sizing",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ];

  for (const property of boxProperties) {
    const value = boxStyle.getPropertyValue(property);
    if (value) tag.style.setProperty(property, value, "important");
  }

  // Tagify applies the visible typeface to its inner text element rather than the
  // outer <tag> box. Read that element directly so the injected rune tag uses the
  // exact same font as the neighbouring PF2e trait tags.
  const referenceText = referenceTag.querySelector(".tagify__tag-text, [class*='tag-text']")
    ?? referenceTag;
  const textStyle = getComputedStyle(referenceText);
  for (const property of [
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-transform",
  ]) {
    const value = textStyle.getPropertyValue(property);
    if (value) tag.style.setProperty(property, value, "important");
  }

  // These rune tags are inserted outside the original PF2e tag container in some
  // contexts, so selector-based PF2e sizing rules do not apply to them. Copy the
  // rendered box size instead of relying on computed `height: auto`, and give short
  // two-character rune names the same visual footprint as ordinary PF2e tags.
  const rect = referenceTag.getBoundingClientRect();
  if (rect.height > 0) {
    const height = `${rect.height}px`;
    const minimumWidth = matchRenderedWidth && rect.width > 0
      ? `${Math.ceil(rect.width)}px`
      : `${Math.ceil(rect.height * 1.5)}px`;
    tag.style.setProperty("height", height, "important");
    tag.style.setProperty("min-height", height, "important");
    tag.style.setProperty("min-width", minimumWidth, "important");
    tag.style.setProperty("justify-content", "center", "important");
  }
}

function createRuneTag(rune, referenceTag = null, { cloneReference = false, matchRenderedWidth = false, tagName = "span" } = {}) {
  const tag = cloneReference && referenceTag instanceof HTMLElement
    ? referenceTag.cloneNode(false)
    : document.createElement(tagName);

  if (cloneReference) {
    for (const attribute of [...tag.attributes]) {
      if (attribute.name !== "class" && attribute.name !== "style") tag.removeAttribute(attribute.name);
    }
  }

  tag.classList.add("tag", DISPLAY_TAG_CLASS);
  if (rune.type === "weapon" || rune.type === "armor") {
    tag.classList.add(`${DISPLAY_TAG_CLASS}--${rune.type}`);
    tag.dataset.npfrdRuneType = rune.type;
  }
  tag.dataset.npfrdPropertyRune = rune.key;
  tag.textContent = rune.label;

  if (!cloneReference) {
    matchRuneTagMetrics(tag, referenceTag, { matchRenderedWidth });
  }

  attachRuneTooltip(tag, rune);
  return tag;
}

function getDirectRuneTags(container) {
  return [...container.children].filter((element) => element.classList?.contains(DISPLAY_TAG_CLASS));
}

function hasSameRuneTags(container, runes) {
  const current = getDirectRuneTags(container);
  if (current.length !== runes.length) return false;
  return current.every((tag, index) => tag.dataset.npfrdPropertyRune === runes[index]?.key);
}

function syncPrependedRuneTags(container, runes) {
  if (!container) return;
  if (hasSameRuneTags(container, runes)) return;

  for (const tag of getDirectRuneTags(container)) tag.remove();
  if (!runes.length) return;

  const isArmorRuneSection = container.classList.contains(ARMOR_RUNE_TAGS_CLASS)
    || container.classList.contains(NPC_ARMOR_RUNE_TAGS_CLASS);
  const fragment = document.createDocumentFragment();
  for (const rune of runes) {
    // PF2E's Immunities list uses <ol class="immunities tags"> with
    // <li class="tag tag_secondary"> entries. Match that markup for the
    // dedicated armor-rune sections so system/UI-theme tag styling applies.
    const tag = createRuneTag(rune, null, { tagName: isArmorRuneSection ? "li" : "span" });
    if (isArmorRuneSection) tag.classList.add("tag_secondary");
    fragment.appendChild(tag);
  }
  container.prepend(fragment);
}

function clearRuneTags(root) {
  for (const tag of root.querySelectorAll(`.${DISPLAY_TAG_CLASS}`)) tag.remove();
}

function injectItemSheetRuneTags(item, root) {
  clearRuneTags(root);

  const runes = getDisplayedPropertyRunes(item);
  if (!runes.length) return;

  const rarityTag = root.querySelector("header .tag.rarity, .sheet-header .tag.rarity, .tag.rarity");
  if (!rarityTag?.parentElement) return;

  const traitTagCandidates = [...root.querySelectorAll(
    "header tagify-tags tag, header .tagify__tag, .sheet-header tagify-tags tag, .sheet-header .tagify__tag"
  )].filter((element) => element instanceof HTMLElement);
  const traitReferenceTag = traitTagCandidates
    .map((element) => ({ element, width: element.getBoundingClientRect().width }))
    .filter(({ width }) => width > 0)
    .sort((a, b) => a.width - b.width)[0]?.element
    ?? [...rarityTag.parentElement.children].find((element) =>
      element !== rarityTag
        && element.classList?.contains("tag")
        && !element.classList.contains(DISPLAY_TAG_CLASS)
    )
    ?? null;

  // Armor headers can legitimately have no ordinary trait tags. In that case the
  // previous code had no sizing reference at all, so armor rune tags fell back to
  // the module's compact CSS while weapon rune tags inherited PF2e's rendered tag
  // dimensions. Use the rarity tag as the armor fallback reference: copy its native
  // header typography/height, but derive only the standard minimum tag footprint
  // instead of copying the rarity control's much wider rendered width.
  const referenceTag = traitReferenceTag ?? rarityTag;
  const matchRenderedWidth = traitReferenceTag !== null;

  let anchor = rarityTag;
  for (const rune of runes) {
    const tag = createRuneTag(rune, referenceTag, { matchRenderedWidth });
    anchor.insertAdjacentElement("afterend", tag);
    anchor = tag;
  }
}

function findVisibleSidebarHeading(container, text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const selector = "h1, h2, h3, h4, h5, h6, header, label, .label, .title, .sidebar-title, .section-title";
  const candidates = [];

  if (container.matches?.(selector) && normalizeText(container.textContent) === normalized) {
    candidates.push(container);
  }

  for (const element of container.querySelectorAll(selector)) {
    if (normalizeText(element.textContent) === normalized) candidates.push(element);
  }

  const visible = candidates
    .filter((element) => element instanceof HTMLElement)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
      const headingTag = /^H[1-6]$/.test(element.tagName) ? 20 : 0;
      const wide = rect.width >= container.getBoundingClientRect().width * 0.55 ? 10 : 0;
      return {
        element,
        score: fontSize + borderBottom * 15 + headingTag + wide,
        area: rect.width * rect.height,
        visible: rect.width > 0 && rect.height > 0,
      };
    })
    .filter((entry) => entry.visible)
    .sort((a, b) => b.score - a.score || b.area - a.area);

  return visible[0]?.element ?? null;
}

function replaceHeadingText(heading, oldText, newText) {
  const normalizedOld = normalizeText(oldText);

  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const exact = textNodes.find((node) => normalizeText(node.nodeValue) === normalizedOld);
  if (exact) {
    exact.nodeValue = newText;
    return;
  }

  heading.textContent = newText;
}

function getSidebarSectionShell(sidebar, heading, neighbouringHeading) {
  if (!(sidebar instanceof HTMLElement) || !(heading instanceof HTMLElement)) return null;

  let current = heading;
  let section = heading;

  // The visible heading itself is often only one child inside a themed sidebar
  // section. Walk outward until the next ancestor would also contain the nearby
  // Perception section. The last distinct ancestor is the complete native block
  // whose DOM context the active UI theme actually styles.
  while (current.parentElement && current.parentElement !== sidebar) {
    const parent = current.parentElement;
    if (neighbouringHeading instanceof HTMLElement && parent.contains(neighbouringHeading)) break;
    current = parent;
    section = current;
  }

  return section;
}

function getRelativeElementPath(ancestor, element) {
  if (!(ancestor instanceof HTMLElement) || !(element instanceof HTMLElement) || !ancestor.contains(element)) return null;

  const path = [];
  let current = element;
  while (current !== ancestor) {
    const parent = current.parentElement;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(current));
    current = parent;
  }
  return path;
}

function getElementAtPath(ancestor, path) {
  let current = ancestor;
  for (const index of path ?? []) {
    current = current?.children?.[index] ?? null;
    if (!(current instanceof HTMLElement)) return null;
  }
  return current;
}

function pruneSectionToHeading(section, heading) {
  if (!(section instanceof HTMLElement) || !(heading instanceof HTMLElement) || !section.contains(heading)) return;

  let branch = heading;
  while (branch.parentElement && branch.parentElement !== section) {
    const parent = branch.parentElement;
    for (const child of [...parent.children]) {
      if (child !== branch) child.remove();
    }
    branch = parent;
  }

  if (branch.parentElement === section) {
    for (const child of [...section.children]) {
      if (child !== branch) child.remove();
    }
  }
}

function removeArmorRuneSidebar(root) {
  root.querySelector(`.${ARMOR_RUNE_SECTION_CLASS}`)?.remove();
  root.querySelector(`.${ARMOR_RUNE_TAGS_CLASS}`)?.remove();
}

function forceArmorRuneTagsToOwnRow(tags) {
  if (!(tags instanceof HTMLElement)) return;

  // UI themes may render native sidebar sections as a grid or a horizontal flex row.
  // The rune container is appended to a cloned native section, so explicitly make it
  // occupy the full next row without changing the cloned heading or section styling.
  tags.style.setProperty("display", "flex", "important");
  tags.style.setProperty("flex-wrap", "wrap", "important");
  tags.style.setProperty("width", "100%", "important");
  tags.style.setProperty("min-width", "100%", "important");
  tags.style.setProperty("max-width", "100%", "important");
  tags.style.setProperty("flex", "0 0 100%", "important");
  tags.style.setProperty("flex-basis", "100%", "important");
  tags.style.setProperty("grid-column", "1 / -1", "important");
  tags.style.setProperty("clear", "both", "important");
}

function copySidebarHeadingAppearance(target, reference, sidebar) {
  if (!(target instanceof HTMLElement) || !(reference instanceof HTMLElement)) return;

  const referenceStyle = getComputedStyle(reference);
  for (const property of [
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-transform",
    "color",
    "text-shadow",
  ]) {
    const value = referenceStyle.getPropertyValue(property);
    if (value) target.style.setProperty(property, value, "important");
  }

  // The active UI theme may only style native sidebar headings through parent/
  // descendant selectors. Make the cloned heading a self-contained full-width row
  // so it keeps the native typeface without participating in the sidebar grid.
  target.style.setProperty("display", "block", "important");
  target.style.setProperty("position", "relative", "important");
  target.style.setProperty("width", "100%", "important");
  target.style.setProperty("min-width", "0", "important");
  target.style.setProperty("max-width", "none", "important");
  target.style.setProperty("flex", "none", "important");
  target.style.setProperty("grid-column", "1 / -1", "important");
  target.style.setProperty("writing-mode", "horizontal-tb", "important");
  target.style.setProperty("white-space", "nowrap", "important");

  // Reuse the real divider color/weight when the theme places it on the heading
  // or one of its immediate native wrappers. If the line is selector-generated,
  // fall back to a one-pixel divider in the heading's own text colour.
  let lineSource = reference;
  let lineStyle = referenceStyle;
  let current = reference;
  while (current instanceof HTMLElement && current !== sidebar) {
    const style = getComputedStyle(current);
    if ((Number.parseFloat(style.borderBottomWidth) || 0) > 0) {
      lineSource = current;
      lineStyle = style;
      break;
    }
    current = current.parentElement;
  }

  const borderWidth = Number.parseFloat(lineStyle.borderBottomWidth) || 0;
  target.style.setProperty("border-bottom-width", borderWidth > 0 ? lineStyle.borderBottomWidth : "1px", "important");
  target.style.setProperty("border-bottom-style", borderWidth > 0 ? lineStyle.borderBottomStyle : "solid", "important");
  target.style.setProperty(
    "border-bottom-color",
    borderWidth > 0 ? lineStyle.borderBottomColor : referenceStyle.color,
    "important"
  );

  // Do not inherit a narrow grid-cell width or side margins from the cloned native
  // node. Vertical rhythm remains deliberately light so the block sits between
  // Perception and Initiative like another native sidebar section.
  target.style.setProperty("margin-left", "0", "important");
  target.style.setProperty("margin-right", "0", "important");
}

function createArmorRuneSidebarSection(sidebar) {
  const initiativeText = game.i18n.localize("PF2E.InitiativeLabel");
  const perceptionText = game.i18n.localize("PF2E.PerceptionLabel");

  const initiativeHeading = findVisibleSidebarHeading(sidebar, initiativeText);
  const perceptionHeading = findVisibleSidebarHeading(sidebar, perceptionText);
  const referenceHeading = initiativeHeading ?? perceptionHeading;
  if (!(referenceHeading instanceof HTMLElement)) return null;

  const referenceText = initiativeHeading ? initiativeText : perceptionText;

  // v1.9-v1.11 proved that the visible native heading can be identified reliably,
  // but reusing its surrounding UI-theme layout also reuses that layout's grid
  // columns. That is why the rune label kept sharing a row with the title and, in
  // v1.11, even squeezed the title into a vertical column. Keep only the native
  // heading appearance and place both title and runes inside our own simple block.
  const section = document.createElement("div");
  section.classList.add(ARMOR_RUNE_SECTION_CLASS);
  section.style.setProperty("display", "block", "important");
  section.style.setProperty("position", "relative", "important");
  section.style.setProperty("box-sizing", "border-box", "important");
  section.style.setProperty("width", "100%", "important");
  section.style.setProperty("min-width", "0", "important");
  section.style.setProperty("max-width", "100%", "important");
  section.style.setProperty("flex", "0 0 100%", "important");
  section.style.setProperty("grid-column", "1 / -1", "important");
  section.style.setProperty("clear", "both", "important");
  section.style.setProperty("margin", "0", "important");
  section.style.setProperty("padding", "0", "important");

  const heading = referenceHeading.cloneNode(true);
  heading.classList.add("npfrd-armor-rune-heading");
  for (const element of [heading, ...heading.querySelectorAll("[id], [data-action]")]) {
    element.removeAttribute?.("id");
    element.removeAttribute?.("data-action");
  }
  replaceHeadingText(
    heading,
    referenceText,
    game.i18n.localize("NPFRD.Labels.ArmorRunes")
  );
  copySidebarHeadingAppearance(heading, referenceHeading, sidebar);

  const tags = document.createElement("ol");
  tags.classList.add(ARMOR_RUNE_TAGS_CLASS, "tags");
  tags.style.setProperty("display", "flex", "important");
  tags.style.setProperty("flex-wrap", "wrap", "important");
  tags.style.setProperty("align-items", "center", "important");
  tags.style.setProperty("justify-content", "flex-start", "important");
  tags.style.setProperty("gap", "0.25rem", "important");
  tags.style.setProperty("box-sizing", "border-box", "important");
  tags.style.setProperty("width", "100%", "important");
  tags.style.setProperty("min-width", "0", "important");
  tags.style.setProperty("max-width", "100%", "important");
  tags.style.setProperty("grid-column", "1 / -1", "important");
  tags.style.setProperty("flex", "none", "important");
  tags.style.setProperty("clear", "both", "important");
  tags.style.setProperty("margin", "0.2rem 0 0", "important");

  section.append(heading, tags);

  const perceptionShell = perceptionHeading
    ? getSidebarSectionShell(sidebar, perceptionHeading, initiativeHeading)
    : null;
  const insertionAnchor = perceptionShell instanceof HTMLElement && perceptionShell !== sidebar
    ? perceptionShell
    : perceptionHeading ?? referenceHeading;
  insertionAnchor.insertAdjacentElement("beforebegin", section);

  return { section, tags };
}

function syncActorArmorRuneSidebar(actor, root) {
  const existingHeading = root.querySelector(`.${ARMOR_RUNE_SECTION_CLASS}`);
  const existingTags = root.querySelector(`.${ARMOR_RUNE_TAGS_CLASS}`);
  if (!showArmorRunesOnCharacterSheet()) {
    removeArmorRuneSidebar(root);
    return;
  }

  const armor = getActorWornArmor(actor);
  const runes = armor ? getDisplayedPropertyRunes(armor) : [];
  if (!runes.length) {
    removeArmorRuneSidebar(root);
    return;
  }

  const sidebar = root.querySelector(".sidebar, .sheet-sidebar");
  if (!sidebar) {
    removeArmorRuneSidebar(root);
    return;
  }

  let tags = existingTags;
  if (!existingHeading || !tags) {
    removeArmorRuneSidebar(root);
    const created = createArmorRuneSidebarSection(sidebar);
    tags = created?.tags ?? null;
  }
  if (!tags) return;

  syncPrependedRuneTags(tags, runes);
}

function syncActorRuneDisplay(actor, root) {
  syncActorInventoryRuneTags(actor, root);

  if (actor?.type === "character") {
    syncActorArmorRuneSidebar(actor, root);
    removeNPCArmorRuneSection(root);
  } else if (actor?.type === "npc") {
    removeArmorRuneSidebar(root);
    syncNPCArmorRuneSection(actor, root);
  }
}

function syncActorInventoryRuneTags(actor, root) {
  const rows = root.querySelectorAll("li[data-item-id]");

  for (const row of rows) {
    const summary = row.querySelector(":scope > .item-summary, .item-summary");
    if (!summary) continue;

    const tags = summary.querySelector(".tags");
    if (!tags) continue;

    const itemId = row.dataset.itemId;
    const item = itemId ? actor.items?.get(itemId) : null;
    const runes = item?.isOfType?.(...SUPPORTED_ITEM_TYPES)
      ? getDisplayedPropertyRunes(item)
      : [];

    syncPrependedRuneTags(tags, runes);
  }
}

function setupActorInventoryObserver(actor, root) {
  const previous = actorInventoryObservers.get(root);
  previous?.disconnect();

  let scheduled = false;
  const synchronize = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      syncActorRuneDisplay(actor, root);
    });
  };

  const observer = new MutationObserver(synchronize);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  actorInventoryObservers.set(root, observer);

  synchronize();
}

function getActorWornArmor(actor) {
  if (!actor) return null;
  if (actor.wornArmor?.isOfType?.("armor")) return actor.wornArmor;
  return actor.itemTypes?.armor?.find((armor) => armor.isEquipped) ?? null;
}


function getNPCArmorClassLabelCandidates() {
  const candidates = [
    game.i18n.localize("PF2E.ArmorClassLabel"),
    "AC",
    "防护等级",
  ];
  return candidates.map(normalizeText).filter(Boolean);
}

function findNPCArmorClassField(root) {
  return root.querySelector([
    "input[name='system.attributes.ac.value']",
    "input[data-property='system.attributes.ac.value']",
    "input[data-path='system.attributes.ac.value']",
    "[data-edit='system.attributes.ac.value']",
    "[data-property='system.attributes.ac.value']",
    "[data-statistic='ac'] input",
    ".armor-class input",
    ".ac input",
  ].join(", "));
}

function elementContainsArmorClassLabel(element) {
  if (!(element instanceof HTMLElement)) return false;
  const text = normalizeText(element.textContent);
  if (!text) return false;
  return getNPCArmorClassLabelCandidates().some((label) => text === label || text.startsWith(`${label} `));
}

function findNPCArmorClassRow(root) {
  const sidebar = root.querySelector(".sidebar, .sheet-sidebar") ?? root;
  const field = findNPCArmorClassField(root);

  if (field instanceof HTMLElement) {
    const preferred = field.closest([
      ".armor-class",
      ".ac",
      ".statistic",
      ".attribute",
      ".form-group",
      "li",
    ].join(", "));
    if (preferred instanceof HTMLElement && sidebar.contains(preferred)) {
      return { row: preferred, field };
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    let current = field.parentElement;
    let best = null;
    while (current instanceof HTMLElement && current !== sidebar && sidebar.contains(current)) {
      const rect = current.getBoundingClientRect();
      const controls = current.querySelectorAll("input, select, textarea").length;
      const text = normalizeText(current.textContent);
      const hasACText = getNPCArmorClassLabelCandidates().some((label) => text.includes(label));
      const reasonableHeight = rect.height > 0 && rect.height <= 120;
      const reasonableWidth = rect.width > 0 && rect.width >= Math.min(90, sidebarRect.width * 0.3);
      if (reasonableHeight && reasonableWidth && controls <= 3) {
        const score = (hasACText ? 50 : 0) + Math.min(rect.width, sidebarRect.width) / 20 - rect.height / 20;
        if (!best || score > best.score) best = { row: current, field, score };
      }
      current = current.parentElement;
    }
    if (best) return { row: best.row, field };
  }

  const labelSelectors = "label, h1, h2, h3, h4, h5, h6, .label, .title, strong, span";
  const labels = [...sidebar.querySelectorAll(labelSelectors)]
    .filter((element) => element instanceof HTMLElement && elementContainsArmorClassLabel(element));
  for (const label of labels) {
    const row = label.closest(".armor-class, .ac, .statistic, .attribute, .form-group, li, section")
      ?? label.parentElement;
    if (row instanceof HTMLElement && sidebar.contains(row)) return { row, field: null };
  }

  return null;
}

function sanitizeClonedNPCArmorRuneSection(section) {
  for (const element of [section, ...section.querySelectorAll("*")]) {
    if (!(element instanceof HTMLElement)) continue;
    element.removeAttribute("id");
    element.removeAttribute("name");
    element.removeAttribute("data-action");
    element.removeAttribute("data-edit");
    element.removeAttribute("data-property");
    element.removeAttribute("data-path");
    element.removeAttribute("data-statistic");
    element.removeAttribute("data-tooltip");
    element.removeAttribute("data-tooltip-html");
    element.removeAttribute("data-tooltip-text");
  }
}

function replaceNPCArmorClassLabel(section) {
  const newText = game.i18n.localize("NPFRD.Labels.ArmorRunes");
  const oldLabels = getNPCArmorClassLabelCandidates();
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  const exact = nodes.find((node) => oldLabels.includes(normalizeText(node.nodeValue)));
  if (exact) {
    exact.nodeValue = newText;
    return;
  }

  const labelElement = [...section.querySelectorAll("label, h1, h2, h3, h4, h5, h6, .label, .title, strong, span")]
    .find((element) => elementContainsArmorClassLabel(element));
  if (labelElement) labelElement.textContent = newText;
  else section.prepend(Object.assign(document.createElement("span"), { textContent: newText }));
}

function createNPCArmorRuneSection(root) {
  const match = findNPCArmorClassRow(root);
  if (!match?.row) return null;

  const { row, field } = match;
  const section = row.cloneNode(true);
  section.classList.add(NPC_ARMOR_RUNE_SECTION_CLASS);
  sanitizeClonedNPCArmorRuneSection(section);
  replaceNPCArmorClassLabel(section);

  const fieldPath = field instanceof HTMLElement ? getRelativeElementPath(row, field) : null;
  const clonedField = fieldPath ? getElementAtPath(section, fieldPath) : null;

  const tags = document.createElement("ol");
  tags.classList.add(NPC_ARMOR_RUNE_TAGS_CLASS, "tags");
  tags.style.setProperty("display", "flex", "important");
  tags.style.setProperty("flex-wrap", "wrap", "important");
  tags.style.setProperty("align-items", "center", "important");
  tags.style.setProperty("justify-content", "flex-start", "important");
  tags.style.setProperty("gap", "0.25rem", "important");
  tags.style.setProperty("min-width", "0", "important");

  if (clonedField instanceof HTMLElement) {
    clonedField.replaceWith(tags);
  } else {
    for (const control of [...section.querySelectorAll("input, select, textarea, button")]) control.remove();
    section.append(tags);
  }

  // Remove any remaining cloned form controls from the AC row. Keeping the native
  // row shell preserves PF2e/UI-theme typography and spacing while the new value
  // cell contains only rune tags.
  for (const control of [...section.querySelectorAll("input, select, textarea, button")]) control.remove();

  row.insertAdjacentElement("afterend", section);
  return tags;
}

function removeNPCArmorRuneSection(root) {
  root.querySelector(`.${NPC_ARMOR_RUNE_SECTION_CLASS}`)?.remove();
}

function syncNPCArmorRuneSection(actor, root) {
  if (!showArmorRunesOnCharacterSheet()) {
    removeNPCArmorRuneSection(root);
    return;
  }

  const armor = getActorWornArmor(actor);
  const runes = armor ? getDisplayedPropertyRunes(armor) : [];
  if (!runes.length) {
    removeNPCArmorRuneSection(root);
    return;
  }

  let section = root.querySelector(`.${NPC_ARMOR_RUNE_SECTION_CLASS}`);
  let tags = section?.querySelector(`.${NPC_ARMOR_RUNE_TAGS_CLASS}`) ?? null;
  if (!(section instanceof HTMLElement) || !(tags instanceof HTMLElement)) {
    removeNPCArmorRuneSection(root);
    tags = createNPCArmorRuneSection(root);
  }
  if (!(tags instanceof HTMLElement)) return;

  syncPrependedRuneTags(tags, runes);
}

function getStrikeSourceWeapon(message) {
  const item = message?.item;
  if (item?.isOfType?.("weapon")) return item;
  if (!item?.isOfType?.("melee")) return null;

  if (item.linkedWeapon?.isOfType?.("weapon")) return item.linkedWeapon;

  const linkedWeaponId = item.flags?.pf2e?.linkedWeapon;
  const linkedWeapon = linkedWeaponId ? message?.actor?.items?.get(linkedWeaponId) : null;
  return linkedWeapon?.isOfType?.("weapon") ? linkedWeapon : null;
}

function injectWeaponRuneTags(item, root) {
  if (!item?.isOfType?.("weapon")) return;

  const runes = getDisplayedPropertyRunes(item);
  if (!runes.length) return;

  const tags = root.querySelector(".message-content .tags, .tags");
  if (!tags) return;

  const fragment = document.createDocumentFragment();
  for (const rune of runes) fragment.appendChild(createRuneTag(rune));
  tags.prepend(fragment);
}

function injectStrikeWeaponRuneTags(message, root) {
  injectWeaponRuneTags(getStrikeSourceWeapon(message), root);
}

function injectDirectWeaponItemRuneTags(message, root) {
  const context = message?.flags?.pf2e?.context;
  if (context) return;

  const item = message?.item;
  if (!item?.isOfType?.("weapon")) return;
  injectWeaponRuneTags(item, root);
}

function injectChatMessageRuneTags(message, root) {
  clearRuneTags(root);

  const context = message?.flags?.pf2e?.context;
  if (context?.type === "attack-roll" && context?.action === "strike") {
    injectStrikeWeaponRuneTags(message, root);
    return;
  }

  injectDirectWeaponItemRuneTags(message, root);
}

function onRenderItemSheetPF2e(app, html) {
  const item = app?.item;
  if (!item?.isOfType?.(...SUPPORTED_ITEM_TYPES)) return;

  const root = getRootElement(html);
  if (!root) return;
  injectItemSheetRuneTags(item, root);
}

function onRenderActorSheetPF2e(app, html) {
  const actor = app?.actor;
  if (!actor || !["character", "npc"].includes(actor.type)) return;

  const root = getRootElement(html);
  if (!root) return;
  setupActorInventoryObserver(actor, root);
}

function onRenderChatMessageHTML(message, html) {
  const root = getRootElement(html);
  if (!root) return;
  injectChatMessageRuneTags(message, root);
}

function invalidateRuneStoneCaches() {
  runeStoneIndexPromise = null;
  runeDescriptionCache.clear();
}

function onItemDocumentChanged(item) {
  if (!item?.parent) invalidateRuneStoneCaches();
}

export function refreshRuneDisplay() {
  for (const tag of document.querySelectorAll(`.${DISPLAY_TAG_CLASS}`)) tag.remove();
  for (const section of document.querySelectorAll(`.${ARMOR_RUNE_SECTION_CLASS}, .${NPC_ARMOR_RUNE_SECTION_CLASS}`)) section.remove();

  for (const app of Object.values(ui?.windows ?? {})) {
    if (app?.item?.isOfType?.(...SUPPORTED_ITEM_TYPES) || ["character", "npc"].includes(app?.actor?.type)) {
      app.render?.(false);
    }
  }

  ui?.chat?.render?.();
}

export function applyRuneColorMode() {
  const enabled = getSetting(SETTINGS.distinguishWeaponArmorColors, true) === true;
  document.documentElement?.classList.toggle("npfrd-distinguish-colors", enabled);
}

export function initPF2eRuneDisplay() {
  if (!isPF2eSystem()) return;

  Hooks.on("renderItemSheetPF2e", onRenderItemSheetPF2e);
  Hooks.on("renderActorSheetPF2e", onRenderActorSheetPF2e);
  Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);

  Hooks.once("ready", () => {
    applyRuneColorMode();
    // Preserve the existing preload/index behavior. Description resolution is
    // intentionally not moved to first hover because that broke tooltip display
    // in the prior implementation.
    void getRuneStoneIndex();
  });

  Hooks.on("createItem", onItemDocumentChanged);
  Hooks.on("updateItem", onItemDocumentChanged);
  Hooks.on("deleteItem", onItemDocumentChanged);
}
