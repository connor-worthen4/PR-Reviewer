# PR Reviewer

Automated pull request review powered by Claude Code. Runs specialized review agents on every PR, posts inline comments on specific lines, responds to conversations, and auto-fixes issues on command. Optionally notifies Discord with summaries.

Built to run on a local machine alongside a Claude Max subscription. No API keys or per-review costs.

---

## How It Works

A Node.js script runs on your machine and polls GitHub for open pull requests. When it finds a new or updated PR with a `review` label, it fetches the diff and runs three specialized reviews through Claude Code. Results are posted as inline review comments on specific files and lines using the GitHub API. The reviewer then monitors PR comments for commands and questions.

```
Poll GitHub (gh pr list --label review)
   │
   ├─ New/updated PR found
   │   │
   │   ├── Fetch diff (gh pr diff)
   │   │
   │   ├── Security Review ──────> claude -p (security rubric + diff)
   │   ├── Code Quality Review ──> claude -p (code quality rubric + diff)
   │   └── Test Quality Review ──> claude -p (test quality rubric + diff)
   │   │
   │   ├── Post inline comments (GitHub API)
   │   ├── Post summary comment
   │   └── Notify Discord
   │
   └─ Poll comments on reviewed PRs
       │
       ├── !fix     → Auto-fix the specific issue, commit, push
       ├── !fix-lint → Run ruff + eslint --fix, commit, push
       ├── !review   → Re-trigger a full review
       └── Question  → Claude responds naturally in-thread
```

---

## Features

**Inline review comments** — Findings are posted on the exact file and line, not as one big comment. Each finding becomes its own conversation thread.

**Interactive commands** — Reply `!fix` to any finding and Claude will fix that specific issue, commit, and push. Use `!fix-lint` to auto-fix all linting issues across the PR.

**Bot identity** — When configured as a GitHub App, reviews post under a dedicated bot account with a `[bot]` badge, keeping bot activity visually distinct from human comments.

**Discord notifications** — Get notified when reviews complete, fixes are pushed, or comments are replied to. Pairs with the [Discord Claude Bridge](https://github.com/connor-worthen4/discord-claude-bridge) for a mobile workflow.

**Re-reviews** — When new commits are pushed to a reviewed PR, the reviewer detects the change and runs fresh reviews automatically.

---

## Review Agents

### Security Review

Evaluates the diff for vulnerabilities and security misconfigurations, categorized by severity.

- **Critical**: hardcoded secrets, SQL injection, auth bypass, remote code execution, path traversal
- **High**: missing input validation, permissive CORS, sensitive data in error messages
- **Medium**: vulnerable dependencies, verbose error messages, missing HTTPS, logged PII
- **Low**: opportunities for defense-in-depth, stricter types, tighter configuration

Includes AWS-specific checks for IAM permissions, Lambda environment variables, API Gateway authentication, and S3 bucket policies.

### Code Quality Review

Evaluates architecture, readability, reusability, error handling, and performance. Checks for proper separation of concerns, meaningful naming, duplicated logic, unhandled failures, N+1 queries, and unnecessary re-renders.

### Test Quality Review

Evaluates test completeness, assertion quality, and isolation. Focused on backend Python tests using pytest. Identifies missing coverage for branches, edge cases, and error paths. Flags weak assertions and improper mocking.

---

## Requirements

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated with `repo` scope
- Claude Max subscription (reviews use `claude -p`, no API key needed)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/connor-worthen4/pr-reviewer.git ~/pr-reviewer
cd ~/pr-reviewer
npm install
```

### 2. Configure

```bash
cp .env.example .env
nano .env
```

**Required:**

- `GITHUB_REPOS` — comma-separated repos to watch (e.g. `yourname/project`)
- `CLAUDE_PATH` — absolute path to the claude binary (find with `which claude`)
- `GITHUB_USERNAME` — your GitHub username (used to filter bot's own comments)

**Optional:**

- `POLL_INTERVAL_MS` — poll interval in milliseconds (default: 180000 = 3 minutes)
- `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` — for Discord notifications
- `PROJECT_DIRS` — maps repos to local paths for `!fix` commands (e.g. `yourname/project=/Users/you/projects/project`)
- `DEBUG` — set to `1` for verbose logging

**GitHub App (optional, for bot identity):**

- `GITHUB_APP_ID` — your GitHub App's ID
- `GITHUB_APP_INSTALLATION_ID` — the installation ID for your account
- `GITHUB_APP_PRIVATE_KEY_PATH` — path to the `.pem` private key file

See [USAGE.md](USAGE.md) for detailed setup instructions including GitHub App creation and the full development workflow.

### 3. Test

```bash
node reviewer.js
```

If you have an open PR with the `review` label on one of your configured repos, it should pick it up within the first poll cycle.

---

## Running Persistently

### launchd (macOS, recommended)

A template plist file is included. launchd auto-starts the reviewer on boot and restarts it if it crashes.

```bash
nano com.pr-reviewer.plist   # edit paths
cp com.pr-reviewer.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.pr-reviewer.plist
```

### tmux

```bash
chmod +x start.sh stop.sh
./start.sh
```

---

## Commands

| Command | Where | What it does |
|---------|-------|-------------|
| `!review` | PR comment | Adds the `review` label to trigger a fresh review |
| `!fix` | Reply to inline finding | Fixes that specific issue, commits, and pushes |
| `!fix-lint` | PR comment | Runs ruff + eslint auto-fix across the branch |
| Any text | Reply to inline finding | Claude responds naturally to questions or discussion |

---

## Customizing Review Rubrics

The review prompts live in `prompts/`:

```
prompts/
  security-review.md
  code-quality-review.md
  test-quality-review.md
```

Each file contains the full rubric sent to Claude along with the PR diff. Edit the prompt files to adapt them for your stack and standards. Changes take effect on the next poll cycle.

### Improving Prompts Over Time

When a review agent produces a false positive or misses something:

- **False positive** — add an exception or clarification to the rubric
- **Missed issue** — add the pattern as an explicit check
- **Wrong severity** — move it to the correct category

### Adding New Review Agents

1. Create a new prompt file in `prompts/`
2. Add an entry to `REVIEW_TYPES` in `reviewer.js`:

```javascript
{ name: "docs", file: "docs-review.md", label: "Documentation" }
```

3. Restart the reviewer

---

## Logs

```bash
tail -f ~/pr-reviewer/reviewer.log        # application logs
tail -f ~/pr-reviewer/launchd-stdout.log   # launchd stdout
tail -f ~/pr-reviewer/launchd-stderr.log   # launchd stderr
DEBUG=1 node reviewer.js                   # debug mode
```

---

## License

MIT