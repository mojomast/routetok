import assert from "node:assert/strict";
import test from "node:test";
// Browser modules are intentionally plain JavaScript and exercised directly here.
// @ts-expect-error No declaration file is emitted for static browser modules.
import { createImageApprovals, normalizeLogicalImagePath, validateImageRequest } from "../../public/fieldbook/image-approvals.js";

test("Studio image paths are canonical and format compatible", () => {
  assert.equal(normalizeLogicalImagePath("assets/hero.png", "png"), "assets/hero.png");
  assert.equal(normalizeLogicalImagePath("images/hero.jpg", "jpeg"), "images/hero.jpg");
  assert.equal(normalizeLogicalImagePath("images/hero.webp", "auto"), "images/hero.webp");
  for (const path of ["", "/hero.png", "./hero.png", "assets//hero.png", "assets/../hero.png", "assets/hero.gif", "https://example.test/hero.png", "assets/hero.png?x=1", "assets/%2e%2e/hero.png"]) {
    assert.throws(() => normalizeLogicalImagePath(path, "auto"), /image|path/i, path);
  }
  assert.throws(() => normalizeLogicalImagePath("assets/hero.png", "webp"), /does not match/);
});

test("Studio image requests require a bounded logical project path", () => {
  const request = validateImageRequest({
    version: 2,
    id: "image_test",
    tool: "request_image",
    arguments: {
      model: "openrouter:openai/gpt-5.4-image-2",
      prompt: "A local test image",
      aspectRatio: "auto",
      quality: "auto",
      outputFormat: "auto",
      projectPath: "assets/hero.png",
      baseRevision: 3,
      summary: "Generate one hero"
    }
  }, 3);
  assert.equal(request.projectPath, "assets/hero.png");
  assert.throws(() => validateImageRequest({ ...request, version: 2, id: "image_test", tool: "request_image", arguments: { ...request, projectPath: undefined } }, 3), /project path/);
});

test("image approval revalidates before and after exactly one generation", async () => {
  const owner = { id: "note" };
  const card = { status: "pending", request: { model: "openrouter:model", prompt: "test", aspectRatio: "auto", quality: "auto", outputFormat: "auto" } };
  let validations = 0;
  let generations = 0;
  let results = 0;
  const approvals = createImageApprovals({
    validate: () => { validations += 1; },
    generate: async () => { generations += 1; return { images: [{}] }; },
    onResult: async () => { results += 1; },
    save: async () => {},
    onStatus: () => {}
  });
  await approvals.approve(card, owner);
  await approvals.approve(card, owner);
  assert.equal(card.status, "generated");
  assert.equal(validations, 2);
  assert.equal(generations, 1);
  assert.equal(results, 1);
});
