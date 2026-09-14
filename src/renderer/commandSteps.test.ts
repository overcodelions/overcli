import { describe, expect, it } from 'vitest';
import { joinSteps, splitSteps } from './commandSteps';

const roundTrip = (line: string) => joinSteps(splitSteps(line).join('\n'));

describe('splitSteps', () => {
  it('breaks a long shell line after each separator, keeping the separator', () => {
    const line =
      'SEL="${CHECKOUT}"; ln -sfn "$SEL" /srv/web-active; until curl -sf http://127.0.0.1/; do echo "waiting"; sleep 2; done && exec tail -F /var/log/web.log';
    expect(splitSteps(line)).toEqual([
      'SEL="${CHECKOUT}";',
      'ln -sfn "$SEL" /srv/web-active;',
      'until curl -sf http://127.0.0.1/;',
      'do echo "waiting";',
      'sleep 2;',
      'done &&',
      'exec tail -F /var/log/web.log',
    ]);
    expect(roundTrip(line)).toBe(line);
  });

  it('leaves a command with no separators as one step', () => {
    expect(splitSteps('./gradlew bootRun --args="--spring.profiles.active=local"')).toHaveLength(1);
  });

  it('does not break inside quotes or a command substitution', () => {
    expect(splitSteps(`echo "a; b" 'c && d'; echo $(date; uptime) || true`)).toEqual([
      `echo "a; b" 'c && d';`,
      'echo $(date; uptime) ||',
      'true',
    ]);
  });

  it('only breaks where a single space follows, so joining is exact', () => {
    for (const line of ['a;b', 'a;  b', 'a && b', 'x=1;;  y', 'case $x in a) one;; b) two;; esac']) {
      expect(roundTrip(line)).toBe(line);
    }
    expect(splitSteps('a;b')).toEqual(['a;b']);
  });

  it('keeps a heredoc, a comment, open quotes or a continuation whole', () => {
    for (const line of ['cat <<EOF; b', 'echo hi # a; b', 'echo "open; b', 'a; b \\', 'a;\nb']) {
      expect(splitSteps(line)).toEqual([line]);
    }
  });
});

describe('joinSteps', () => {
  it('makes a line added without a separator its own step', () => {
    expect(joinSteps('npm ci\nnpm run dev')).toBe('npm ci; npm run dev');
  });

  it('runs straight on after a separator, a pipe, a background & or a keyword', () => {
    expect(joinSteps('a &&\nb |\nc &\nwhile true; do\necho x;\ndone')).toBe('a && b | c & while true; do echo x; done');
  });

  it('drops blank lines, indentation and a line continuation', () => {
    expect(joinSteps('  start \\\n    --fast\n\n  next')).toBe('  start --fast; next');
  });
});
