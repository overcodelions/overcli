// Which window this renderer is.
//
// Every overcli window loads the same bundle; a popped-out one is told what
// to show by its query string (see `createPopoutWindow` in main). Kept free of
// imports so the store can ask without a cycle.

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

/// The terminal id this window was popped out to show, if any.
export const popoutTerminalId: string | null = params.get('terminal');
/// The folder whose explorer this window was popped out to show, if any.
export const popoutExplorerRoot: string | null = params.get('explorer');
/// True in any popped-out window. These hold a slice of the app's state, not
/// all of it, so they must never write the main window's state back to disk.
export const isPopoutWindow = popoutTerminalId !== null || popoutExplorerRoot !== null;
