# Upstream Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge fork-only work (29 commits: Zalo, spaces, pair-gate/PWA, GemLogin, Chromium, computer control, phone layout) with upstream `origin/dev` (~1000 commits: group engine, privacy, avatars, effort levels, side-chat/views, office docs) on one branch, green tests, PR into `fork/dev`.

**Architecture:** Branch `chore/upstream-integration` off synced `fork/dev` (= upstream dev), merge `fork/main` into it, resolve 33 conflicted files cluster-by-cluster keeping both sides' features, re-apply stashed WIP on top, rebuild generated `client.js`, verify with unit tests + lint + smoke test.

**Tech Stack:** Node 22, DSH plugin (`ds-bot/`), esbuild client bundle, node:test + mock LLM, git worktree for isolation.

**Spec:** Fork designs in `docs/plans/2026-10-18-zalo.md`, `2026-10-21-spaces.md`, `2026-10-18-mobile-pwa.md`, `2026-10-18-computer-control.md`, `2026-10-18-gemlogin.md`, `2026-10-19-chromium.md`; upstream designs in `docs/plans/2026-10-20-widget-views.md`, `2026-10-21-btw.md`, `2026-10-22-message-layout.md`, `2026-10-24-mobile-app.md`, `2026-10-27-office-documents.md`, `2026-10-27-private-bots.md`; behavior deltas in `CHANGELOG.md` 0.2.0–0.2.6 (read-only, never edit it).

## Global Constraints

- Environment: Node ≥22.15 is required (`test/harness-resolve.mjs` uses `registerHooks` from `node:module`). The machine's default `node` is v22.11.0 (too old); a newer Node is installed via fnm (v22.23.3). Every shell command that runs node/npm in this plan MUST start with `Invoke-Expression (fnm env | Out-String); fnm use 22.23.3` (fnm is not initialized in non-interactive shells). Never run `fnm default`/`fnm alias` — do not change the user's global Node.

- Build on DSH via documented plugin APIs only; never patch a DSH install. If an API is missing, stop and report.
- Never write, print, or commit secrets; tests use `ds-bot/dev/mock-llm.mjs`.
- `ds-bot/client.js` is generated: edit only `ds-bot/src/client/`, then `npm run build`. Never hand-edit `client.js`.
- Tests never touch `~/.dsh`, the desktop app's data, or a user-run DSH; bench data lives in `.dsh-test-<name>/`.
- Commit messages in English, imperative subject. The requester is the commit author; never set an AI agent as author and never add `Co-authored-by`.
- User-facing text is English. Any `ds-bot/README.md` bullet change is mirrored in `ds-bot/README.zh.md`.
- Never rebase a pushed branch, never force-push. PR goes into `fork/dev`, never `main`.

---

### Task 0: Record the green baseline

**Files:** none (read-only).

**Interfaces:** Consumes: background `npm test` run already started on clean `main` (`9be2c49` + WIP stash, Husky-free tree).
Produces: baseline PASS/FAIL + failing test names for later comparison.

- [ ] **Step 1: Collect the background baseline result**

Await the background `npm test` (run in `ds-bot/`, started 2026-11-03 on clean tree). Record: exit code, failing test files if any.
Expected: PASS. If FAIL, record exact failing test names; integration is still go, but the same failures must match after (no new failures allowed).

- [ ] **Step 2: Confirm working tree is untouched**

Run: `git status --short` in `D:\DeepSeek-Bot`
Expected: exactly the 10 modified files (`client.js`, `dev/remote-gate.mjs`, `src/client/sidebar.js`, `src/host/groups.js`, `handoffs.js`, `prompt.js`, `resume.js`, `turns.js`, `zalo.js`, `test/zalo.test.js`) + `?? docs/dev/shopee-mcp.md`, HEAD `9be2c49`. The WIP must stay uncommitted on `main` until Task 8.

---

### Task 1: Sync fork/dev, create isolated worktree + branch

**Files:** none (git refs only).

**Interfaces:** Consumes: `origin/dev` at `114e35d`, `fork/dev` 998 behind / 0 ahead.
Produces: `fork/dev` == `origin/dev`; worktree at `../ds-bot-integration` on branch `chore/upstream-integration`.

- [ ] **Step 1: Verify fast-forward safety**

