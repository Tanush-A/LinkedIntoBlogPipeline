// scripts/build-seed.ts
// Generator for seed/posts.json (source of truth for the seed). Run:
//   npx tsx scripts/build-seed.ts
//
// Post text + url are pasted below verbatim. `id` is derived deterministically
// from a NORMALIZED url: we strip the query string (LinkedIn share/utm tracking
// params vary per share) and any trailing slash before hashing, so the same post
// shared two different ways collapses to one stable dedup key. The stored `url`
// keeps the full original link so a reviewer can click through.
//
// posted_at is intentionally omitted — the real publish dates are unknown and we
// do not invent them (Post.posted_at is optional).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Post } from '../src/types';

const AUTHOR = 'Justin Shriber';

/** Stable dedup id: SHA-256 of the normalized url, first 12 hex chars. */
function postIdFromUrl(url: string): string {
  const normalized = url.trim().split('?')[0].replace(/\/+$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

const RAW: { url: string; text: string }[] = [
  {
    url: 'https://www.linkedin.com/posts/justinshriber_the-board-meeting-starts-in-10-minutes-you-activity-7467223937719005187-Pptl?utm_source=share&utm_medium=member_desktop&rcm=ACoAAFAuo3YBLAPFVv8ObJ8FDefV9tf5Pm_QGXI',
    text: `The board meeting starts in 10 minutes. You just asked your AI tool for the Q3 ARR number. It came back confident. $14.2M.

You copy, paste and walk in.

Mid-slide, the CFO stops you.

"Where is this $14.2M coming from? My books show $11.8M."

The room goes silent.

Here's what actually went wrong.

It wasn't just the AI. It was the data underneath it. And this is a problem most revenue leaders don't see coming.

Getting your revenue data into one place is harder than it sounds.

Someone has to know where it lives across every system. Extract it. Normalize it. Stitch it together manually.

Most orgs just can't do that fast enough or completely enough for the AI to work with the whole picture.

So the AI fills in the gaps. And a confident wrong answer is worse than no answer at all.

Terret Nexus solves this data problem at its foundation.

We build the Revenue Graph -- pulling directly from your source systems, CRM, call transcripts, email, data warehouse -- so the AI is always working with complete, accurate data.

The number Terret gives you is the same number your CFO is looking at.
No surprises in the boardroom.

If you want to see it in action, I can kick you over a pre-recorded micro demo.

Just DM me.`,
  },
  {
    url: 'https://www.linkedin.com/posts/justinshriber_dashboards-are-post-mortems-they-tell-you-activity-7466134510158381056-jf5u?utm_source=share&utm_medium=member_desktop&rcm=ACoAAFAuo3YBLAPFVv8ObJ8FDefV9tf5Pm_QGXI',
    text: `Dashboards are post-mortems. They tell you the patient is dead, but they never tell you what actually killed them.

AI changes all this.

You have the answers. They are buried in thousands of hours of call transcripts and tens of thousands of emails.

But you don't have time to listen to 500 discovery calls. So you guess. And for a CRO with a $4M budget, guessing is a fast track to the exit.

We recently ran a loss analysis for a customer using Terret Nexus.

They thought they were losing on price. They were wrong.

Terret didn't just look at the CRM fields (half of that data is made up after the call anyway). It indexed every single call transcript and email.

They were losing 33% of the time when positioning their new acquisition.

It wasn't the price. It was a specific missing feature that reps couldn't defend.

The market headwinds were actually a product-knowledge gap.

Terret Nexus identified the exact $4M leak in minutes, not months, because we look across your entire revenue stack to find the 'why' behind the 'what'.

No more finger-pointing in the boardroom. No more "I think it's the economy."

Check out how we are doing it here -> terret.ai`,
  },
  {
    url: 'https://www.linkedin.com/posts/justinshriber_the-revops-diligence-problem-no-one-talks-activity-7464687409096511488-S0wT?utm_source=share&utm_medium=member_desktop&rcm=ACoAAFAuo3YBLAPFVv8ObJ8FDefV9tf5Pm_QGXI',
    text: `A RevOps leader told me recently they'd been put on the spot.

Their CRO asked why they were losing in a particular region, so they looked at the data, formed a hypothesis, and came back with an answer.

The CRO drilled in: how much diligence did you actually do?

The honest answer? They spot-checked.

Because the alternative was reviewing 450,000 pages of call transcripts, 2 million data warehouse updates, and 400,000 CRM updates.

This is the fundamental tension in revenue orgs right now.

The data exists. Humans just don't have the time to go through all of it.

That's the gap Terret Nexus closes.`,
  },
  {
    url: 'https://www.linkedin.com/posts/justinshriber_why-cros-still-cant-get-real-answers-from-activity-7463603809320087552-VthC?utm_source=share&utm_medium=member_desktop&rcm=ACoAAFAuo3YBLAPFVv8ObJ8FDefV9tf5Pm_QGXI',
    text: `CROs have spent the last decade investing in analytics platforms. Now AI.

They still can't answer their most basic questions.

What's driving the drop in my forecast?
What are my rainmakers doing that nobody else is?
Why do we keep losing to this competitor?

That's not a tools problem. The tools are fine.

The problem is that the data is like a puzzle whose pieces have been scattered all over a room.

CRM over here. Call transcripts over there. Email threads, ERP data, product usage -- all in separate systems, none of them talking to each other.

So when a platform tries to answer a question, it's only working with what it can see. And what it can see is never the whole picture.

The CROs getting real answers right now didn't buy a better platform. They built a complete picture first.

That's what we do at Terret.ai.`,
  },
  {
    url: 'https://www.linkedin.com/posts/justinshriber_5-of-your-reps-are-carrying-80-of-your-activity-7463242460580700162-fjBs?utm_source=share&utm_medium=member_desktop&rcm=ACoAAFAuo3YBLAPFVv8ObJ8FDefV9tf5Pm_QGXI',
    text: `5% of your reps are carrying 80% of your quota, yet nobody knows what they are doing to pull up the other reps... until now.

Revenue leaders: here's how we're solving this.

The closer DNA is hidden in your call transcripts.
You just haven't extracted it yet.

We ran an analysis for a client using Terret Nexus.

We didn't ask the reps what they did. We indexed over 100 of their actual calls to see the reality, and the data was a wake-up call.

- Top reps mention pricing in call one 78% of the time.
- Bottom reps wait until call three.

- Top reps multi-thread within 48 hours of discovery.
- Bottom reps wait 11 days or more.

The secret sauce was a specific cadence and a specific talk track, not magic.

Terret Nexus extracts the closer playbook directly from your best reps' transcripts and codifies the exact sequence that leads to a yes.

Then we deliver it as a custom meeting brief directly to every rep's workflow.

No more winging it. No more guessing what your top 1% are doing differently.

When you can clone what your best closers are doing and put it in front of every rep before their next call, the rest of the leaderboard starts to look a lot different.

The first time a VP of Sales sees this in action, it's hard to believe it's real.

If you want to see how it works, head to Terret.ai`,
  },
];

const posts: Post[] = RAW.map(({ url, text }) => ({
  id: postIdFromUrl(url),
  author: AUTHOR,
  url: url.trim(),
  text: text.trim(),
}));

const outPath = path.resolve(__dirname, '../seed/posts.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(posts, null, 2) + '\n');

console.log(`Wrote ${posts.length} posts -> ${outPath}`);
for (const p of posts) {
  console.log(`  ${p.id}  ${p.url.split('?')[0]}`);
}

// Fail loudly if the dedup key is not unique across the seed.
const ids = new Set(posts.map((p) => p.id));
if (ids.size !== posts.length) {
  console.error('FAIL: duplicate post ids in seed');
  process.exit(1);
}
