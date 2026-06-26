const IDE_STRICT_MODE_PREFIX = 'studio.ide.strict.';

export const isStrictIdeModeEnabled = (rootPath: string | undefined): boolean => {
  if (!rootPath) return false;

  try {
    return localStorage.getItem(IDE_STRICT_MODE_PREFIX + rootPath) === '1';
  } catch {
    return false;
  }
};

export const setStrictIdeModeEnabled = (rootPath: string, enabled: boolean): void => {
  try {
    if (enabled) {
      localStorage.setItem(IDE_STRICT_MODE_PREFIX + rootPath, '1');
      return;
    }

    localStorage.removeItem(IDE_STRICT_MODE_PREFIX + rootPath);
  } catch {}
};