Run: `git fetch origin; git fetch fork; git rev-list --left-right --count fork/dev...origin/dev`
Expected: `0	998` (fork/dev has nothing unique; safe to fast-forward).

- [ ] **Step 2: Fast-forward fork/dev to origin/dev**

Run: `git push --dry-run fork origin/dev:dev`, then `git push fork origin/dev:dev`, then `git fetch fork`
Expected: dry-run reports no rejection; push succeeds; `fork/dev` == `origin/dev` (`114e35d`).

- [ ] **Step 3: Create the integration worktree and branch**

Run: `git worktree add ../ds-bot-integration -b chore/upstream-integration fork/dev`
Expected: new worktree, branch tracks nothing (push explicitly to `fork` later). `main` worktree keeps the uncommitted WIP untouched.

- [ ] **Step 4: Install deps in the worktree**

Run: `npm ci` in `../ds-bot-integration/ds-bot`, then `npm run harness`
Expected: both succeed (network needed for harness). If `npm run harness` fails offline, stop and report; unit tests cannot run without `@deepseek-ai/*`.

---

### Task 2: Merge fork/main, resolve host core (store/roster/constants/channel/tools)

**Files:**
- Modify: `ds-bot/src/host/store.js`, `roster.js`, `constants.js`, `channel.js`, `tools.js` (each: 1–8 conflict hunks).

**Interfaces:** Consumes: merge base `git merge fork/main` (uncommitted) in worktree.
Produces: state shape + tool-name vocab carrying both sides' features; `node --check` clean on the four files.

- [ ] **Step 1: Start the merge without committing**

Run: `git merge --no-commit --no-ff fork/main` in the worktree.
Expected: `Automatic merge failed` with the known 33 conflicted files. Do NOT commit until Task 8.

- [ ] **Step 2: Resolve `ds-bot/src/host/store.js` (1 hunk)**

Keep fork's `spaces: {}` and `zalo: {}` AND upstream's `privateArchives: []`, `requests: {}` (`requests.js` module), `views: {}` (`show_view`), `switching: {}`. Update the JSDoc `@type` line to list all keys. Then grep the merged tree for `state.spaces` and `state.privateArchives` load/migration code and keep both paths.
Expected: `git diff --check` clean; `node --check ds-bot/src/host/store.js` passes.

- [ ] **Step 3: Resolve `ds-bot/src/host/constants.js` (2 hunks)**

Tool-name list = union: keep `create_space`, `update_space`, `delete_space` (fork) and adopt `list_bot_models` (renamed from `list_models`) + `show_view` (upstream). Keep the whole fork-only `ZALO_*`/`ROOM_LATE_ROUNDS` block (upstream side is empty). Then grep for `list_models` (old name) in fork-only files (`zalo.js`, prompt text) and rename to `list_bot_models`.
Expected: no `list_models` references remain except the rename itself; `node --check` passes.

- [ ] **Step 4: Resolve `ds-bot/src/host/channel.js` (2 hunks)**

Keep the fork `spaces` view line (PIN hash stripped, `locked` flag) AND add upstream's `privateArchives: rt.archivesView()` line. `READS` set = union of both lists (fork adds `zalo-status`, `push-key`, `pair-status`, `gemlogin-*`, `chromium-*`; upstream adds `providers`, `provider-models`, `chat`, `run-stats`, `thinking`, `avatar-library`). Verify every name in the union has a handler after the merge (upstream handlers arrive with the merge; fork handlers live in fork modules).
Expected: `node --check` passes.

- [ ] **Step 5: Resolve `ds-bot/src/host/roster.js` (7 hunks)**

Keep fork's space imports/logic (`spaceId` apply, copy `space`, room space-change messages) AND adopt upstream's privacy/effort/avatar logic (`checkPrivacyChange`, `browserGrants`, effort-vs-model resolution, `bot.private` copy refusal). Keep fork's `imageRef`/`imageModel` resolution line alongside upstream's effort block (different features: image-reading model vs thinking level). In copy-bot, adopt upstream's `served` boolean + `effort ?? null` convention and keep `imageModel` carried over. Keep both the space-change message block and upstream's idle group-Session move comment/code.
Expected: `node --check` passes.

- [ ] **Step 6: Checkpoint**

