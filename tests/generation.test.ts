// tests/generation.test.ts
// Generation chain — LLM mocked to fixed fixtures; asserts orchestration and row shape.
// Does NOT assert on prose quality (non-deterministic).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mockCreate } };
  },
}));

import { randomUUID } from 'node:crypto';
import { generate } from '../src/pipeline/generate';
import { insertDraft, getDraft, _resetDbForTesting } from '../src/db';
import { groupFingerprint } from '../src/lib/fingerprint';
import {
  MOCK_POST,
  MOCK_EXTRACTED_IDEA,
  MOCK_CRITIQUE,
  MOCK_RAW_DRAFT,
} from './helpers/fixtures';

beforeEach(() => {
  _resetDbForTesting();
});

afterEach(() => {
  vi.resetAllMocks();
});

// Sets up the minimum mock sequence for generate():
//   1 extract + 1 draft + 1 critique + 1 revise + 1 re-score critique (→ overall=4, loop exits).
// With default RESCORE_CAP=3, the loop runs once and breaks on ≥4.
function setupFourPassMocks(overrides: { revise?: string } = {}): void {
  mockCreate
    .mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }],
    })
    .mockResolvedValueOnce({
      choices: [{ message: { content: MOCK_RAW_DRAFT } }],
    })
    .mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }],
    })
    .mockResolvedValueOnce({
      choices: [{ message: { content: overrides.revise ?? 'TITLE: Final\n\nFinal content.' } }],
    })
    // Re-score: MOCK_CRITIQUE.overall=4 → loop exits immediately, no re-revise.
    .mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }],
    });
}

describe('generation chain (LLM mocked)', () => {
  it('full chain produces a draft with all expected fields populated', async () => {
    setupFourPassMocks();
    const result = await generate([MOCK_POST]);

    expect(result.extracted_idea).toMatchObject({
      core_thesis: MOCK_EXTRACTED_IDEA.core_thesis,
      target_audience: MOCK_EXTRACTED_IDEA.target_audience,
    });
    expect(result.raw_draft).toBe(MOCK_RAW_DRAFT);
    expect(result.critique).toBe(JSON.stringify(MOCK_CRITIQUE));
    expect(result.revised_draft).toBe('TITLE: Final\n\nFinal content.');
  });

  it('runs five calls when re-critique scores ≥4 (extract, draft, critique, revise, re-critique)', async () => {
    setupFourPassMocks();
    await generate([MOCK_POST]);
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it('critique is stored as a JSON string, parseable as CritiqueOutput', async () => {
    setupFourPassMocks();
    const result = await generate([MOCK_POST]);

    expect(() => JSON.parse(result.critique)).not.toThrow();
    const parsed = JSON.parse(result.critique) as Record<string, unknown>;
    expect(parsed).toHaveProperty('scores');
    expect(parsed).toHaveProperty('overall');
    expect(parsed).toHaveProperty('problems');
  });

  it('extracted_idea is an object (not a string) after the chain', async () => {
    setupFourPassMocks();
    const result = await generate([MOCK_POST]);
    expect(typeof result.extracted_idea).toBe('object');
    expect(result.extracted_idea.core_thesis).toBeTruthy();
  });

  it('throws if extract pass returns null content', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate([MOCK_POST])).rejects.toThrow('extract pass returned null content');
  });

  it('throws if draft pass returns null content', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate([MOCK_POST])).rejects.toThrow('draft pass returned null content');
  });

  it('throws if critique pass returns null content', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate([MOCK_POST])).rejects.toThrow('critique pass returned null content');
  });

  it('throws if revise pass returns null content', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate([MOCK_POST])).rejects.toThrow('revise pass returned null content');
  });
});

// ─── Verification integration (DB round-trip) ────────────────────────────────
// This is the discriminating test: checks that verification is written to and
// read from the DB correctly. Pure verify.test.ts unit tests won't catch a
// broken JSON_COLUMNS entry or a missing rowToDraft parse.

