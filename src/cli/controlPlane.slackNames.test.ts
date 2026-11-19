import { describe, expect, it } from 'vitest';
import { withSlackNames } from './controlPlane';

describe('people known only by their Slack id', () => {
  it('go by their Slack name, and nobody else is renamed', () => {
    const rows = [
      { name: 'U0ACMEJO', slackUserId: 'U0ACMEJO' },
      { name: 'Sam', slackUserId: 'U0ACMESAM' },
      { name: 'U0ACMEGONE', slackUserId: 'U0ACMEGONE' },
      { name: 'Admin' },
    ];
    const slack = [
      { id: 'U0ACMEJO', name: 'Jo Park', handle: 'jo' },
      { id: 'U0ACMESAM', name: 'Samuel Stone', handle: 'sam' },
    ];
    expect(withSlackNames(rows, slack).map((r) => r.name)).toEqual(['Jo Park', 'Sam', 'U0ACMEGONE', 'Admin']);
  });
});