Run: `node --check` on all four files.
Expected: all pass.

- [ ] **Step 7: Resolve `ds-bot/src/host/tools.js` (8 hunks)**

Re-register fork's `create_space`/`update_space`/`delete_space` tools using upstream's `rt.teamTools.push(defineTool({ ... }))` pattern (upstream replaced the `ctx.tools.register` block, not the features); keep the `SPACE_PARAM`/`spaceArg` helpers. `list_bots` tags: keep the space tag AND add upstream's `private` tag. `create_bot`/`update_bot`: union the parameters — keep `space` and `image_model` (fork features: filing + image-reading model) AND adopt `avatar` and `effort` (upstream); the single `rt.createBot`/`rt.updateBot` call passes all of them through. If `install.test.js` expectations break, leave them for Task 6 (do not edit tests in this task).
Expected: `node --check ds-bot/src/host/tools.js` passes.

---

### Task 3: Resolve turn/delivery/handoff core (Zalo stays working)

**Files:**
- Modify: `ds-bot/src/host/turns.js` (4 hunks), `delivery.js` (3), `handoffs.js` (2), `models.js` (1), `capabilities.js` (conflicts from fork Telegram work vs upstream — read hunks at execution). Read-only: `ds-bot/src/host/zalo.js`, `groups.js`, `resume.js`, `telegram.js`, `wake.js` (auto-merged, adapted if tests demand).

**Interfaces:** Consumes: Task 2 resolved files.
Produces: Zalo talk/watch waiter semantics working on upstream's rewritten turn pipeline; `node --check` clean.

- [ ] **Step 1: Resolve `ds-bot/src/host/turns.js` (4 hunks)**

Keep upstream's `retryTurn` AND fork's `retryWrittenCall` only if both have callers (grep `retryWrittenCall|retryTurn`); otherwise keep the one with callers. Adopt upstream's `entry.pending = source` + `pendingText` + new `^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])` strip regex, and re-apply fork's Zalo join semantics on top: a `zalo` (or otherwise reply-expecting) source arriving mid-turn joins via `pendingExtras` with dedupe on `exchangeId`; a displaced pending `zalo` trigger is preserved in `pendingExtras`; once a source claimed the turn (`entry.info !== undefined`), later sources only join. Adopt upstream's `entry.later` line (new regex) but keep `|| source.role === 'zalo'` in its condition. Keep upstream's `stoppedRoomTurns` line AND fork's `request.info.role === 'zalo'` waiter-resolve block (order: stopped-room check first, then Zalo waiter).
Expected: `node --check` passes.

- [ ] **Step 2: Resolve `ds-bot/src/host/delivery.js` (3 hunks)**

Keep fork's `[Team note]` behavior AND add upstream's `resent` restart-notice lines; pass `resent` into `headerFor` alongside fork's existing args; keep fork's `images` param + image-attachment blocks in `deliver()` (Zalo photo messages need them; default `[]` keeps upstream callers working).
Expected: `node --check` passes.

- [ ] **Step 3: Resolve `ds-bot/src/host/handoffs.js` (2 hunks)**

Union the imports. For `openWork`: always keep the `name`/`child` fields (upstream) AND fork's `zalo` route field is re-applied in Task 8 with the WIP — for now keep fork's churn/spin loop only if `nudge()` still exists in the merged tree (grep `nudge` in `ds-bot/src/host/`); if upstream removed the nudge mechanism, drop the spin loop but keep `{...(route !== undefined ? { zalo: route } : {})}`-compatible shape minimal for now (Task 8 completes it). Never silently drop a field both sides set.
Expected: `node --check` passes.

- [ ] **Step 4: Resolve `ds-bot/src/host/models.js` (1 hunk)**

Adopt upstream's export list (`defaultEffort`, `routeRefused`, `dropCatalog`, `answerable(...)`) and keep `applyRoomModel` only if fork callers exist (grep `applyRoomModel`); remove it otherwise.
Expected: `node --check` passes; grep shows no caller of a removed export.

- [ ] **Step 5: Resolve `ds-bot/src/host/capabilities.js`**

