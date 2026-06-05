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
    });
}

describe('generation chain (LLM mocked)', () => {
  it('full chain produces a draft with all expected fields populated', async () => {
    setupFourPassMocks();
    const result = await generate(MOCK_POST);

    expect(result.extracted_idea).toMatchObject({
      core_thesis: MOCK_EXTRACTED_IDEA.core_thesis,
      target_audience: MOCK_EXTRACTED_IDEA.target_audience,
    });
    expect(result.raw_draft).toBe(MOCK_RAW_DRAFT);
    expect(result.critique).toBe(JSON.stringify(MOCK_CRITIQUE));
    expect(result.revised_draft).toBe('TITLE: Final\n\nFinal content.');
  });

  it('runs exactly four passes (extract, draft, critique, revise)', async () => {
    setupFourPassMocks();
    await generate(MOCK_POST);
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('critique is stored as a JSON string, parseable as CritiqueOutput', async () => {
    setupFourPassMocks();
    const result = await generate(MOCK_POST);

    expect(() => JSON.parse(result.critique)).not.toThrow();
    const parsed = JSON.parse(result.critique) as Record<string, unknown>;
    expect(parsed).toHaveProperty('scores');
    expect(parsed).toHaveProperty('overall');
    expect(parsed).toHaveProperty('problems');
  });

  it('extracted_idea is an object (not a string) after the chain', async () => {
    setupFourPassMocks();
    const result = await generate(MOCK_POST);
    expect(typeof result.extracted_idea).toBe('object');
    expect(result.extracted_idea.core_thesis).toBeTruthy();
  });

  it('throws if extract pass returns null content', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate(MOCK_POST)).rejects.toThrow('extract pass returned null content');
  });

  it('throws if draft pass returns null content', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate(MOCK_POST)).rejects.toThrow('draft pass returned null content');
  });

  it('throws if critique pass returns null content', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate(MOCK_POST)).rejects.toThrow('critique pass returned null content');
  });

  it('throws if revise pass returns null content', async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generate(MOCK_POST)).rejects.toThrow('revise pass returned null content');
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
    const result = await generate(MOCK_POST);

    const draftId = randomUUID();
    insertDraft({
      id: draftId,
      source_post_id: MOCK_POST.id,
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
    const result = await generate(MOCK_POST);

    const draftId = randomUUID();
    insertDraft({
      id: draftId,
      source_post_id: MOCK_POST.id,
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
    const result = await generate(MOCK_POST);

    const draftId = randomUUID();
    insertDraft({
      id: draftId,
      source_post_id: MOCK_POST.id,
      status: 'pending',
      revision_count: 0,
      ...result,
    });

    const stored = getDraft(draftId)!;
    expect(stored.verification).toBeDefined();
    expect(stored.verification!.passed).toBe(true);
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
