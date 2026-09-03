# Dashboard

The RouteTok dashboard at `/dashboard` is the operations and configuration surface for the proxy. It uses the same server-side catalog, routing policy, health state, and usage records as the inference endpoints.

![RouteTok dashboard with Support and API setup](images/dashboard-overview.png)

> The screenshot shows a local development instance and contains no credential values.

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

## Support Agent

RouteTok Support is the dashboard's only conversational workspace. It can explain setup and routing, diagnose observed failures, help with onboarding, and prepare routing configuration proposals. General model chat and comparison workflows live in the standalone Fieldbook.

Support retrieves only the bounded operational resources required for the current question. It cannot access provider secrets, environment files, the filesystem, shell commands, or raw retained request bodies. Configuration proposals are typed, editable, revision-bound, revalidated after edits, and require a separate exact-diff confirmation before application.

## API Setup

The Connect Applications panel keeps client setup visible beside operational telemetry. It provides:

- The origin-derived OpenAI-compatible `/v1` base URL
- Chat Completions, Responses, Anthropic Messages, and model-list endpoint references
- A copyable curl example that reads `ROUTETOK_PROXY_KEY` from the caller's environment
- Current client-authentication status without exposing `PROXY_API_KEY`
- Direct access to write-only upstream provider credential management

Client authentication and provider credentials are separate. `PROXY_API_KEY` protects inference calls and remains startup-managed through the server environment. Provider credentials authorize RouteTok to call upstream services and can be replaced or disabled through the dashboard without ever being returned to the browser.

## Dashboard And Fieldbook

The dashboard is optimized for operating RouteTok. The standalone [Model Fieldbook](fieldbook.md) at `/sandbox` is optimized for persistent model experimentation, evaluation, bounded model rooms, images, and virtual-project iteration. The two applications have separate browser storage and frontend assets while sharing authenticated server capabilities.