Read every conflict hunk; keep both sides' capability registrations and grants (fork Telegram/browser-driving entries AND upstream entries). Keep both sides' approval/scope checks (union conditions, never weaken one).
Expected: `node --check ds-bot/src/host/capabilities.js` passes; grep shows the Telegram capability entries present.

---

### Task 4: Resolve module index + dependencies

**Files:**
- Modify: `ds-bot/index.js` (3 hunks), `ds-bot/package.json` (verify auto-merge), `ds-bot/package-lock.json` (2 hunks), `.gitignore` (fork token/scratch ignores vs upstream — union lines).

**Interfaces:** Consumes: Tasks 2–3.
Produces: all host modules loaded once, upstream lazy-loading intact, lockfile in sync (`npm ci` dry-check passes).

- [ ] **Step 1: Resolve `ds-bot/index.js` imports (2 hunks)**

Keep fork's `computer`, `gemlogin`, `chromium`, `pwa` imports AND upstream's `browserPlugins`, `thinking` (plus every other upstream module import). No duplicate module does two jobs: fork's `chromium`/`gemlogin`/`computer` stay (upstream's `browserPlugins` is the shared-browser-plugin framework, not a replacement).
Expected: `node --check ds-bot/index.js` passes.

- [ ] **Step 2: Resolve the `MODULES` list (1 hunk)**

Start from upstream's exact order (it encodes "privacy before tool hooks, usage meters last"), then insert fork-only modules preserving fork's relative placement: `zalo` right before `capabilities`; `gemlogin, chromium, computer` right after `schedules`; `pwa` right before `channel`. Verify upstream lazy module loading (commit `dd5dcc2`, read the merged loader code) still wraps the list and includes the inserted modules. Check the upstream `MODULES` comment block in the merged file if load-order questions arise.
Expected: every `src/host/*.js` module the tree needs appears exactly once; `node --check` passes.

- [ ] **Step 3: Verify `package.json`, regenerate the lockfile**

Confirm the auto-merged `package.json` dependencies include fork's (`puppeteer-core`, `zca-js`, `web-push`) and upstream's (`deep-view`). Then run `npm install` in the worktree's `ds-bot/` to regenerate `package-lock.json` (resolves its 2 hunks by regeneration, not hand-editing). If offline, resolve the 2 lock hunks by hand instead and run `npm ci --dry-run`.
Expected: `npm ci --dry-run` (or `npm ls`) succeeds with no lock out-of-sync error.

- [ ] **Step 4: Resolve `.gitignore`**

Union the ignore lines from both sides (fork's local bot-token/scratch entries AND upstream's entries); keep one copy of duplicates.
Expected: `git status --short` shows no token/scratch files as untracked; `git diff --check` clean.

---

### Task 5: Resolve client UI (phone layout + upstream views), rebuild bundle

**Files:**
- Modify: the conflicted files in `ds-bot/src/client/` (`sidebar.js`, `cells.js`, `index.js`, `browser-pane.js`, `settings.js`, `model-menu.js`, `context-menu.js`, `composer.js`, `details-drawer.js`, `folder-menu.js`, `header.js`, `sources.js`, `exchange.js`, `i18n.js`, `voice.js`, plus any others still conflicted at execution: `bot-draft.js`, `create-bot.js`, `schedules.js`, `styles.js`, …). Regenerate: `ds-bot/client.js` via build only.

**Interfaces:** Consumes: Tasks 2–4.
Produces: phone layout AND upstream overlay/side-chat/views working; `npm run build` output committed-worthy; `node scripts/build-client.mjs --check` passes.

- [ ] **Step 1: Apply the per-file merge rule**

For every conflicted client file: keep fork's `usePhone`/`phone` branches (import from `./mobile.js`) AND upstream's `overlay`/`tick`/`useViewport`/`viewBottom` branches (import from `./motion.js`); keep both features' UI (e.g. `bt-sheet` phone sheets + upstream menus/cards). Where the two sides added *different* components at the same spot (verified example `cells.js`: fork `GroupMessage` with file chip vs upstream `SpeakerHead` flat-layout head), keep BOTH components. Read `docs/plans/2026-10-22-message-layout.md` and `2026-10-21-btw.md` when a hunk mixes layout with side-chat/btw rows.
Expected: no `<<<<<<<` markers remain in `src/client/`; grep shows both `usePhone` and `useViewport` in use.

