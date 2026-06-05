// tests/generation.test.ts
// Generation chain — LLM mocked to fixed fixtures; asserts orchestration and row shape.
// Does NOT assert on prose quality (non-deterministic).

import { describe, it, expect, afterEach, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mockCreate } };
  },
}));

import { generate } from '../src/pipeline/generate';
import {
  MOCK_POST,
  MOCK_EXTRACTED_IDEA,
  MOCK_CRITIQUE,
  MOCK_RAW_DRAFT,
} from './helpers/fixtures';

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

// ─── todo stubs ───────────────────────────────────────────────────────────────

describe('upcoming: scorecard', () => {
  it.todo('quick-answer block present → scorecard passes');
  it.todo('quick-answer block absent → scorecard fails');
  it.todo('question-H2 count checked');
  it.todo('FAQ section present/absent');
  it.todo('meta description length within bounds');
});
