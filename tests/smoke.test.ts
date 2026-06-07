// tests/smoke.test.ts
// Live smoke test — real Slack ping + real dev.to draft publish.
// Gated by RUN_LIVE=1. Run with: npm run test:live
// NOT part of the fast suite — manual pre-demo confidence check only.
//
// Requires: SLACK_WEBHOOK_URL, DEVTO_API_KEY set in environment.
// DEVTO_DRAFT_MODE=true is set by the test:live script — post goes to drafts, not public feed.

import { describe, it, expect, beforeEach } from 'vitest';
import { notify } from '../src/pipeline/notify';
import { publish } from '../src/pipeline/publish';
import { insertDraft, getDraft, _resetDbForTesting } from '../src/db';
import { makeDraft, MOCK_POST } from './helpers/fixtures';

// Skipped unless RUN_LIVE=1 is set explicitly
describe.runIf(process.env.RUN_LIVE === '1')('live smoke (pre-demo only)', () => {
  beforeEach(() => {
    _resetDbForTesting();
  });

  it(
    'fires a real Slack ping and publishes to dev.to in draft mode',
    async () => {
      const draft = insertDraft(makeDraft({ status: 'approved' }));

      // Real Slack notify — must not throw
      await notify(draft, [MOCK_POST]);

      // Real dev.to publish in draft mode (DEVTO_DRAFT_MODE=true, set by npm script)
      await publish(draft);

      const published = getDraft(draft.id)!;
      expect(published.status).toBe('published');
      expect(published.cms_url).toMatch(/^https:\/\/dev\.to\//);

      console.log('\n[smoke] ✓ Slack notified');
      console.log(`[smoke] ✓ Published URL: ${published.cms_url}`);
    },
    30_000, // 30 s — real network calls
  );
});
