// tests/scorecard.test.ts
// Deterministic AEO scorecard. These were the `upcoming: scorecard` todos in generation.test.ts.

import { describe, it, expect } from 'vitest';
import type { CritiqueOutput } from '../src/types';
import { buildScorecard, type ScoreCheck } from '../src/lib/scorecard';
import { splitTitleAndBody } from '../src/lib/text';
import { MOCK_REVISED_DRAFT, MOCK_CRITIQUE } from './helpers/fixtures';

const find = (checks: ScoreCheck[], label: string) => checks.find((c) => c.label === label)!;

const GOOD_BODY = [
  'A CRO asks why win rate fell, and three systems give three persuasive answers. None is safe to bet the quarter on.',
  '',
  'Quick answer: Revenue AI has to connect CRM, calls, email, deal history, and outcomes, then find the root cause and turn the pattern into a playbook deployed before live meetings, because analysis without action leaves the team translating insight into behavior by hand every single time.',
  '',
  '## Why does win rate drop without anyone noticing?',
  '',
  'Because the signal is split across systems and no one has time to read it all.',
  '',
  '## Frequently Asked Questions',
  '',
  '**Q: What is the fix?** Connect the data first, then deploy the playbook.',
].join('\n');

describe('buildScorecard', () => {
  it('a well-structured draft passes every check', () => {
    const good: CritiqueOutput = { ...MOCK_CRITIQUE, scores: { ...MOCK_CRITIQUE.scores, extractability: 5 } };
    const checks = buildScorecard(GOOD_BODY, 'Why Revenue AI Fails Without Connected Evidence', good);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('flags a known-bad draft (no quick-answer, no question-H2, no FAQ)', () => {
    const { title, body } = splitTitleAndBody(MOCK_REVISED_DRAFT);
    const checks = buildScorecard(body, title, MOCK_CRITIQUE);

    expect(find(checks, 'Quick-answer block').status).toBe('warn');
    expect(find(checks, 'Question-style H2s').status).toBe('warn');
    expect(find(checks, 'FAQ section').status).toBe('warn');
    expect(checks.filter((c) => c.status === 'warn').length).toBeGreaterThanOrEqual(3);
  });

  it('flags an over-length title', () => {
    const longTitle = 'A'.repeat(75);
    const checks = buildScorecard(GOOD_BODY, longTitle, MOCK_CRITIQUE);
    const t = find(checks, 'Title length');
    expect(t.status).toBe('warn');
    expect(t.detail).toBe('75/60 chars');
  });

  it('flags a missing TITLE: line', () => {
    const checks = buildScorecard(GOOD_BODY, null, MOCK_CRITIQUE);
    expect(find(checks, 'Title length').detail).toBe('no TITLE: line');
  });

  it('counts question-style H2s and reports the ratio', () => {
    const checks = buildScorecard(GOOD_BODY, 'ok', MOCK_CRITIQUE);
    // One real H2 ("Why does win rate drop...?"), FAQ heading excluded → 1 of 1.
    expect(find(checks, 'Question-style H2s').detail).toBe('1 of 1 H2s');
  });

  it('surfaces the critique extractability score, flagging a low one', () => {
    const low: CritiqueOutput = { ...MOCK_CRITIQUE, scores: { ...MOCK_CRITIQUE.scores, extractability: 2 } };
    const checks = buildScorecard(GOOD_BODY, 'ok', low);
    const e = find(checks, 'Extractability (critique)');
    expect(e.status).toBe('warn');
    expect(e.detail).toBe('2/5');
  });

  it('reports meta description length from the same source publish uses', () => {
    const checks = buildScorecard(GOOD_BODY, 'ok', MOCK_CRITIQUE);
    const m = find(checks, 'Meta description');
    // First substantive paragraph is the opening line (>40, <155) → pass.
    expect(m.status).toBe('pass');
    expect(m.detail).toMatch(/^\d+ chars$/);
  });
});
