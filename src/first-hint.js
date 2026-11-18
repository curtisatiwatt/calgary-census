/**
 * One line for a first visit, saying what the map responds to. It is shown only when the page
 * opens with nothing chosen, leaves at the first real action and does not come back on this device.
 */
export const HINT_STORAGE_KEY = 'census-atlas-hint-seen';

/**
 * @param {HTMLElement} node the hint, hidden in the page until `show()`
 * @param {{ storage?: Storage, root?: EventTarget, controls?: string }} [options]
 *   `controls` is a selector for the interface around the map: using any of it dismisses the hint.
 */
export function createFirstHint(node, options = {}) {
  const { root = globalThis.document, controls = '.app-header, .viewbar' } = options;
  const storage = () => options.storage ?? globalThis.localStorage;
  let showing = false;

  function seen() {
    try {
      return storage().getItem(HINT_STORAGE_KEY) === '1';
    } catch {
      // Storage can be switched off; the hint is then simply shown again next time.
      return false;
    }
  }
  function dismiss() {
    if (!showing) return;
    showing = false;
    node.hidden = true;
    try {
      storage().setItem(HINT_STORAGE_KEY, '1');
    } catch {
      /* Private mode may disable storage. */
    }
  }
  const onControl = event => {
    if (showing && event.target?.closest?.(controls)) dismiss();
  };
  root?.addEventListener('pointerdown', onControl, true);
  root?.addEventListener('focusin', onControl);

  return {
    /** Show the hint unless this device has already seen it go. */
    show() {
      if (showing || seen()) return;
      showing = true;
      node.hidden = false;
    },
    dismiss,
    isShowing: () => showing,
  };
}
