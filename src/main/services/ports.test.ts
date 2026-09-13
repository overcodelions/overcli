import { describe, expect, it } from 'vitest';
import { heldPorts, leaseFor, nextFreeOffset, portForOffset, type PortClaim } from './ports';

function claim(over: Partial<PortClaim> & { port: number }): PortClaim {
  return { serviceId: 'billing-rest', stackId: 'other-stack', ...over };
}

describe('portForOffset', () => {
  it('keeps the base port at offset zero so bookmarks still work', () => {
    expect(portForOffset(8080, 0)).toBe(8080);
  });

  it('steps far enough to be obvious rather than look like a typo', () => {
    expect(portForOffset(8080, 1)).toBe(18080);
    expect(portForOffset(8080, 2)).toBe(28080);
  });
});

describe('nextFreeOffset', () => {
  it('prefers the base port', () => {
    expect(nextFreeOffset(8080, [])).toBe(0);
  });

  it('skips over offsets already in use', () => {
    expect(nextFreeOffset(8080, [claim({ port: 8080 }), claim({ port: 18080 })])).toBe(2);
  });

  it('gives up rather than opening a sixth copy of one service', () => {
    const taken = [0, 1, 2, 3].map((o) => claim({ port: portForOffset(8080, o) }));
    expect(nextFreeOffset(8080, taken)).toBeNull();
  });

  it('gives up before running past the top of the port range', () => {
    expect(nextFreeOffset(60_000, [claim({ port: 60_000 })])).toBeNull();
  });
});

describe('leaseFor', () => {
  const spec = { id: 'billing-rest', port: 8080 };

  it('starts on the base port when nothing holds it', () => {
    expect(leaseFor(spec, 'mine', [])).toEqual({ kind: 'free', port: 8080, offset: 0 });
  });

  it('reports a clash rather than taking the port', () => {
    // Silently stealing :8080 from a flow you were not watching is worse than
    // refusing to start, so the decision comes back to the user.
    const decision = leaseFor(spec, 'mine', [claim({ port: 8080, holder: 'flow ui poll' })]);
    expect(decision.kind).toBe('held');
    if (decision.kind !== 'held') return;
    expect(decision.claim.holder).toBe('flow ui poll');
    expect(decision.alongside).toEqual({ port: 18080, offset: 1 });
  });

  it('offers no side-by-side run when every offset is taken', () => {
    const taken = [0, 1, 2, 3].map((o) => claim({ port: portForOffset(8080, o) }));
    const decision = leaseFor(spec, 'mine', taken);
    expect(decision.kind).toBe('held');
    if (decision.kind !== 'held') return;
    expect(decision.alongside).toBeNull();
  });

  it('treats a second start from the same stack as the running service', () => {
    const decision = leaseFor(spec, 'mine', [claim({ port: 8080, stackId: 'mine' })]);
    expect(decision.kind).toBe('already-running');
  });

  it('never collides for a service that binds no port', () => {
    expect(leaseFor({ id: 'sweeper' }, 'mine', [claim({ port: 8080 })]).kind).toBe('free');
  });
});

describe('heldPorts', () => {
  it('lists the ports this stack holds, in order, ignoring other stacks', () => {
    const claims = [
      claim({ port: 8090, stackId: 'mine', serviceId: 'acme-rest' }),
      claim({ port: 8080, stackId: 'mine' }),
      claim({ port: 4200, stackId: 'theirs', serviceId: 'admin-console' }),
    ];
    expect(heldPorts(claims, 'mine')).toEqual([8080, 8090]);
  });
});
