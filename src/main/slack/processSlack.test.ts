import { describe, expect, it } from 'vitest';
import { PROC_APPROVE_ACTION, decisionBlocks, readDecisionValue } from './processSlack';

describe('decision buttons', () => {
  it('name the stage they were asked at, so a stale one decides nothing', () => {
    const blocks = decisionBlocks('Decide on dark mode', 'a1b2c3d4e5f6', 'validate:v2') as Array<{ elements?: Array<{ action_id: string; value: string }> }>;
    const approve = blocks[1].elements!.find((e) => e.action_id === PROC_APPROVE_ACTION)!;
    expect(readDecisionValue(approve.value)).toEqual({ itemId: 'a1b2c3d4e5f6', stageId: 'validate:v2' });
  });

  it('read a button from before stages were named as having none', () => {
    expect(readDecisionValue('a1b2c3d4e5f6')).toEqual({ itemId: 'a1b2c3d4e5f6' });
  });
});
