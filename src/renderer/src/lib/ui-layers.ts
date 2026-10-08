/**
 * The stacking layers the app chrome, dialogs and popups sit on. A dialog's
 * backdrop covers the chrome, and a popup opened from inside a dialog shows
 * over it.
 */
export const UI_LAYERS = {
  /** Menu bar and transport: just above the shared WebGL canvas, below everything that floats. */
  chrome: 100,
  /** Every dialog and its backdrop. */
  modal: 1000,
  /** Dropdowns, menus and popovers, so one opened inside a dialog is not hidden behind it. */
  popup: 1100,
} as const;
