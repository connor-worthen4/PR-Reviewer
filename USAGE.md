# Usage Guide

This guide covers the full development workflow: how the PR reviewer fits into a Claude-powered development setup with Discord control, Claude Code configuration, and a GitHub App bot identity.

---

## Architecture Overview

The PR reviewer is one piece of a larger automation stack:

```
Your phone (Discord)
   │
   └─ Discord Claude Bridge ──> Claude Code (local Mac)
                                    │
                                    ├── Writes code, creates PRs
                                    └── Pushes to GitHub
                                            │
                                            └── PR Reviewer (polls GitHub)
                                                  │
                                                  ├── Reviews PR (3 agents)
                                                  ├── Posts inline comments (GitHub App)
                                                  ├── Notifies Discord
                                                  └── Handles commands (!fix, !review, !fix-lint)
```

You can text Claude from your phone via Discord, it builds features and creates PRs, the reviewer automatically reviews them, and you get notified in the same Discord channel. You can then reply to findings, request fixes, or ask questions — all without touching your laptop.

---

## Discord Claude Bridge Integration

The PR reviewer shares a Discord bot with the [Discord Claude Bridge](https://github.com/connor-worthen4/discord-claude-bridge). Both use the same `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` in their `.env` files.

The bridge lets you control Claude Code from Discord messages. The reviewer sends notifications to the same channel. Together, a typical flow looks like:

1. You text Claude in Discord: "Add email verification to the signup flow"
2. Claude Code builds the feature and creates a PR
3. The PR reviewer detects the new PR, runs reviews, and posts findings
4. Discord notification: **PR #17** — 3 issues found
5. You open the PR on GitHub, reply `!fix` to findings you agree with
6. The reviewer auto-fixes, commits, and pushes
7. Discord notification: **PR #17** — fix pushed

### Notification Format

Discord notifications use a consistent format for quick scanning:

- **Review complete**: `**PR #17** — 3 issues found` with breakdown by agent
- **Fix pushed**: `**PR #17** — fix pushed` with commit link
- **Lint fix**: `**PR #17** — lint fixes pushed` with commit link
- **Comment reply**: `**PR #17** — replied to comment` with preview of what triggered it

---

## Claude Code Configuration

The PR reviewer works alongside Claude Code's own configuration files. These files control how Claude writes code in your projects, which directly affects the quality of PRs that get reviewed.

### Global Settings (`~/.claude/settings.json`)

This file controls Claude Code's permissions and tool access across all projects. Key sections relevant to the reviewer workflow:

**Permissions** — Define which shell commands Claude can run without prompting. For the reviewer's `!fix` and `!fix-lint` commands to work autonomously, Claude needs permission for git operations, linting tools, and test runners.

```json
{
  "permissions": {
    "allow": [
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)",
      "Bash(ruff:*)", "Bash(ruff check:*)", "Bash(ruff format:*)",
      "Bash(eslint:*)", "Bash(npx:*)", "Bash(pytest:*)"
    ],
    "deny": [
      "Bash(rm -rf:*)", "Bash(sudo:*)", "Bash(git push --force:*)",
      "Bash(git checkout main)", "Bash(aws:*)", "Bash(terraform:*)"
    ]
  }
}
```

The allow list should include any tools the reviewer might invoke through `!fix` or `!fix-lint`. The deny list prevents destructive operations even if a prompt tries to trigger them.

**Notification hooks** — You can configure Claude Code to notify you when it needs permission approval. This is useful when the reviewer triggers Claude Code for a `!fix` and Claude encounters a command not in the allow list.

### Global CLAUDE.md (`~/.claude/CLAUDE.md`)

This file contains rules that apply to Claude Code across all projects. Use it for standards that should be universal:

- Git workflow conventions (branch naming, commit message format, PR description template)
- Pre-commit lint rules (run formatters before every commit)
- General code quality standards
- Security practices (never commit secrets, always use environment variables)

**Example pre-commit lint rules:**

```markdown
## Pre-commit Lint Rules
- Before committing Python changes, run: `cd backend && ruff check . --fix && ruff format .`
- Before committing frontend changes, run: `cd frontend && npx eslint . --fix`
- If either command produces changes, stage and include them in the commit.
- Never commit code that fails `ruff check` or `eslint`.
```

These rules reduce the number of lint failures the reviewer catches, because Claude fixes them before they ever get committed.

### Project CLAUDE.md (`<project>/.claude/CLAUDE.md`)

This file contains project-specific rules. Use it for:

- Project architecture and directory structure documentation
- Technology stack details (frameworks, versions, conventions)
- Coding standards specific to the project
- Testing conventions (what to test, how to structure tests, mocking patterns)
- Lint and formatting tool configuration
- API patterns and naming conventions

**Example project-specific rules:**

```markdown
## Lint Rules
- Backend: ruff is configured via `backend/ruff.toml`. Run `ruff check . --fix && ruff format .` before every commit.
- Frontend: ESLint + TypeScript. Run `npx eslint . --fix` before every commit.
- CI will block PRs that fail lint checks. Use `!fix-lint` as a PR comment to auto-fix.

## Testing
- Use pytest for all backend tests
- Test files mirror source structure: `app/services/auth.py` → `tests/test_auth.py`
- Mock external services, never call real APIs in tests
```

The reviewer's rubric prompts and Claude Code's CLAUDE.md files work in tandem. The CLAUDE.md rules tell Claude how to write code; the reviewer rubrics evaluate whether the code meets those standards.

---

## GitHub App Setup

By default, the reviewer posts comments using your personal GitHub account (via `gh` CLI). Configuring a GitHub App gives the reviewer its own bot identity with a `[bot]` badge, making it visually distinct from your comments.

### 1. Create the App

Go to **https://github.com/settings/apps/new** and configure:

| Setting | Value |
|---------|-------|
| App name | Your preferred bot name (e.g. "PR Reviewer") |
| Homepage URL | Your repo URL |
| Webhook | **Uncheck** "Active" (the reviewer polls, it doesn't use webhooks) |

**Repository permissions:**

| Permission | Access |
|-----------|--------|
| Pull requests | Read and write |
| Contents | Read |
| Issues | Read and write |
| Metadata | Read (auto-selected) |

Set "Where can this app be installed" to **Only on this account**.

### 2. Generate Credentials

After creating the app:

1. Note the **App ID** on the settings page
2. Click **Generate a private key** — downloads a `.pem` file
3. Click **Install App** → Install on your account → Select your repositories
4. Note the **Installation ID** from the URL after installing (e.g. `https://github.com/settings/installations/12345678`)

### 3. Configure the Reviewer

Add to your `~/pr-reviewer/.env`:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/pr-reviewer/private-key.pem
```

Copy the `.pem` file:

```bash
cp ~/Downloads/your-app-name.*.private-key.pem ~/pr-reviewer/private-key.pem
```

Make sure `private-key.pem` is in `.gitignore`.

### 4. How It Works

The reviewer generates a JWT from the private key, exchanges it for a short-lived installation token (~1 hour), and uses that token for all GitHub API calls that post content (reviews, comments, replies). The token is cached and auto-refreshed before expiry.

Reading operations (listing PRs, fetching diffs, managing labels) still use `gh` CLI under your personal account. If the App token fails for any reason, the reviewer falls back to `gh` CLI automatically.

---

## Label-Gated Reviews

Reviews only run on PRs that have the `review` label. This prevents the reviewer from reviewing every PR automatically and gives you control over when reviews happen.

To trigger a review:

- Add the `review` label manually on GitHub
- Comment `!review` on the PR (the reviewer adds the label for you)
- Have Claude Code add the label when creating a PR (add this to your CLAUDE.md rules)

After a review completes, the reviewer tracks the PR's timestamp. If new commits are pushed, it automatically re-reviews on the next poll cycle.

---

## State Management

The reviewer stores its state in `review-state.json`. This tracks:

- Which PRs have been reviewed and when
- Which comments have been processed (prevents re-processing)
- PR timestamps for detecting updates

**Normal operation**: State persists across restarts. The reviewer picks up where it left off.

**Reset state** (e.g. after updating rubrics, to force re-review of all PRs):

```bash
echo '{}' > ~/pr-reviewer/review-state.json
```

**Warning**: Resetting state causes the reviewer to reprocess all comments on active PRs. Only do this during development or when you specifically want to re-review everything.

State is automatically cleaned up after 30 days.

---

## Deployment Workflow

When updating the reviewer itself:

```bash
# Stop the reviewer
launchctl unload ~/Library/LaunchAgents/com.pr-reviewer.plist

# Deploy new code
cp reviewer.js ~/pr-reviewer/reviewer.js

# Restart
launchctl load ~/Library/LaunchAgents/com.pr-reviewer.plist

# Verify
tail -f ~/pr-reviewer/reviewer.log
```

When updating only rubric prompts, no restart is needed — changes take effect on the next poll cycle.

---

## Troubleshooting

**Reviewer keeps re-reviewing the same PR** — Check that `review-state.json` isn't being cleared. Also check logs for errors during `postSummaryComment` — if it fails, state doesn't get saved.

**`!fix` hits permission prompts** — The command Claude is trying to run isn't in `~/.claude/settings.json` allow list. Check the log for the specific command and add it.

**`!fix-lint` says "unable to proceed"** — Claude Code's working directory might not have access to the project. Ensure `PROJECT_DIRS` is set in `.env` so the reviewer passes the correct `cwd` to Claude.

**Bot comments show as your username** — GitHub App isn't configured or token generation failed. Check startup log for `GitHub App: enabled` or `disabled`. Verify `.env` has all three App settings.

**422 errors on inline comments** — Usually means a file path or diff position is invalid. The reviewer falls back to a general comment automatically. Check that the PR diff hasn't changed between review start and comment posting.

**Discord notifications not sending** — Verify `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` in `.env`. The bot must have permission to post in the channel.