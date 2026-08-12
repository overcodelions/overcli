import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILE_COLOR,
  fileIconColor,
  folderIconColor,
  isTestFileName,
} from './fileIcons';

describe('fileIconColor', () => {
  it('colours by extension, case-insensitively', () => {
    expect(fileIconColor('store.ts')).toBe('#3178c6');
    expect(fileIconColor('STORE.TS')).toBe('#3178c6');
    expect(fileIconColor('main.go')).toBe('#00a8c6');
  });

  it('prefers a whole-name match over the extension', () => {
    // package.json and tsconfig.json are both .json, and neither should
    // look like a generic data file.
    expect(fileIconColor('package.json')).not.toBe(fileIconColor('data.json'));
    expect(fileIconColor('tsconfig.json')).toBe('#3178c6');
  });

  it('falls back to muted ink for unknown and extensionless files', () => {
    expect(fileIconColor('mystery.qqq')).toBe(DEFAULT_FILE_COLOR);
    expect(fileIconColor('Procfile')).toBe(DEFAULT_FILE_COLOR);
  });
});

describe('folderIconColor', () => {
  it('tints folders whose name states their role', () => {
    expect(folderIconColor('src')).toBe('#4a8df8');
    expect(folderIconColor('__tests__')).toBe('#5aae3c');
    expect(folderIconColor('node_modules')).toBe('#6b7280');
  });

  it('leaves ordinary folders neutral', () => {
    expect(folderIconColor('billing')).toBeNull();
  });
});

describe('isTestFileName', () => {
  it('recognises the common test naming conventions', () => {
    expect(isTestFileName('store.test.ts')).toBe(true);
    expect(isTestFileName('store.spec.tsx')).toBe(true);
    expect(isTestFileName('test_thing.py')).toBe(true);
  });

  it('does not badge the file under test', () => {
    expect(isTestFileName('store.ts')).toBe(false);
    expect(isTestFileName('latest.ts')).toBe(false);
  });
});