- [ ] **Step 2: Resolve `sidebar.js` spaces + upstream list changes (5 hunks)**

Keep the fork spaces picker/filter and space-PIN form; adopt upstream's sidebar changes (read each hunk; upstream added e.g. stop-all entry points per CHANGELOG 0.2.4 — keep those rows/buttons). The WIP's removal of the `All` view is NOT applied here (Task 8 owns WIP).
Expected: `node --check` passes on all touched client files (use `node --check` per file).

- [ ] **Step 3: Rebuild the bundle**

Run: `npm run build` in the worktree's `ds-bot/`, then `node scripts/build-client.mjs --check`.
Expected: build succeeds; `--check` passes (generated `client.js` matches `src/client/`).

---

### Task 6: Resolve tests (both harnesses green)

**Files:**
- Modify: `ds-bot/test/install.test.js`, `roster.test.js`, `agents.test.js`, `update-bot.test.js`, plus any other still-conflicted test files at execution (`model-menu.test.js`, `models.test.js`, …). Read-only reference: `ds-bot/test/fake-ctx.js` (auto-merged).

**Interfaces:** Consumes: Tasks 2–5.
Produces: merged test files running on the merged code; target: `npm test` files below pass.

- [ ] **Step 1: Resolve `install.test.js` — union the expected tool/effect lists**

Keep every fork entry (`create_space`, `update_space`, `delete_space`, `gemlogin_*`, `chromium_*`, `list_models`→ renamed `list_bot_models` per Task 2) AND every upstream entry (`on tools/execute`, `scoped team tools`, `learning`, …). If a name was renamed upstream (e.g. `list_models`), assert the new name.
Expected: `node --test test/install.test.js` passes.

- [ ] **Step 2: Resolve `agents.test.js` — union the TEAM_TOOLS test**

Keep fork's `{ browser: true, computer: true }` config flags (fork registers `read_browser` + `use_computer`) AND upstream's test title/scope (`tools ds-bot defines for Bot sessions`). Assert the union of both sides' tool names.
Expected: `node --test test/agents.test.js` passes.

- [ ] **Step 3: Resolve `roster.test.js` — keep ALL tests from both sides**

Keep fork's spaces tests, space-PIN tests, and API-file-route tests AND upstream's effort/avatar/migration tests. Union the imports both bodies need (`apply`, `fakeAttachments`, `createRuntime`, `rt`/`until`/`selected`/`sent`/`home` helpers — check each referenced helper exists in the merged file and fix imports). Migrate fork assertions to upstream's harness (`createRuntime`) only where the old helper no longer exists.
Expected: `node --test test/roster.test.js` passes.

- [ ] **Step 4: Resolve `update-bot.test.js` — reconcile the `start` helpers**

Read the merged file: adopt upstream's `start(team)` + module-level `rt` harness, port the fork `start({served})` assertion (whatever behavior it covered) onto it. No test is deleted without its behavior covered elsewhere — note any dropped assertion in the PR body.
Expected: `node --test test/update-bot.test.js` passes.

---

- [ ] **Step 5: Resolve any remaining conflicted test files**

For each still-conflicted test file at execution (`model-menu.test.js`, `models.test.js`, …): keep ALL tests from both sides, union imports/helpers, migrate fork assertions to the merged harness only where the old helper no longer exists. Never delete a test without its behavior covered elsewhere — note any dropped assertion in the report for the PR body.
Expected: `node --test` passes on each resolved file.

### Task 7: Resolve docs (no CHANGELOG edits)

**Files:**
- Modify: `docs/plans/README.md` (2 hunks), `ds-bot/README.md` (1 hunk), `ds-bot/README.zh.md` (mirror if needed).

**Interfaces:** Consumes: Tasks 2–6.
Produces: docs carrying both feature sets; `git diff --check` clean.

- [ ] **Step 1: Union the plans table**

Keep ALL rows from both sides (fork: Zalo, mobile-PWA, spaces, computer-control…; upstream: agents-md-upkeep, widget-views, btw, message-layout, mobile-app, office-documents…). Fix table pipes.
Expected: every `docs/plans/*.md` file present on either side is linked exactly once.

- [ ] **Step 2: Union `ds-bot/README.md`, mirror in Chinese**

