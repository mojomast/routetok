import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  onboarding: "public/onboarding.js",
  backup: "public/fieldbook/backup.js"
} as const;

test("onboarding wizard exposes the mount API with injected auth fetch", async () => {
  const script = await readFile(files.onboarding, "utf8");
  assert.match(script, /window\.Onboarding/);
  assert.match(script, /mount:\s*onboardingMount/);
  assert.match(script, /function onboardingMount\(el,\s*options\)/);
  assert.match(script, /options\s*&&\s*options\.fetchWithAuth/);
  assert.match(script, /defaultFetchWithAuth/);
  assert.match(script, /x-dashboard-token/);
  assert.match(script, /unmount/);
});

test("onboarding wizard follows the five-step state machine in order", async () => {
  const script = await readFile(files.onboarding, "utf8");
  assert.match(script, /"key-status",\s*"catalog",\s*"free-model",\s*"test-prompt",\s*"success"/);
  assert.match(script, /function onboardingInitialState\(\)/);
  assert.match(script, /function onboardingNextStep\(state\)/);
  assert.match(script, /function onboardingPrevStep\(state\)/);
  assert.match(script, /Math\.min\(index \+ 1, ONBOARDING_STEPS\.length - 1\)/);
  assert.match(script, /Math\.max\(index - 1, 0\)/);
  assert.match(script, /nextStep:\s*onboardingNextStep/);
  assert.match(script, /prevStep:\s*onboardingPrevStep/);
  assert.match(script, /evaluateReadiness/);
  assert.match(script, /evaluateCatalog/);
  assert.match(script, /evaluateFreeModel/);
});

test("onboarding wizard checks are read-only and never write config", async () => {
  const script = await readFile(files.onboarding, "utf8");
  assert.match(script, /\/admin\/api\/readiness/);
  assert.match(script, /\/admin\/api\/status/);
  assert.match(script, /\/admin\/api\/sandbox\/catalog/);
  assert.match(script, /never writes configuration/);
  assert.doesNotMatch(script, /"POST"/);
  assert.doesNotMatch(script, /"PUT"/);
  assert.doesNotMatch(script, /"PATCH"/);
  assert.doesNotMatch(script, /"DELETE"/);
  assert.doesNotMatch(script, /localStorage\.setItem/);
  assert.doesNotMatch(script, /method:/);
});

test("onboarding wizard links each failing step to troubleshooting", async () => {
  const script = await readFile(files.onboarding, "utf8");
  assert.match(script, /docs\/troubleshooting\.md#dashboard-authentication/);
  assert.match(script, /docs\/troubleshooting\.md#no-models/);
  assert.match(script, /docs\/troubleshooting\.md#model-appears-but-fails/);
  assert.match(script, /docs\/troubleshooting\.md#fieldbook-state-looks-stale/);
  assert.match(script, /TROUBLESHOOTING\[id\]/);
  assert.match(script, /TROUBLESHOOTING\[currentId\]/);
  assert.match(script, /ONBOARDING_TEST_PROMPT/);
  assert.match(script, /Reply with OK/);
});

test("fieldbook backup exposes the bundle API surface", async () => {
  const script = await readFile(files.backup, "utf8");
  assert.match(script, /window\.FieldbookBackup/);
  assert.match(script, /exportBundle/);
  assert.match(script, /mergeBundle/);
  assert.match(script, /estimateQuota/);
  assert.match(script, /originWarningText/);
  assert.match(script, /sanitizeRecord/);
  assert.match(script, /async function mergeBundle\(bundle,\s*options\)/);
  assert.match(script, /async function estimateQuota\(\)/);
  assert.match(script, /function exportBundle\(source\)/);
});

test("fieldbook export reuses the bundle shape and excludes secrets", async () => {
  const script = await readFile(files.backup, "utf8");
  assert.match(script, /routetok-fieldbook/);
  assert.match(script, /exportedAt/);
  assert.match(script, /conversations/);
  assert.match(script, /evalSuites/);
  assert.match(script, /evalRuns/);
  assert.match(script, /FIELDBOOK_BACKUP_TOKEN_KEYS/);
  assert.match(script, /FIELDBOOK_BACKUP_EPHEMERAL_KEYS/);
  assert.match(script, /dataUrl/);
  assert.doesNotMatch(script, /routetok-dashboard-token/);
  assert.doesNotMatch(script, /agentrouter-dashboard-token/);
});

test("fieldbook merge skips duplicates by id and revision with counts", async () => {
  const script = await readFile(files.backup, "utf8");
  assert.match(script, /function isDuplicate\(existing,\s*incoming\)/);
  assert.match(script, /existing\.id === incoming\.id/);
  assert.match(script, /revisionOf\(existing\) === revisionOf\(incoming\)/);
  assert.match(script, /function revisionOf\(record\)/);
  assert.match(script, /skipped \+= 1/);
  assert.match(script, /added \+= 1/);
  assert.match(script, /return \{ added, skipped, errors \}/);
  assert.match(script, /\{\s*\.\.\.backupClone\(record\)\s*\}/);
  assert.match(script, /validateBundle/);
  assert.match(script, /FIELDBOOK_BACKUP_MAX_RECORDS/);
});

test("fieldbook backup warns about origin-bound storage with namespaced keys", async () => {
  const script = await readFile(files.backup, "utf8");
  assert.match(script, /navigator\.storage/);
  assert.match(script, /storage\.estimate/);
  assert.match(script, /routetok-model-fieldbook/);
  assert.match(script, /routetok-fieldbook-backup-last-merge-v1/);
  assert.match(script, /routetok-fieldbook-backup-origin-v1/);
  assert.match(script, /IndexedDB/);
  assert.match(script, /browser profile/);
  assert.match(script, /docs\/troubleshooting\.md#fieldbook-state-looks-stale/);
  assert.doesNotMatch(script, /routetok-dashboard-token/);
});
