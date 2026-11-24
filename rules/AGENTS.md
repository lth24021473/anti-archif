# Archify Antigravity Rules

Use the Archify MCP tools (`archify_diagram`, `archify_explainer`, `archify_compare`, `archify_story`, `archify_pr`, `archify_code_analysis`, `archify_guide_and_catalog`, `archify_studio`) and skills (`archify`, `archify-pr`) when visualizing systems, processes, schemas, comparisons, repository architecture health, stories, or git pull requests.

## Routing & Artifacts

- **Native Diagrams (10 types)**: `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`, `erd`, `class`, `tree`, `timeline`, `waterfall`. Write candidate JSON into `.archify/<type>-<slug>-<YYYYMMDD-HHMMSS>/candidate.json` and run `archify_diagram` (`action: "finalize"`).
- **One-Page Explainers**: Write `.archify md` / JSON draft and run `archify_explainer` (`action: "finalize"`). Default mode is `proactive` unless overridden by `[archify explainer: on-demand|always-on|proactive]` in `~/.gemini/config/rules/archify.md` or workspace rules.
- **PR Visual Packs**: For explicit diff/PR visualization or material PR preparation, follow `archify-pr` using `archify_pr` (`preflight` -> `validate` -> `build` -> `attach`). Default PR mode is `ask` (`target=body`) unless overridden by `[archify pr: ...]`.
- **Code Analysis**: Run `archify_code_analysis` (`prepare`, `check`, `task`, `verify-change`, `drift`, `verify-drift`, `import-review`, `start_server`). Never fabricate coupling metrics or cycle claims without running the analyzer.
- **Interactive Preview**: Call `archify_studio` to open any finished artifact inside Antigravity's side pane.

## Truth Boundary

- Every node, relationship, route, reachability claim, source citation, and PR diff must come from authored input or verified repository / Git evidence (`--repo-root` with pinned commits).
- Distinguish **automated checks passed** (`finalize` / `browser-check`) from **visual inspection** (`visual-check` PNG captures inspected via `read_file`). Never claim visual review without inspecting rendered captures.
- Never invent risk verdicts (`SAFE`, `LOW RISK`, `MERGEABLE`, `VERIFIED PR`) in PR packs or Code Analysis summaries; report factual counts and evidence.
- In final user responses, link local HTML/SVG artifacts using clickable `file:///` links (forward slashes) alongside the concise takeaway.
