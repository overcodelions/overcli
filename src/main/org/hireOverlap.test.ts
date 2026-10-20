import { describe, expect, it } from 'vitest';
import { overlapPrompt, readOverlap } from './hireOverlap';

const workers = [
  { id: 'w-hugo', name: 'Hugo', tagline: 'Turns findings into executive reports', job: 'Writes the HTML report from what the team found.' },
  { id: 'w-lena', name: 'Lena', tagline: 'Voice of the customer' },
];

describe('a worker who already does the job', () => {
  it('lists each worker with what it does', () => {
    const prompt = overlapPrompt('I need a report builder', workers);
    expect(prompt).toContain('1. Hugo — Turns findings into executive reports');
    expect(prompt).toContain('Does: Writes the HTML report');
  });

  it('reads the model’s pick, or none', () => {
    expect(readOverlap('{"worker": 1, "why": "already builds the reports"}', workers)).toEqual({ workerId: 'w-hugo', why: 'already builds the reports' });
    expect(readOverlap('Sure: {"worker": "2", "why": "x"}', workers)).toMatchObject({ workerId: 'w-lena' });
    expect(readOverlap('{"worker": null, "why": ""}', workers)).toBeNull();
    expect(readOverlap('{"worker": 9}', workers)).toBeNull();
    expect(readOverlap('no json', workers)).toBeNull();
  });
});
