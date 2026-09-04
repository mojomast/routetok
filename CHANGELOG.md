# Changelog

## Unreleased

- Sandbox model output is unlimited by default; an optional 1-64 MiB per-note cap can still be set.
- Added read-only admin endpoints `GET /admin/api/attempts/decode`, `GET /admin/api/route/simulate`, and `GET /admin/api/models/visibility` with dashboard authentication.
- Added dashboard Attempt Inspector, API Setup test request, onboarding wizard, and Fieldbook backup modules with script-tag mounts and static serving.
- Added docs/onboarding.md plus dashboard, API, README, and changelog pointers for the new operational workflows.

- Added the standalone Model Fieldbook with Chat, Compare, Room, Evaluate, Images, and Iteration Studio workspaces.
- Added explicit bounded cross-workspace context, a shared revisioned scratchpad, Roster Architect, branching, generated titles, artifact previews, and configurable sandbox output limits.
- Added browser-enforced Studio patch, handoff, review, steering, file-scope, revision, snapshot, rollback, and image-approval workflows.
- Added bounded image generation, OpenRouter speech, Requesty/local Speaches transcription, and ephemeral media handling.
- Added the static image-model benchmark gallery and expanded browser/integration coverage.
- Added scoped AgentRouter DeepSeek compatibility for historical Anthropic tool blocks.
- Unified Code, Canvas, and Scratchpad under concurrent modeless drawers and redesigned Studio so agent activity and steering use the remaining workspace.
- Focused the dashboard Support workspace on RouteTok operations and added a visible API setup and write-only provider-key management section.
- Moved runtime telemetry to the dashboard header area, removed the System card, hid unconfigured provider status cards, and added persisted Route Health model visibility and sorting controls.
- Converted API Setup into a dismissible drawer and added generated, hashed, individually revocable proxy client API keys alongside the existing environment key.
- Added a hardened multi-stage Docker image and loopback-only Compose deployment with persistent runtime state.
- Added a dedicated paid OpenRouter fallback order that preserves OpenRouter alternatives before AgentRouter last-resort routes.
- Documented and verified exact paid OpenRouter routing, pre-output retry boundaries, request preservation, terminal routing metadata, and focused Qwen diagnostics.
- Made failed catalog discovery retry after a short backoff instead of waiting for the normal freshness interval, while preserving the last usable catalog.
- Filtered `/v1/models` to configured, enabled, text-capable routes and made fallback capability checks reject only explicit incompatibilities while retaining candidates with unknown metadata.
- Added opt-in RouteTok model metadata schema v1 to `/v1/models?include=routetok` and corresponding scoped metadata on admin status, sandbox catalog, and image capability responses while preserving the strict-compatible default model list.
- Corrected model-entitlement `403` classification, Responses cache-token accounting, blank credit handling, managed-key internal authentication, concurrent key mutation safety, persisted metrics normalization, image request limits/status, and the default speech format.
- Hardened local and CI operations with isolated mock-only integration environments, bounded child-process teardown, recursive test discovery, Compose validation, Dockerfile checks, and retrying local STT model initialization.

## 0.1.0 - 2026-09-02

- Initial public RouteTok release.
- Multi-provider OpenAI/Anthropic routing and health-aware failover.
- Dashboard, metrics, sandbox, design catalog, custom cascades, configuration proposals, and write-only key management.
