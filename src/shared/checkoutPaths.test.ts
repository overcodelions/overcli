import { describe, expect, it } from 'vitest';
import { hardcodedCheckouts, useCheckoutPlaceholder } from './checkoutPaths';

const checkouts = ['/repos/app', '/repos/app-wt/feat-login/'];

describe('hardcodedCheckouts', () => {
  it('finds a checkout the command names, as a whole path', () => {
    expect(hardcodedCheckouts('ln -sfn /repos/app /srv/app-active', checkouts)).toEqual(['/repos/app']);
    expect(hardcodedCheckouts('cat "/repos/app/.env"', checkouts)).toEqual(['/repos/app']);
  });

  it('does not mistake a sibling folder with a shared prefix for the checkout', () => {
    expect(hardcodedCheckouts('ln -sfn /repos/app-active /srv', checkouts)).toEqual([]);
    expect(hardcodedCheckouts('cd /repos/app2', checkouts)).toEqual([]);
  });

  it('finds nothing in a command that already uses the placeholder', () => {
    expect(hardcodedCheckouts('ln -sfn ${CHECKOUT} /srv/app-active', checkouts)).toEqual([]);
  });
});

describe('useCheckoutPlaceholder', () => {
  it('replaces every known checkout, the longer path first', () => {
    expect(
      useCheckoutPlaceholder('echo /repos/app-wt/feat-login || echo /repos/app; ls /repos/app-active', checkouts),
    ).toBe('echo ${CHECKOUT} || echo ${CHECKOUT}; ls /repos/app-active');
  });
});
