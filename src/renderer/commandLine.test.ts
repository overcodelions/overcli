import { describe, expect, it } from 'vitest';
import { describeShellNeed, formatCommandLine, parseCommandLine } from './commandLine';

describe('parseCommandLine', () => {
  it('splits an ordinary command', () => {
    expect(parseCommandLine('docker compose up db').argv).toEqual(['docker', 'compose', 'up', 'db']);
  });

  it('keeps a quoted argument whole and drops the quotes', () => {
    expect(parseCommandLine('sh -c "echo hello world"').argv).toEqual([
      'sh',
      '-c',
      'echo hello world',
    ]);
  });

  it('handles both quote styles and an escaped space', () => {
    expect(parseCommandLine(`run --path '/a b/c' --name x\\ y`).argv).toEqual([
      'run',
      '--path',
      '/a b/c',
      '--name',
      'x y',
    ]);
  });

  it('keeps an empty quoted argument, which is a real argument', () => {
    expect(parseCommandLine('cmd "" x').argv).toEqual(['cmd', '', 'x']);
  });

  it('collapses runs of whitespace', () => {
    expect(parseCommandLine('  npm   run    dev  ').argv).toEqual(['npm', 'run', 'dev']);
  });

  it('names the shell syntax it cannot run rather than passing it through', () => {
    // A service spawned with `|` as an argument starts and does something
    // unrecognisable; saying so up front is the whole point.
    expect(parseCommandLine('cat x | grep y').needsShell).toBe('pipe');
    expect(parseCommandLine('a > b').needsShell).toBe('redirect');
    expect(parseCommandLine('a && b').needsShell).toBe('chain');
    expect(parseCommandLine('echo $(date)').needsShell).toBe('substitution');
  });

  it('does not mistake shell characters inside a quoted argument', () => {
    // `-Dmessage="a && b"` is an ordinary argument.
    const parsed = parseCommandLine('java -Dmessage="a && b"');
    expect(parsed.needsShell).toBeUndefined();
    expect(parsed.argv).toEqual(['java', '-Dmessage=a && b']);
  });

  it('returns nothing for an empty line', () => {
    expect(parseCommandLine('   ').argv).toEqual([]);
  });
});

describe('describeShellNeed', () => {
  it('says what to do instead', () => {
    expect(describeShellNeed('pipe')).toMatch(/script/);
    expect(describeShellNeed('chain')).toMatch(/two services/);
  });
});

describe('formatCommandLine', () => {
  it('round-trips a command with a quoted argument', () => {
    const line = 'sh -c "echo hello world"';
    expect(formatCommandLine(parseCommandLine(line).argv)).toBe(line);
  });

  it('quotes only what needs it', () => {
    expect(formatCommandLine(['npm', 'run', 'dev'])).toBe('npm run dev');
  });
});