Keep fork's 4 feature bullets (Bot browser scope line, GemLogin, Chromium, computer control) AND upstream's desktop-app line. If bullets changed, make the same change in `ds-bot/README.zh.md`. Do NOT edit `CHANGELOG.md` (repo rule: changelog goes in the PR body).
Expected: `git diff --check` clean.

---

### Task 8: Re-apply WIP, full verification, commit the merge

**Files:**
- Modify: stashed WIP files (`src/host/turns.js`, `handoffs.js`, `groups.js`, `resume.js`, `prompt.js`, `zalo.js`, `src/client/sidebar.js`, `client.js` via rebuild, `dev/remote-gate.mjs`, `test/zalo.test.js`) + new `docs/dev/shopee-mcp.md`.

**Interfaces:** Consumes: Tasks 2–7 (merged tree, tests green).
Produces: single merge commit on `chore/upstream-integration` with WIP adapted; `npm test` + `--check` + `lint` green.

- [ ] **Step 1: Apply the stash in the worktree**

Run: `git stash show -p stash@{0}` from `D:\DeepSeek-Bot`, save to a patch file, then `git apply --3way --reject` it in the worktree (do NOT pop the stash on `main`; `main` keeps the WIP until the PR lands). WARNING: the WIP was written against fork `9be2c49`, but the merged tree contains newer fork commits up to `16f9454` (Telegram `telegram.js`/`wake.js` + edits in `groups.js`, `turns.js`, `prompt.js`, `channel.js`, `constants.js`, `delivery.js`, `store.js`) touching the same files the WIP touches (`groups.js`, `turns.js`, `prompt.js`). Expect `.rej` files there: adapt each rejected hunk to the merged APIs instead of force-applying. Resolve `.rej` files: port each WIP change onto the merged APIs — Zalo waiter route in `handoffs.js`/`turns.js`/`resume.js`/`groups.js` per Task 3's final signatures; sidebar `All`-view removal onto Task 5's sidebar; `zalo.test.js` new tests onto Task 6's harness; rebuild `client.js` via `npm run build` (discard any patch hunk touching `client.js` — it is generated).
Expected: `docs/dev/shopee-mcp.md` present; no `.rej` files remain.

- [ ] **Step 2: Restore fork's `config.workspace` team-folder override**

The auto-merge dropped fork's `config.workspace ?? join(home, 'workspace')` override in `ensureWorkspace` (`ds-bot/src/host/roster.js:60`), leaving only upstream's `rt.defaultTeamFolder()`. Restore it with fallback semantics: explicit `config.workspace` wins when set, otherwise upstream's default applies (read how `rt.config` is exposed in the merged `ds-bot/index.js` — it was conflicted; wire accordingly). Add/extend a unit test pinning both paths.
Expected: grep shows `config.workspace` honored; new/updated test passes.

- [ ] **Step 3: Decide + implement the scoped-vs-global delivery model for fork connector tools**

`scoped-tools-creation.test.js` (:182,190,367 — asserts all team tools scoped / no team-global) fails under fork's 12 global registrations (`gemlogin.js`, `chromium.js`, `zalo.js`, `telegram.js`, `computer.js`). Read the upstream scope design (how `rt.teamTools` scope works, why upstream scoped them) and each fork tool's caller. Rule: follow upstream's decided scoped design — move Bot-facing fork tools into `rt.teamTools` scope; a tool stays global only if the scope design provably cannot serve its caller. If all 12 belong in scope, scope them; if some must stay global, update the 3 tests to the union model (as agents.test does) instead. Prove with the file green. Record the decision + any dropped assertions for the PR body.
Expected: `scoped-tools-creation.test.js` fully green with no coverage weakened.

- [ ] **Step 4: Fix the loader-mock gap in bot-settings/new-chat/turn-error tests**

Apply the same mock union used for `model-menu.test.js` where the error demands it. WARNING (review F3): do NOT assume `createContext` — there is zero `createContext`/`useContext` in `src/client`; diagnose from the actual error output of each file first, then fix.
Expected: all three files green.

- [ ] **Step 5: Fix the wake.js listener leak**

