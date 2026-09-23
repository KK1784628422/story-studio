# Story Studio

**A local-first AI workbench for writing long-form Chinese web novels.** Ships as both an
Electron desktop app and a plain web app.

It is not a chatbot wrapper. Its point is that the craft workflow is **enforced by code rather
than requested in prompts**: writing a chapter file triggers four quality-gate scripts, and passing
the gate is not enough — the chapter also has to commit a continuity-tracking transaction before
it counts as done.

- Everything stays on your machine: the server binds `127.0.0.1` only, never the public internet.
- Bring your own model: any OpenAI-compatible endpoint (DeepSeek / Kimi / GLM / Qwen / gateways).
- Quality gates, tracking and lint scripts all run locally.

> ~28k lines of TypeScript plus ~15k lines of hand-written CSS. 9 modes, 21 agent tools, 20 skills.

Chinese documentation: [`README.md`](README.md).

## Why it exists

The hard part of a long novel is not writing one good paragraph — it is staying coherent
500,000 characters in: no contradicting settings, no forgotten foreshadowing, no drifting voice.
Story Studio turns those engineering problems into executable checks.

| Problem | Mechanism |
|---|---|
| AI-flavoured prose, repetition, outline copying | **Quality gate** — snapshot + 4 checker scripts on every chapter write; blocking findings must reach zero |
| Broken characters / foreshadowing / timeline | **Continuity tracking** — four state classes committed transactionally, views rendered atomically |
| Unwanted edits | **Modes + approval** — review mode has no write tools at all; rewrite operations pause for approval |
| Context cost | **Three-tier skill disclosure** — only the skill catalogue is injected up front |
| Losing your place in a long workflow | Multi-step workflows with on-disk progress and resume |

## Modes

`discuss` · `write` · `import` · `polish` · `review` · `market` · `preview` · `fanfic` · `calibrate`

Each mode is a four-tuple of prompt fragment, skill subset, tool allow-list and approval policy.
Review mode, for instance, simply has no `Write`/`Edit` tool — reports can only be saved through
`save_report`, which makes "reviewing quietly rewrites the manuscript" structurally impossible.

## Architecture

pnpm monorepo with a one-way dependency direction: `web/server` → `agent-core` → `tools/skills` → `shared`.

```
apps/server      Fastify 5 + ws event bus (SSE chat stream, file watching, gate events)
apps/web         React 18 + Vite, no UI framework, hand-written CSS
apps/desktop     Electron shell with an embedded CDP-driven browser panel
packages/agent-core  Agent runtime on AI SDK 7 (live mode switching, approval docking, gateway adapters)
packages/tools       21 tools incl. the quality-gate engine and tracking transactions
packages/skills      Three-tier skill loader
  vendor/            13 skills from oh-story-claudecode (MIT — see below)
  local/             7 skills of this project (fan-fiction, calibration, avatar pipeline)
packages/preview-core  Preview / tracking / library
packages/shared       Domain types shared by client and server
```

## Quick start

Requires Node.js **>= 22** and pnpm.

```bash
git clone <this-repo> && cd story-studio
pnpm install
cp .env.example .env    # set your endpoint, API key and model id
pnpm build              # build the frontend
pnpm dev                # http://127.0.0.1:8100
```

The welcome screen asks you to pick or create a *book workspace* directory before entering.

For frontend work, run `pnpm dev` and `pnpm dev:web` in two terminals (Vite HMR on 5173).
Desktop mode is `pnpm dev:desktop`; it adds the embedded Agent browser panel, which keeps
scraping and web-AI image generation inside the app and never touches your system browser.

`.env` and `.local/` are gitignored — **never commit them**.

## Skills and third-party code

Skills are where the writing methodology lives. Two directories are loaded, with `local/`
shadowing `vendor/` on name collisions.

`packages/skills/vendor/` bundles 13 skills from **oh-story-claudecode** (ranking scrapers,
book deconstruction, long/short-form writing, de-AI-flavouring, cover art, import, review,
routing). That portion is distributed under the **MIT License**, copyright its original authors;
the original license text is at [`packages/skills/vendor/LICENSE`](packages/skills/vendor/LICENSE).

Re-sync it from upstream with:

```bash
pnpm sync-skills
STORY_STUDIO_SKILLS_SOURCE=/path/to/skills pnpm sync-skills
```

> ⚠️ `sync-skills` deletes and rebuilds `vendor/`. It is now under version control, so check
> `git status` is clean before running it.

## Book workspace layout

One directory per book, compatible with the oh-story convention:

```
正文/          ChapterNNN_Title.md   ← writing here triggers the quality gate
大纲/          master / volume / per-chapter outlines
设定/          character sheets and the relationship table that drives the graph view
追踪/          four continuity state classes plus protected derived views
原著/          source text, deconstruction output and progress (fan-fiction mode)
.story-studio/ snapshots, reports, scratch drafts, approval fingerprints
```

The quality gate on a chapter write: snapshot (last 5 versions) → punctuation normalisation
(the only script allowed to modify the file) → three read-only checkers in parallel
(`check-ai-patterns`, `check-outline-copy`, `check-degeneration`) → all must exit 0.
Any blocking finding is fed back to the agent for targeted repair, up to three attempts.

## Security notes

- The HTTP server binds `127.0.0.1` only; manuscripts and API keys never leave the machine.
- API keys live in `.env` and `.local/settings.json`, both gitignored — check before sharing the folder.
- The Bash tool is an allow-list executor: only `node` / `python` scripts inside a skill's
  `scripts/` directory are permitted, and path traversal is rejected.
- Output from web-AI sites is treated as UNTRUSTED and must be reviewed, gated and approved
  before it can be written to the manuscript.

## Known limitations

- **No automated tests.** Verification is manual scripts under `scripts/`. The gate engine,
  the Bash sandbox and session-message sanitisation are the three places that most need regression cover.
- Ranking scrapers depend on third-party page structure and may break without notice.
- The web-AI channel currently adapts GLM and Qwen; new sites need an adapter under
  `packages/tools/src/askai/sites/`.

## License

This project's own code is released under the **MIT License** — see [`LICENSE`](LICENSE).
The skill pack under `packages/skills/vendor/` is MIT-licensed third-party work by
oh-story-claudecode; see the `LICENSE` file inside that directory.
