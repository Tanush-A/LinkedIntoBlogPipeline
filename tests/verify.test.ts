// tests/verify.test.ts
// Pure unit tests for src/lib/verify.ts.
// No DB, no network, no mocks needed — verifyDraft is a pure function.

import { describe, it, expect } from 'vitest';
import { verifyDraft } from '../src/lib/verify';

// ─── bannedTerms ─────────────────────────────────────────────────────────────

describe('bannedTerms', () => {
  it('"delves" → caught (root "delve" in slop_ban, derivation matched)', () => {
    const r = verifyDraft('This post delves into the mechanics of revenue forecasting.');
    expect(r.bannedTerms.some(t => t === 'delve')).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('"delve" (exact) → caught', () => {
    const r = verifyDraft('We must delve deeper to understand.');
    expect(r.bannedTerms.some(t => t === 'delve')).toBe(true);
  });

  it('"delving" → caught', () => {
    const r = verifyDraft('Teams are delving into the data.');
    expect(r.bannedTerms.some(t => t === 'delve')).toBe(true);
  });

  it('"revolutionize" → caught', () => {
    const r = verifyDraft('This will revolutionize your pipeline.');
    expect(r.bannedTerms.some(t => t === 'revolutionize')).toBe(true);
  });

  it('"game-changer" → caught', () => {
    const r = verifyDraft('Forecasting is a game-changer for revenue teams.');
    expect(r.bannedTerms.some(t => /game.changer/i.test(t))).toBe(true);
  });

  it('"game-changing" → caught', () => {
    const r = verifyDraft('This is game-changing technology.');
    expect(r.bannedTerms.some(t => /game.chang/i.test(t))).toBe(true);
  });

  it('"supercharge" → caught', () => {
    const r = verifyDraft('Use Terret to supercharge your team.');
    expect(r.bannedTerms.some(t => t === 'supercharge')).toBe(true);
  });

  it('"secret sauce" → caught', () => {
    const r = verifyDraft("Their secret sauce is good data hygiene.");
    expect(r.bannedTerms.some(t => t === 'secret sauce')).toBe(true);
  });

  it('"tapestry" → caught', () => {
    const r = verifyDraft('A rich tapestry of signals tells the story.');
    expect(r.bannedTerms.some(t => t === 'tapestry')).toBe(true);
  });

  it('"level up" → caught', () => {
    const r = verifyDraft('Help your reps level up their game.');
    expect(r.bannedTerms.some(t => t === 'level up')).toBe(true);
  });

  it('"testament to" → caught', () => {
    const r = verifyDraft("It's a testament to their execution.");
    expect(r.bannedTerms.some(t => t === 'testament to')).toBe(true);
  });

  it('"unlock" (metaphorical) → caught', () => {
    const r = verifyDraft('Use Terret to unlock your pipeline potential.');
    expect(r.bannedTerms.some(t => t === 'unlock')).toBe(true);
  });

  it('"may improve" → caught', () => {
    const r = verifyDraft('This approach may improve forecast accuracy.');
    expect(r.bannedTerms.some(t => t === 'may improve')).toBe(true);
  });

  it('clean draft with no slop → bannedTerms empty', () => {
    const r = verifyDraft(
      'TITLE: Why CROs Need a New Forecasting Frame\n\n' +
      'Most revenue teams treat forecasting as a finance deliverable.\n\n' +
      'Terret changes that by surfacing the decisions that matter.',
    );
    expect(r.bannedTerms).toHaveLength(0);
  });

  it('case-insensitive: "DELVES" → caught', () => {
    const r = verifyDraft('The analysis DELVES into the root causes.');
    expect(r.bannedTerms.some(t => t === 'delve')).toBe(true);
  });
});

// ─── ungroundedNumbers ────────────────────────────────────────────────────────

describe('ungroundedNumbers', () => {
  it('"3.1x" → flagged (demo figure, must not appear as a proven stat)', () => {
    const r = verifyDraft('ROI-first pitches closed at 3.1x the rate of feature-led ones.');
    expect(r.ungroundedNumbers).toContain('3.1x');
    expect(r.passed).toBe(false);
  });

  it('"40%" → flagged (invented, not in brand config)', () => {
    const r = verifyDraft('Win rates improved by 40% after the rollout.');
    expect(r.ungroundedNumbers).toContain('40%');
  });

  it('"$4M" → flagged (not in brand config)', () => {
    const r = verifyDraft('The deal was worth $4M in ARR.');
    expect(r.ungroundedNumbers.some(n => n.toLowerCase() === '$4m')).toBe(true);
  });

  it('"45,000" → flagged (demo figure from positive_examples)', () => {
    const r = verifyDraft('Terret analyzed 45,000 calls to find the pattern.');
    expect(r.ungroundedNumbers.some(n => n === '45,000')).toBe(true);
  });

  it('no stat figures → ungroundedNumbers empty', () => {
    const r = verifyDraft(
      'Forecasting is a management problem, not a finance one.\n\n' +
      'Most revenue teams treat pipeline review as a reporting exercise.',
    );
    expect(r.ungroundedNumbers).toHaveLength(0);
  });

  it('does not double-report the same figure', () => {
    const r = verifyDraft('Closed at 3.1x. The 3.1x figure matters.');
    const count = r.ungroundedNumbers.filter(n => n === '3.1x').length;
    expect(count).toBe(1);
  });
});

// ─── passed flag ─────────────────────────────────────────────────────────────

describe('passed', () => {
  it('passed=false when bannedTerms non-empty', () => {
    const r = verifyDraft('This delves into the topic.');
    expect(r.passed).toBe(false);
  });

  it('passed=false when ungroundedNumbers non-empty', () => {
    const r = verifyDraft('Win rates improved by 40%.');
    expect(r.passed).toBe(false);
  });

  it('passed=true on clean draft', () => {
    const r = verifyDraft(
      'TITLE: The Real Cost of Forecast Drift\n\n' +
      'Every sales leader knows when the number feels wrong.\n\n' +
      'The problem is not the data — it is the frame. Forecasting is a management discipline.',
    );
    expect(r.passed).toBe(true);
    expect(r.bannedTerms).toHaveLength(0);
    expect(r.ungroundedNumbers).toHaveLength(0);
  });
});
