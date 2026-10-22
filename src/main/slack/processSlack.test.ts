import { describe, expect, it } from 'vitest';
import { PROC_APPROVE_ACTION, PROC_FILL_ACTION, decisionBlocks, fillView, readDecisionValue, readFill } from './processSlack';

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

describe('a stage that asks for something', () => {
  const stage = { name: 'Scope it', mode: 'input' as const, fields: [{ id: 'budget', label: 'Budget', kind: 'text' as const, required: true }, { id: 'seg', label: 'Segment', kind: 'choice' as const, options: ['SMB', 'Mid-market'] }] };

  it('opens its form in place of Approve', () => {
    const blocks = decisionBlocks('Fill in dashboards', 'a1', 'scope', stage) as Array<{ elements?: Array<{ action_id: string; text: { text: string } }> }>;
    expect(blocks[1].elements!.map((e) => [e.action_id, e.text.text])[0]).toEqual([PROC_FILL_ACTION, 'Fill it in…']);
    const plain = decisionBlocks('Decide', 'a1', 'scope') as Array<{ elements?: Array<{ action_id: string }> }>;
    expect(plain[1].elements![0].action_id).toBe(PROC_APPROVE_ACTION);
  });

  it('asks for each field, and reads the answers back by id', () => {
    const view = fillView('Usage dashboards', stage, { itemId: 'a1', stageId: 'scope', channel: 'D1', ts: '1.2' }) as { blocks: Array<{ block_id?: string; optional?: boolean; element?: { type: string } }>; submit: { text: string } };
    expect(view.submit.text).toBe('Submit');
    expect(view.blocks.filter((b) => b.block_id).map((b) => [b.block_id, b.optional, b.element?.type])).toEqual([
      ['f_budget', false, 'plain_text_input'],
      ['f_seg', true, 'static_select'],
      ['note', true, 'plain_text_input'],
    ]);
    expect(readFill({ f_budget: { v: { value: ' 40k ' } }, f_seg: { v: { selected_option: { value: 'SMB' } } }, note: { v: { value: null } } })).toEqual({ answers: { budget: '40k', seg: 'SMB' }, note: '' });
  });
});