`src/host/wake.js` binds `127.0.0.1:3099` per runtime but its disposer (`server.close()` with no callback, `:140`) never releases it — later binds fail `EADDRINUSE` (`:125`, `:130`) and pollute `usage.test.js` in-suite. Fix the disposer (close callback + destroy open connections + `unref`), then prove with the report's 10× create/dispose probe (zero leaked sockets) and `usage.test.js` green inside the full suite.
Expected: probe clean; full-suite usage failures gone.

- [ ] **Step 6: Triage remaining full-suite failures**

For each remaining failure (known: header icon, sidebar-switch footer, style-debt colors/radii, switch-keeps-input, i18n-vi strings + any new after Step 1): decide stale-test (update the assertion to merged behavior, record for PR body) vs src-regression (fix src). The suite must end green except the 2 baseline environmental kinds — and only when they fail for the SAME reason as baseline (fold locale thousands separator; sidebar-switch `document is not defined`).
Expected: full `npm test` green modulo baseline kinds, each with its reason recorded.

- [ ] **Step 7: Run the full gate**
Run in worktree `ds-bot/`: `npm test`, then `node scripts/build-client.mjs --check`, then `npm run lint`.
Expected: all three green, and no NEW failures vs Task 0 baseline. On failure, debug with the systematic-debugging skill (reproduce → isolate → fix), never by weakening a test both sides agreed on.

- [ ] **Step 8: Run the smoke test (src/host changed, so required)**

Prerequisite: a DSH checkout at the version in `README.md` at `../deepseek-harness` (or `DSH_HARNESS` env). If missing and network allows, clone it; else stop and report instead of skipping. Run: `CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke <free-port-1> <free-port-2> reset && node dev/smoke.mjs smoke <free-port-1>`, then `dev/bench.sh smoke <free-port-1> <free-port-2> stop`. Use free ports; stop every bench/process started.
Expected: smoke passes; no bench processes left (`git worktree list` + process check).

- [ ] **Step 9: Commit the merge**

First copy the design note `docs/superpowers/plans/2026-11-03-upstream-integration.md` from `D:\DeepSeek-Bot` into the worktree at the same path (repo rule: a large change ships its design note in the same PR; the file is untracked in the main worktree, so copy it over — do NOT move it, `main` keeps its copy).

Run: `git add -A; git commit` (merge commit; message subject in English, imperative, e.g. `Merge fork/main into chore/upstream-integration`; body lists kept fork features; author stays the requester).
Expected: `git status` clean in worktree; `git log --oneline -3` shows the merge on top of `114e35d`.

---

### Task 9: Push branch, open PR into fork/dev

**Files:** none (git + GitHub).

**Interfaces:** Consumes: Task 8 merge commit.
Produces: PR `chore/upstream-integration` → `fork/dev` with template filled, no `main` touched.

- [ ] **Step 1: Push explicitly to the fork**

Run: `git push fork chore/upstream-integration` (never bare `git push`: the branch must not learn an upstream that points at `origin`).
Expected: remote branch created on `ecomplus2024/DeepSeek-Bot`, local `main` and `fork/main` untouched.

- [ ] **Step 2: Open the PR into dev**

Base `fork/dev`, never `main`. Fill the PR template: link related work, put the user-visible change (kept fork features on new upstream base) in the Changelog field, do NOT edit `CHANGELOG.md`. Name dropped test assertions if any (Task 6 Step 4).
Expected: PR URL recorded; `main` worktree still holds the original uncommitted WIP until the PR lands.

---

## Self-Review

1. **Spec coverage:** every fork-only feature (Zalo/Task 3+8, spaces/Tasks 2+5, pair-gate/PWA + GemLogin/Chromium/computer/phone-layout via Task 4/5 keep-both rules, imageModel/Task 2 Step 5) and every upstream feature (privacy/effort/avatar/learning/views/office via adopt-upstream rules) has an owning task. Smoke-test requirement covered (Task 8 Step 8). Design-note rule covered (this file ships in the branch; PR body carries the Changelog).
2. **Placeholder scan:** no TBD/TODO/"handle edge cases"; each step names exact files, hunk counts, commands, and expected outputs. Grep-verification steps stand in for unknown hunk interiors.
3. **Type consistency:** `fork/dev`→synced ref, `chore/upstream-integration` branch, `../ds-bot-integration` worktree, `stash@{0}` WIP source used uniformly throughout.


