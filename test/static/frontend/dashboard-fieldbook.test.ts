import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  dashboardHtml: "public/index.html",
  dashboard: "public/app.js",
  fieldbook: "public/sandbox.js",
  contextBroker: "public/fieldbook/context-broker.js",
  imageApprovals: "public/fieldbook/image-approvals.js",
  studioChat: "public/fieldbook/studio-chat.js"
} as const;

test("dashboard paid fallback controls are wired to the persisted configuration field", async () => {
  const [html, script] = await Promise.all([readFile(files.dashboardHtml, "utf8"), readFile(files.dashboard, "utf8")]);
  assert.match(html, /id="paidOpenRouterFallbackOrder"/);
  assert.match(html, /id="paid-openrouter-order-list"[^>]*data-protocol="paid-openrouter"/);
  assert.match(script, /"paid-openrouter":\s*"paidOpenRouterFallbackOrder"/);
  assert.match(script, /paidOpenRouterFallbackOrder:\s*lines\("paidOpenRouterFallbackOrder"\)/);
  assert.match(script, /byId\("refresh-status"\)\?\.addEventListener\("click", \(\) => void refreshDashboard\(\)\)/);
  assert.match(script, /mode === "diagnose" && Number\.isInteger\(context\.turnIndex\)/);
  assert.match(script, /CONFIG_DIRTY_FIELDS\.has\(event\.target\.id\)/);
  assert.match(script, /CONFIG_NUMBER_FIELDS\.map\(\(id\) => byId\(id\)\)\.find/);
});

test("Fieldbook module contracts preserve note identity and image option filtering", async () => {
  const [fieldbook, contextBroker, imageApprovals, studioChat] = await Promise.all([
    readFile(files.fieldbook, "utf8"),
    readFile(files.contextBroker, "utf8"),
    readFile(files.imageApprovals, "utf8"),
    readFile(files.studioChat, "utf8")
  ]);

  assert.match(fieldbook, /createContextBroker\(\{[^}]*getIdentity:\(\)=>state\.conversation\?\.id/);
  assert.match(contextBroker, /conversationId:\s*identity/);
  assert.match(fieldbook, /generate:\(body\)=>\{[^}]*imageRequestOptions\(model,body\)/);
  assert.match(imageApprovals, /validate\?\.\(card, owner\)/);
  assert.match(fieldbook, /save:\(conversation\)=>saveConversation\(true,conversation\)/);
  assert.match(fieldbook, /getConversation:\(\)=>state\.conversation/);
  assert.match(studioChat, /isActive\(conversation\)/);
  assert.match(studioChat, /getTimeoutMs\(conversation\)/);
  assert.match(fieldbook, /getTimeoutMs:\(conversation\)=>studioState\(conversation\)\.maxSeconds\*1000/);
  assert.match(fieldbook, /\^\(\?:studioLane\|steeringLane\)_/);
  assert.match(fieldbook, /studioRequest \? \{ \.\.\.parameters\(studioConversation \|\| state\.conversation\), \.\.\.params \} : params/);
  assert.match(fieldbook, /model:agent\.model\},messages,parameters\(conversation\),signal/);
  assert.match(fieldbook, /state\.deletedIds\.add\(id\)/);
  assert.match(fieldbook, /renderStudioLog\(studio,state\.conversation\)/);
  assert.match(fieldbook, /<iteration-tool>\$\{example\}<\/iteration-tool>/);
  assert.match(fieldbook, /baseRevision:studio\.revision/);
  assert.match(fieldbook, /function repairableStudioFailure\(entry\)/);
  assert.match(fieldbook, /automaticRepair = true/);
  assert.match(fieldbook, /repairSucceeded \? Math\.max\(0, remaining - 1\) : remaining/);
  assert.match(fieldbook, /state\.studioRepairConversation = conversation/);
  assert.match(fieldbook, /const frozenAgent =/);
  assert.match(fieldbook, /originalRemaining: remaining, failure/);
  assert.match(fieldbook, /function installStudioAsset\(card, result, conversation\)/);
  assert.match(fieldbook, /data-routetok-ephemeral-asset/);
  assert.match(fieldbook, /bindStudioAssets\(parsed, conversation\)/);
  assert.match(fieldbook, /Studio diff hunk count mismatch/);
  assert.match(fieldbook, /fieldbook\/showcases\/manifest\.json/);
  assert.match(fieldbook, /routetok-fieldbook-showcases-version/);
  assert.match(fieldbook, /loadBundledShowcaseAssets\(manifest\)/);
  assert.match(fieldbook, /!Array\.isArray\(model\?\.supportedParameters\)/);
  assert.match(fieldbook, /values\.outputFormat !== "auto"/);
  assert.match(imageApprovals, /\["auto", "png", "jpeg", "webp", "svg"\]/);
});
