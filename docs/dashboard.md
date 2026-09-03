# Dashboard

The RouteTok dashboard at `/dashboard` is the operations and configuration surface for the proxy. It uses the same server-side catalog, routing policy, health state, and usage records as the inference endpoints.

![RouteTok dashboard with synthetic telemetry](images/dashboard-overview.png)

> Screenshots contain synthetic data.

## Operations

The dashboard exposes:

- Provider availability, catalog freshness, key status, and credit information
- Protocol-specific quality orders and the verified free-model order
- Explicit enablement for paid or unknown-price external models
- Named custom cascades with ordered physical members
- Active requests, route attempts, circuit state, failures, and bounded request inspection
- Historical request counts, latency, TTFT, throughput, token/cache usage, and provider-reported cost
- Theme, layout, chart, and workspace controls stored in the browser

Provider credentials entered through the dashboard are write-only. RouteTok stores them under `DATA_DIR/secrets/provider-credentials.json` with an owner-only directory and file permissions and never returns key material to the browser.

## Assistant

The dashboard assistant can explain setup and routing, diagnose observed failures, plan comparisons, and prepare routing configuration proposals. It retrieves only the bounded operational resources required for the current question.

The assistant cannot access provider secrets, environment files, the filesystem, shell commands, or raw retained request bodies. Configuration proposals are typed, editable, revision-bound, revalidated after edits, and require a separate exact-diff confirmation before application.

## Arena

The dashboard arena provides independent Chat, Design, and Agent workstreams. Each workstream retains its own draft, lineup, settings, results, and scroll position.

- Run up to four independent lanes, including repeated models for variance checks.
- Preserve lane-specific multi-turn branches and retry failed cards independently.
- Use provider-default output limits or explicit generation settings.
- Inspect route, provider, endpoint, attempt, timing, token, cache, throughput, and cost evidence.
- Save completed runs in browser IndexedDB.
- Render static generated designs inside opaque, network-blocked iframes.

The arena also supports catalog-confirmed free OpenRouter text-to-speech and transcription through local Speaches or an approved Requesty model. Audio, filenames, and unreviewed transcripts remain ephemeral; transcripts require review before insertion and are never sent automatically.

## Dashboard And Fieldbook

The dashboard is optimized for operating RouteTok. The standalone [Model Fieldbook](fieldbook.md) at `/sandbox` is optimized for persistent model experimentation, evaluation, bounded model rooms, images, and virtual-project iteration. The two applications have separate browser storage and frontend assets while sharing authenticated server capabilities.
