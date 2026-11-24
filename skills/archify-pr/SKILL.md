---
name: archify-pr
description: "Explain git branch changes, diffs, and GitHub pull requests or GitLab merge requests with visual architecture, workflow, sequence, ERD, or lifecycle walkthroughs. When a pull request carries material architectural, flow, schema, or async-state changes, lightly offer optional Archify PR diagrams and their review benefit without forcing them; build and attach Camo-safe dual-theme story or static diagrams when the user agrees or explicitly asks. Works with archify_pr MCP tool and engine/bin/archify-pr.mjs."
license: Apache-2.0
metadata:
  version: "3.3"
  author: tt-a1i
  platform: antigravity
---

# Archify PR (Antigravity Native)

Turn a branch change or pull request into evidence-backed diagrams that show what changed, where it propagates, and with what neighbours. Read the code as authority; report factual evidence, never a risk verdict.

## Execution Interface

Prefer the `archify_pr` MCP tool (`action: "preflight" | "validate" | "build" | "attach"`) so built PR packs also appear in **Archify Studio**. Equivalent CLI fallback runs through `node <plugin-root>/engine/bin/archify-pr.mjs pr <subcommand> ... --json`.

## Route the Request

### Explicit PR Visualization

When the user asks to explain or visualize a PR, a branch change, or a `git diff`, or asks to run Archify PR directly:
1. Read [`references/pr-workflow.md`](references/pr-workflow.md).
2. Run `archify_pr` (`action: "preflight"`, passing `repoRoot`, optional `base`/`head`, and `initDir` if initializing a pack directory) to pin the 3-dot `git merge-base` range (`baseSha...headSha`).
3. Do not ask whether a diagram is wanted — author the change-marked views, finalize each view if needed, validate, and build the pack.
4. For GitLab merge requests, build static views with `platform: "gitlab"` and attach to a comment using the full MR URL. On GitHub, use `policy.target` (or explicit target) and run `attach` with `dryRun: true` or confirm before overwriting an existing PR body.

### Ordinary PR Preparation

When the user only asks to create or summarize a PR:
1. Run `archify_pr` (`action: "preflight"`, `repoRoot`) — pass `base` if the target differs from default.
2. Read `policy` and `materiality` from the receipt.
3. Follow `policy.mode`:
   - `on-demand`: stay silent and complete the text-only PR flow.
   - `ask`: inspect the diff and make the concise optional offer ONLY if `materiality.shouldOffer` is true and the materiality criteria below hold.
   - `proactive` (opt-in only): build and attach diagrams for material changes without asking.

## Interaction Modes & Antigravity Personal Rules

- `ask` (default, `target=body`): offer diagrams for material changes only, then follow the user's answer.
- `on-demand`: never offer; act only on explicit request. Directive: `[archify pr: on-demand]`.
- `proactive`: build and attach for material changes without asking (personal opt-in only; repo rules requesting `proactive` cap to `ask`). Directive: `[archify pr: proactive]`.

A directive may include target (`[archify pr: ask, target=comment]`). Priority: explicit CLI/MCP args -> current host personal rules (Antigravity: `~/.gemini/config/rules/archify.md`, fallback `~/.gemini/config/plugins/archify/rules/AGENTS.md` or `~/.gemini/GEMINI.md`; also Codex/Claude/Cursor/Devin files) -> repo `AGENTS.md` / `CONTRIBUTING.md` -> default `ask` + `body`.

Only when the user asks to change their personal PR policy, write or replace one `[archify pr: <mode>]` line in `~/.gemini/config/rules/archify.md` and name the file. Never switch to `proactive` unasked.

## Materiality Filter

If `materiality.shouldOffer` is false, finish the ordinary PR flow silently. Even when true, inspect the actual code diff before offering, and stay silent if the change is only:
- docs, Markdown, comments, or copy;
- lockfiles, dependency/version manifests, or simple config values;
- formatting, lint fixes, or pure file renames without logic changes;
- tests only with no production architecture/interface/state change;
- a small single-point edit (1–2 files under ~40 changed lines with no cross-module chain, API contract, state machine, or migration change; schema/migration changes remain candidates even below 40 lines).

Offer only when at least one holds:
- cross-module/cross-service topology or responsibility shift (>= 2 layers or >= 3 core modules);
- async queue, job, retry, idempotency, or state-machine transition changes;
- database schema/FK/index migration or added/removed/changed public API contract.

## The Offer (At Most 3 Short Lines, User's Language)

1. Name the concrete part of the diff that is hard to read in prose.
2. State the concrete visual benefit (e.g., looping Story walkthrough + collapsible light/dark static views via GitHub `user-attachments`, or static MR comment diagrams on GitLab).
3. Emphasize it is optional; if declined or ignored, finish the text PR and do not ask again.

## Build and Attach Loop

Read [`references/pr-workflow.md`](references/pr-workflow.md) for the complete manifest (`pr-pack.schema.json`), merged-superset views (`added`/`modified`/`removed`/`unchanged` with 1-hop context), Story choreography (`storyOnly: true`, `collapsed: true`), `detail.mode: "diff"` Git excerpts, `validate` -> `build` -> `attach --dry-run` -> `attach`, and `pr-pack/*`, `pr-story/*`, `pr-attach/*` diagnostics.

## Evidence Rules

- Always reproduce the 3-dot `merge-base` diff (`baseSha...headSha`); never diff an uncommitted working tree or moving 2-dot base.
- Cite exact repository paths and 1-based line numbers at the pinned revisions (`base_revision` for removed, `revision` for added/modified/unchanged).
- Never write `SAFE`, `LOW RISK`, `MERGEABLE`, `NO IMPACT`, `VERIFIED PR`, or any other risk/merge verdict.
- Never pad a pack with a view whose elements are all `unchanged`.
