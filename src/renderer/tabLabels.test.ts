import { describe, expect, it } from 'vitest';
import { fileName, tabLabels } from './tabLabels';

describe('fileName', () => {
  it('takes the last segment of posix and windows paths', () => {
    expect(fileName('/repo/src/main/index.ts')).toBe('index.ts');
    expect(fileName('C:\\repo\\src\\index.ts')).toBe('index.ts');
    expect(fileName('README.md')).toBe('README.md');
  });
});

describe('tabLabels', () => {
  it('uses bare file names when they are unique', () => {
    expect(tabLabels(['/repo/a.ts', '/repo/deep/b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('adds one directory level only for the names that collide', () => {
    expect(
      tabLabels(['/repo/main/index.ts', '/repo/preload/index.ts', '/repo/store.ts']),
    ).toEqual(['main/index.ts', 'preload/index.ts', 'store.ts']);
  });

  it('falls back to the bare name when there is no parent directory', () => {
    expect(tabLabels(['index.ts', '/repo/main/index.ts'])).toEqual(['index.ts', 'main/index.ts']);
  });
});
