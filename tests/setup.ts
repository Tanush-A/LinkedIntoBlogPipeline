// tests/setup.ts
// Runs once per test worker before any test file. loadPosts/regenerate now read posts
// from the DB (not the seed file), so the posts table must be populated. _resetDbForTesting
// only clears drafts, so this seed-sync survives across tests within a file.

import { syncSeedToDb } from '../src/lib/seed';

syncSeedToDb();
