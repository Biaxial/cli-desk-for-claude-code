/** The slice of BrowserWindow this process needs to raise an existing desk. */
export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Raise the already-open window. Returns false when there is nothing to raise yet,
 * so the caller can retry after the first window exists.
 */
export function focusExistingWindow(target: FocusableWindow | undefined): boolean {
  if (!target || target.isDestroyed()) return false;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return true;
}

/** The process that did not get the userData lock must exit before it opens a window. */
export function shouldStartMainWindow(gotLock: boolean): boolean {
  return gotLock;
}