describe('verification DB round-trip', () => {
  it('draft containing "delves" produces bannedTerms non-empty on the row', async () => {
    setupFourPassMocks({
      revise: 'TITLE: Revenue Clarity\n\nThis post delves into why forecasting fails.',
    });
    const result = await generate([MOCK_POST]);

    const draftId = randomUUID();
    insertDraft({
      id: draftId,
      source_post_ids: [MOCK_POST.id],
      group_fingerprint: groupFingerprint([MOCK_POST.id]),
      status: 'pending',
      revision_count: 0,
      ...result,
    });

    const stored = getDraft(draftId)!;
    expect(stored.verification).toBeDefined();
    expect(stored.verification!.bannedTerms.some(t => t === 'delve')).toBe(true);
    expect(stored.verification!.passed).toBe(false);
  });

  it('draft containing "3.1x" produces ungroundedNumbers non-empty on the row', async () => {
    setupFourPassMocks({
      revise: 'TITLE: ROI Selling\n\nROI-first pitches close at 3.1x the rate of feature-led ones.',
    });
    const result = await generate([MOCK_POST]);

    const draftId = randomUUID();
    insertDraft({
      id: draftId,
      source_post_ids: [MOCK_POST.id],
      group_fingerprint: groupFingerprint([MOCK_POST.id]),
      status: 'pending',
      revision_count: 0,
      ...result,
    });

    const stored = getDraft(draftId)!;
    expect(stored.verification).toBeDefined();
    expect(stored.verification!.ungroundedNumbers).toContain('3.1x');
    expect(stored.verification!.passed).toBe(false);
  });

  it('clean draft → verification.passed=true on the row', async () => {
    setupFourPassMocks({
      revise:
        'TITLE: The Real Cost of Forecast Drift\n\n' +
        'Forecasting is a management discipline, not a finance deliverable.',
    });
    const result = await generate([MOCK_POST]);

    const draftId = randomUUID();
    insertDraft({
      id: draftId,
      source_post_ids: [MOCK_POST.id],
      group_fingerprint: groupFingerprint([MOCK_POST.id]),
      status: 'pending',
      revision_count: 0,
      ...result,
    });

    const stored = getDraft(draftId)!;
    expect(stored.verification).toBeDefined();
    expect(stored.verification!.passed).toBe(true);
  });
});

// ─── Re-score loop ────────────────────────────────────────────────────────────
// These tests override process.env.RESCORE_CAP per-scenario and restore it
// in afterEach. The outer afterEach (vi.resetAllMocks) runs after each test too.

describe('re-score loop', () => {
  afterEach(() => {
    delete process.env.RESCORE_CAP;
  });

  it('scores ≥4 on first re-critique → loop exits, no extra revise (5 calls)', async () => {
    // Default RESCORE_CAP=3; setupFourPassMocks already includes the re-critique → overall=4.
    setupFourPassMocks();
    await generate([MOCK_POST]);
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it('[3,3,4] → loops to ≥4; returns final draft, critique reflects best score', async () => {
    // cap=3: iter0→score3+revise, iter1→score3+revise, iter2→score4+break = 4+3+2=9 calls
    process.env.RESCORE_CAP = '3';
    const c3 = { ...MOCK_CRITIQUE, overall: 3 as const };
    const c4 = { ...MOCK_CRITIQUE, overall: 4 as const };
    mockCreate
      // initial 4 passes
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'TITLE: V1\n\nV1 content.' } }] })
      // iter 0: re-critique(3) → re-revise → v2
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(c3) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'TITLE: V2\n\nV2 content.' } }] })
      // iter 1: re-critique(3) → re-revise → v3
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(c3) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'TITLE: V3\n\nV3 content.' } }] })
      // iter 2: re-critique(4) → break
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(c4) } }] });

    const result = await generate([MOCK_POST]);
    expect(mockCreate).toHaveBeenCalledTimes(9);
    // bestDraft = v3 (scored 4 in iter 2)
    expect(result.revised_draft).toBe('TITLE: V3\n\nV3 content.');
    expect(JSON.parse(result.critique).overall).toBe(4);
  });

  it('retains best-of: [3,1] at cap=2 → returns first-iteration draft, not the worse one', async () => {
    // cap=2: iter0→score3+revise→v2, iter1→score1+cap break = 4+1+1+1=7 calls
    // v1 scored 3, v2 scored 1 → best-of returns v1
    process.env.RESCORE_CAP = '2';
    const c3 = { ...MOCK_CRITIQUE, overall: 3 as const };
    const c1 = { ...MOCK_CRITIQUE, overall: 1 as const };
    mockCreate
      // initial 4 passes → initialRevised = v1
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'TITLE: V1\n\nV1 content.' } }] })
      // iter 0: re-critique(3) → update best(v1, 3), <4, iter+1=1<2 → re-revise → v2
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(c3) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'TITLE: V2\n\nV2 worse content.' } }] })
      // iter 1: re-critique(1) → 1>3? NO. cap reached → break
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(c1) } }] });

    const result = await generate([MOCK_POST]);
    expect(mockCreate).toHaveBeenCalledTimes(7);
    // Best was v1 (score=3), not v2 (score=1)
    expect(result.revised_draft).toBe('TITLE: V1\n\nV1 content.');
    expect(JSON.parse(result.critique).overall).toBe(3);
  });
});

// ─── todo stubs ───────────────────────────────────────────────────────────────

describe('upcoming: scorecard', () => {
  it.todo('quick-answer block present → scorecard passes');
  it.todo('quick-answer block absent → scorecard fails');
  it.todo('question-H2 count checked');
  it.todo('FAQ section present/absent');
  it.todo('meta description length within bounds');
});
