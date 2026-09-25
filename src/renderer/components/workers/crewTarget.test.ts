import { describe, expect, it } from 'vitest';
import { directTarget } from './crewTarget';

const crew = [
  { id: 'c', name: 'Chief', enabled: true },
  { id: 'cos', name: 'Chief of Staff', enabled: true },
  { id: 's', name: 'Soraya', enabled: true },
  { id: 'b', name: 'Benched', enabled: false },
];

describe('directTarget', () => {
  it('sends to the longest matching name, and keeps the rest as the ask', () => {
    expect(directTarget('@Chief of Staff move my 3pm', crew)).toEqual({ workerId: 'cos', ask: 'move my 3pm' });
    expect(directTarget('@chief: file it', crew)).toEqual({ workerId: 'c', ask: 'file it' });
    expect(directTarget('@soraya, is the hotel booked?', crew)).toEqual({ workerId: 's', ask: 'is the hotel booked?' });
  });

  it('needs a whole name, an active worker, and a leading @', () => {
    expect(directTarget('@Sorayas thing', crew)).toBeNull();
    expect(directTarget('@Benched do it', crew)).toBeNull();
    expect(directTarget('Soraya do it', crew)).toBeNull();
  });
});
