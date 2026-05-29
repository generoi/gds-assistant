/**
 * Pure helpers for persisting and applying the assistant panel's
 * size + position. Lives outside React because we both read these on
 * mount (synchronous defaults) and use them in DOM-level overrides of
 * Radix's transform positioning.
 *
 * Why the override exists:
 *   Radix uses `Object.assign(node.style, {transform: '...', left: '...'})`
 *   on every autoUpdate tick. `Object.assign` wipes any !important flags we
 *   set via setProperty — so a plain `setProperty('transform', 'none',
 *   'important')` doesn't stick. We win by using CSS `!important` in a
 *   stylesheet (which beats Radix's inline style) combined with CSS custom
 *   properties for the values (CSS vars set via React's `style` prop
 *   survive across Radix's tick).
 *
 *   Radix also wraps Content in `<div data-radix-popper-content-wrapper>`
 *   that itself has transform. When a parent has transform, our
 *   `position: fixed` becomes relative to the wrapper, not the viewport —
 *   so we tag the wrapper too.
 */

/**
 * Read persisted panel size from localStorage, guarding against stale or
 * out-of-bounds values (user resized their window smaller, changed monitors,
 * etc.). Falls back to null → CSS defaults apply.
 */
export function getStoredPanelSize() {
  try {
    const raw = localStorage.getItem("gds-assistant-panel-size");
    if (!raw) {
      return null;
    }
    const { width, height } = JSON.parse(raw);
    const maxW = window.innerWidth - 48;
    const maxH = window.innerHeight - 120;
    if (typeof width !== "number" || typeof height !== "number") {
      return null;
    }
    return {
      width: Math.max(320, Math.min(maxW, width)),
      height: Math.max(400, Math.min(maxH, height)),
    };
  } catch {
    return null;
  }
}

/**
 * Read persisted panel position (top/left in px). Returns null to keep
 * the CSS default (bottom-right anchored). Clamps to keep the panel
 * on-screen after window resizes / monitor changes (40px sliver always
 * grabbable).
 */
export function getStoredPanelPosition() {
  try {
    const raw = localStorage.getItem("gds-assistant-panel-position");
    if (!raw) {
      return null;
    }
    const { top, left } = JSON.parse(raw);
    if (typeof top !== "number" || typeof left !== "number") {
      return null;
    }
    return {
      top: Math.max(0, Math.min(window.innerHeight - 40, top)),
      left: Math.max(0, Math.min(window.innerWidth - 40, left)),
    };
  } catch {
    return null;
  }
}

/**
 * Set the panel's position CSS custom properties on the Radix Content node
 * (and tag its wrapper so our flattening stylesheet kicks in). Called from
 * the AssistantModal's drag-end handler.
 * @param node
 * @param top
 * @param left
 */
export function applyPanelPosition(node, top, left) {
  if (!node) {
    return;
  }
  node.style.setProperty("--gds-panel-top", `${top}px`);
  node.style.setProperty("--gds-panel-left", `${left}px`);
  const wrapper = node.closest("[data-radix-popper-content-wrapper]");
  if (wrapper) {
    wrapper.classList.add("gds-assistant__panel-wrapper--moved");
  }
}

/**
 * Reverse of {@link applyPanelPosition} — drop our overrides so CSS defaults
 * (bottom-right anchored) take over again. Used when the user "resets
 * position" or closes the panel.
 * @param node
 */
export function clearPanelPosition(node) {
  if (!node) {
    return;
  }
  node.style.removeProperty("--gds-panel-top");
  node.style.removeProperty("--gds-panel-left");
  const wrapper = node.closest("[data-radix-popper-content-wrapper]");
  if (wrapper) {
    wrapper.classList.remove("gds-assistant__panel-wrapper--moved");
  }
}
