import { describe, expect, it } from 'vitest';
import { readRewrite, rewritePrompt } from './jobRewrite';

describe('a job rewritten from a change', () => {
  it('hands the model the job and the change, marked apart', () => {
    const p = rewritePrompt('Joe', 'Watch WOW and RED.', 'also Devop');
    expect(p).toContain('<job>\nWatch WOW and RED.\n</job>');
    expect(p).toContain('<change>\nalso Devop\n</change>');
  });

  it('takes the reply as the job, without a fence or a preamble', () => {
    expect(readRewrite('Watch WOW, RED and Devop.')).toBe('Watch WOW, RED and Devop.');
    expect(readRewrite('```\nWatch WOW, RED and Devop.\n```')).toBe('Watch WOW, RED and Devop.');
    expect(readRewrite("Here's the updated job:\nWatch WOW, RED and Devop.")).toBe('Watch WOW, RED and Devop.');
    expect(readRewrite('<job>\nWatch Devop.\n</job>')).toBe('Watch Devop.');
    expect(readRewrite('   ')).toBeNull();
  });
});
