# Model Fieldbook

The Model Fieldbook at `/sandbox` is RouteTok's standalone model workspace. It does not load dashboard JavaScript or CSS and stores its browser state in the dedicated `routetok-model-fieldbook` IndexedDB database.

![Fieldbook Compare workspace](images/fieldbook-compare.png)

> Screenshots contain synthetic model data.

## Workspaces

| Mode | Purpose |
|---|---|
| Chat | Maintain one continuous model conversation with branches and reusable notes. |
| Compare | Run one to four independent text or image lanes without fallback obscuring model identity. |
| Room | Host a bounded alternating conversation among two to four configured collaborators. |
| Evaluate | Run repeatable assertions over one, three, or five samples per model. |
| Images | Generate one ephemeral image through an explicitly enabled OpenRouter image model. |
| Studio | Coordinate scoped agents over a browser-local virtual web project. |

Notes persist drafts, lineups, instructions, generation settings, text results, evaluations, Room state, scratchpad state, and Studio state. JSON/Markdown exports and atomic JSON imports exclude the dashboard token and ephemeral media bytes.

## Chat And Compare

- Compare up to four independent lanes, including repeated model IDs.
- Continue any successful result as a new single-model note.
- Fork before a selected response while preserving earlier branch context.
- Estimate context utilization and input/output cost from current catalog metadata.
- Use an output-byte limit from 1 to 64 MiB independently of provider `max_tokens`.
- Recognize raw or fenced SVG and self-contained HTML as passive preview artifacts.

Titles receive an immediate deterministic fallback from the first activity and may be improved once by a catalog-confirmed free text model. Manual titles are never replaced. Selecting a note does not alter its modification time or library order.

## Explicit Context

Chat, Room, and Studio provide a one-shot Context picker. Available note-local resources include the scratchpad, Studio manifest and files, recent Room transcript, and active Chat/Compare branches.

Attachments are frozen at dispatch, labelled with provenance and revision, displayed with the resulting user event, and treated as untrusted model data. They are rejected rather than truncated above these limits:

- 8 resources
- 60,000 characters per resource
- 120,000 characters total

## Room And Scratchpad

![Fieldbook Room workspace](images/fieldbook-room.png)

Room supports two to four collaborators with independent names, models, personalities, and private system prompts. Automatic replies alternate under a visible 0-30 turn budget and 10-300 second per-turn deadline. User interjections consume no automatic turns. Escape, leaving Room, changing notes, or reloading pauses active work.

The shared scratchpad is a separate revisioned browser-local document. It can be pinned as a column, opened as a modal drawer, or minimized to the restore rail. Valid fenced unified diffs can be reviewed and applied manually; Room may auto-apply them when explicitly enabled. No scratchpad operation writes to the filesystem.

## Evaluate

Evaluate supports exact, contains, JSON-valid, and structural JSON-equals assertions. A bounded client queue runs at most four samples concurrently without retries. Each saved run freezes its models, instructions, generation parameters, and assertions.

Results distinguish requested, completed, passed, failed, errored, and cancelled samples. Reports include end-to-end pass/completion rates, median and nearest-rank p95 timing, throughput, tokens, provider-reported cost, expandable samples, JSON export, and formula-safe CSV export.

## Images

The Images workspace uses explicitly enabled OpenRouter image-output models. It accepts common aspect ratios, quality settings, and PNG, JPEG, WebP, or passive SVG output. One generation may run at a time.

Enabling an image model in the dashboard is the spending boundary for direct Images-mode requests. Returned bytes remain memory-only, do not enter notes or exports, and disappear on reload unless explicitly downloaded.

## Iteration Studio

![Fieldbook Iteration Studio](images/fieldbook-studio.png)

Each note owns a virtual project containing `index.html`, `styles.css`, and `app.js`. Studio never accesses repository or filesystem files. Manual edits update an opaque preview with network access blocked; JavaScript is opt-in and still runs without same-origin access.

One to four agents rotate under a visible 0-20 iteration budget and 10-300 second deadline. Each agent has a role, personality, private system prompt, and host-enforced file scope. Code and Canvas can be columns, accessible modal drawers, or minimized utilities. Canvas snapshots preserve the selected device aspect ratio when popped out.

Agents communicate through browser-enforced Iteration Tool envelopes:

- `apply_patch` proposes a bounded safe-path unified diff.
- `leave_handoff` records decisions, open issues, and recommended next work.
- `request_review` pauses for review without changing files.
- `request_image` creates an approval card but performs no provider call.

Every mutation is bound to the current monotonic project revision. Accepted patches are scope-checked, validated, applied atomically, snapshotted, and recorded in a host-authored ledger. Failures pause the loop, refund the iteration, preserve evidence, and expose retry/skip recovery.

Studio steering is a separate persisted advisory conversation. Steering patches remain pending until explicitly accepted or rejected. Studio image requests require per-request approval and are revalidated immediately before the single provider call. Rejected or stale requests make no provider call, and generated bytes are not inserted into project files.

## Roster Architect

Chat, Room, and Studio each provide a setup-only Roster Architect. A catalog-confirmed free advisor drafts editable behavior, collaborators, roles, scopes, budgets, deadlines, and briefs. Proposals are schema-validated and shown for review; generating or applying a roster never starts a conversation or iteration.

## Storage And Limits

- Browser state: `routetok-model-fieldbook` IndexedDB
- Server conversation window: at most 40 messages after client-side bounding
- Studio files: safe virtual paths and bounded file count/project size
- Studio snapshots: latest 30
- Steering messages: latest 80
- Output bytes: 4 MiB by default, configurable from 1 to 64 MiB
- Audio and image bytes: ephemeral and excluded from IndexedDB
