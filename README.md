# Archify for Antigravity (v3.3.0 Parity Edition)

Kiến trúc lại toàn bộ mã nguồn [`tt-a1i/archify`](https://github.com/tt-a1i/archify) thành một **Antigravity Plugin + Stdio MCP Server + Interactive MCP App Studio** hoàn chỉnh, giữ **100% chức năng tương đương bản gốc** và tối ưu sâu cho hệ sinh thái Google Antigravity.

## Kiến trúc Antigravity-Native

```text
d:\archif\
├── plugin.json             # Manifest chuẩn Antigravity Plugin (metadata + suggestedPrompts)
├── mcp_config.json         # Stdio MCP server dùng ${PLUGIN_ROOT} và ${PLUGIN_DATA}
├── hooks.json              # SessionStart lifecycle hook tại root plugin
├── hooks/session-context.mjs
├── rules/AGENTS.md         # Quy tắc thuần Markdown (không frontmatter) luôn nạp khi plugin bật
├── assets/logo.svg         # Logo vector 128x128 tương phản cao cho dark/light theme
├── skills/
│   ├── archify/            # Skill chính + full authoring/delivery/story/explainer/PR references
│   └── archify-pr/         # Skill PR Diff & Forge Attach với phát hiện rule Antigravity
├── agents/                 # 4 Subagent chuyên trách (architect, visual-reviewer, code-analyst, pr-visualizer)
├── mcp/
│   ├── server.mjs          # 8 model tools + 4 app-only tools + ui://archify/viewer.html
│   ├── runner.mjs          # Engine runner, artifact store & bộ trích xuất SVG/JSON an toàn
│   ├── app/                # Giao diện Archify Studio viết bằng @modelcontextprotocol/ext-apps
│   └── dist/viewer.html    # Bundle 1 file HTML duy nhất (<500 KiB, CSP-safe)
├── engine/                 # Toàn bộ runtime v3.3.0 (10 renderers, explainer, story, delta, pr, code-analysis)
├── viewer/                 # Nguồn standalone Viewer + script scripts/generate-viewer.mjs
├── scripts/                # build-mcp-app.mjs, generate-viewer.mjs, install-antigravity.mjs, verify-parity.mjs
└── test/                   # plugin-contract.test.mjs, engine-parity.test.mjs, mcp-server.test.mjs
```

## Bảng đối chiếu đầy đủ chức năng (100% Parity)

| Nhóm chức năng upstream (`tt-a1i/archify`) | Triển khai Antigravity | Giao diện MCP / CLI |
|---|---|---|
| 10 loại sơ đồ (`architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`, `erd`, `class`, `tree`, `timeline`, `waterfall`) | Toàn bộ renderer, JSON schema, brand marks, showcase & standard quality | `archify_diagram` (`finalize`, `validate`, `inspect`, `render`, `deliver`, `check`, `browser-check`, `visual-check`, `export-svg`, `migrate`, `recover-output`) |
| One-Page Explainer (4 style + Pele charts + patch panel) | Đầy đủ parser, writer lint, patch panel & `proactive`/`on-demand`/`always-on` | `archify_explainer` (`finalize`, `validate`, `render`, `deliver`, `patch`, `check`, `browser-check`, `visual-check`) |
| Architecture Delta Comparison | So sánh `base` vs `head`, diff SVG & receipt thay đổi | `archify_compare` |
| Guided Story & Video 1080p | `scan`/`draft`/`attach` vào Viewer + choreography `svg`/`stage`/`video` (MP4/WebM) | `archify_story` |
| PR Visual Packs (GitHub & GitLab) | Merge-base 3-dot diff, materiality filter, nhận diện rule Antigravity (`~/.gemini/config/rules/archify.md`), Camo-safe SVG | `archify_pr` (`preflight`, `validate`, `build`, `attach`) |
| Code Analysis (TS/JS, Python, Java, Go, Rust, C/C++) | `prepare` workbench, `check` CI/baseline, `task` tái cấu trúc, `verify-change`, `drift`, `verify-drift`, `import-review`, preview server | `archify_code_analysis` |
| Guide, Brand Marks, Examples, Doctor, Demo, Update Notice | Tra cứu guide, brand catalog/URL capture, JSON schemas, snooze/ignore update | `archify_guide_and_catalog` |
| Interactive Viewer | Tự động mở trong **Archify Studio** (Side Pane `aux_pane` & Sidebar `global`): pan/zoom, Semantic Passport, đồng bộ theme sáng/tối, click mở file nguồn qua `com.google.antigravity/toggle-aux-pane`, đính kèm ngữ cảnh (`updateModelContext`), hỏi agent (`sendMessage`) | `archify_studio` + `ui://archify/viewer.html` |

## Kiểm tra & Cài đặt vào Antigravity

```powershell
# Kiểm tra toàn bộ hệ thống & test suite
npm run verify
npm test

# Cài đặt vào Global Antigravity Plugins (~/.gemini/config/plugins/archify)
npm run install:global

# Hoặc cài đặt theo Workspace (<workspace>/.agents/plugins/archify)
node scripts/install-antigravity.mjs --workspace D:\du-an-cua-ban
```
