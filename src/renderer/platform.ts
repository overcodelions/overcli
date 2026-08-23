export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

/// What the OS calls the thing that shows a file in its folder. The IPC
/// behind it (`shell.showItemInFolder`) is already cross-platform; only the
/// word was hardcoded to macOS.
export function revealLabel(): string {
  if (typeof navigator === 'undefined') return 'Show in folder';
  const platform = navigator.platform.toLowerCase();
  if (/mac|ipod|iphone|ipad/.test(platform)) return 'Show in Finder';
  if (platform.includes('win')) return 'Show in Explorer';
  return 'Show in folder';
}
