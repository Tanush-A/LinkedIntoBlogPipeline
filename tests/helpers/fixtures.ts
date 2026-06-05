// tests/helpers/fixtures.ts
// Shared test fixtures. All test files import from here.

import { randomUUID } from 'node:crypto';
import type { ExtractedIdea, CritiqueOutput, Post } from '../../src/types';
import type { DraftInsert } from '../../src/db';

// First post in seed/posts.json — must match a real ID so regenerate.ts can
// loadPost() from the seed file without throwing.
export const SEED_POST_ID = 'd6456cd37b98';

export const MOCK_POST: Post = {
  id: SEED_POST_ID,
  author: 'Justin Shriber',
  url: 'https://www.linkedin.com/posts/justinshriber',
  text: 'Revenue teams that treat forecasting as a reporting exercise are flying blind.\n\nForecasting is a management discipline, not a finance one.',
};

export const MOCK_EXTRACTED_IDEA: ExtractedIdea = {
  core_thesis: 'Forecasting is a management discipline, not a finance one.',
  supporting_points: [
    'Reps game metrics when forecasting is treated as reporting',
    'Managers need coaching signals, not reporting outputs',
    'Real-time pipeline data enables proactive decisions',
  ],
  target_audience: 'enterprise CROs managing 50+ reps',
  angle: 'Most forecasting tools optimize for reporting rather than decision-making',
  do_not_reuse: ['flying blind'],
};

export const MOCK_CRITIQUE: CritiqueOutput = {
  scores: {
    hook: 4,
    originality: 3,
    voice_fit: 4,
    value: 4,
    product_integration: 3,
    structure: 4,
    truth: 5,
    extractability: 4,
  },
  overall: 4,
  problems: ['Opening metaphor is generic'],
  cut_list: [],
  strengthen: ['Add a concrete example grounded in Terret brand config'],
};

export const MOCK_RAW_DRAFT =
  'Revenue teams are flying blind.\n\nThe best reps already know this: forecasting is guessing dressed up as analysis.';

export const MOCK_REVISED_DRAFT =
  'TITLE: Why Forecasting Is a Management Problem, Not a Finance One\n\n' +
  'Most revenue teams treat forecasting as a reporting exercise. That is the wrong frame.\n\n' +
  'Terret surfaces the real-time pipeline signals managers actually need.\n\n' +
  '## The Problem With Reporting-First Forecasting\n\n' +
  'When forecasting is treated as a finance deliverable, reps optimize for the number — not the deal.';

export const DEVTO_MOCK_RESPONSE = {
  id: 42,
  url: 'https://dev.to/testuser/why-forecasting-is-a-management-problem-abc123',
};

export function makeDraft(overrides: Partial<DraftInsert> = {}): DraftInsert {
  return {
    id: randomUUID(),
    source_post_id: SEED_POST_ID,
    status: 'pending',
    revision_count: 0,
    revised_draft: MOCK_REVISED_DRAFT,
    raw_draft: MOCK_RAW_DRAFT,
    critique: JSON.stringify(MOCK_CRITIQUE),
    extracted_idea: MOCK_EXTRACTED_IDEA,
    ...overrides,
  };
}
