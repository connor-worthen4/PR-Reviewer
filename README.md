# PR Reviewer

Automated pull request review powered by Claude Code. Polls GitHub for open PRs, runs three specialized review agents (security, code quality, test quality), and posts results as PR comments. Optionally notifies a Discord channel with a summary.

Built to run on a local machine alongside a Claude Max subscription. No API keys or per-review costs.

---

## How It Works

A Node.js script runs on your machine and polls GitHub for open pull requests at a configurable interval. When it finds a new or updated PR, it fetches the diff and runs three separate reviews through Claude Code (`claude -p`), each using a specialized rubric prompt. The results are posted as individual comments on the PR using the GitHub CLI.

```
Poll GitHub (gh pr list)
   |
   v
New/updated PR found
   |
   v
Fetch diff (gh pr diff)
   |
   ├── Security Review ──────> claude -p (security rubric + diff)
   ├── Code Quality Review ──> claude -p (code quality rubric + diff)
   └── Test Quality Review ──> claude -p (test quality rubric + diff)
   |
   v
Post comments (gh pr comment)
   |
   v
Notify Discord (optional)
```

When new commits are pushed to a reviewed PR, the reviewer detects the updated timestamp and runs a fresh review automatically.

---

## Review Agents

### Security Review

Evaluates the diff for vulnerabilities and security misconfigurations. Findings are categorized by severity.

**Critical** (must fix): hardcoded secrets, SQL injection, auth bypass, remote code execution, path traversal.

**High** (should fix): missing input validation, permissive CORS, sensitive data in error messages, insecure password handling.

**Medium** (fix soon): vulnerable dependencies, verbose error messages, missing HTTPS enforcement, logged PII.

**Low** (suggestion): opportunities for defense-in-depth, stricter types, tighter configuration.

Includes AWS-specific checks for IAM permissions, Lambda environment variables, API Gateway authentication, and S3 bucket policies.

### Code Quality Review

Evaluates architecture, readability, reusability, error handling, and performance.

**Architecture**: Does the change follow existing patterns? Is business logic in the right layer? Would this scale?

**Readability**: Are names meaningful? Is control flow clear? Are comments present where needed?

**Reusability**: Is there duplicated logic? Are functions parameterized appropriately? Are components composable?

**Error handling**: What happens when external services fail? Are errors caught at the right level?

**Performance**: N+1 queries, unnecessary data fetching, missing indexes, frontend re-renders, unpaginated lists.

### Test Quality Review

Evaluates test completeness, assertion quality, isolation, and missing coverage. Focused on backend Python tests using pytest.

**Coverage**: Are all branches tested? Are success, failure, and edge cases covered?

**Assertions**: Are tests checking specific values or just "not None"? Would the test break if behavior changed?

**Isolation**: Can tests run independently? Are external services mocked? Are mocks scoped correctly?

**Missing coverage**: What scenarios exist in the code but have no corresponding test?

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

Required:
- `GITHUB_REPOS` -- comma-separated list of repos to watch (e.g. `yourname/project`)
- `CLAUDE_PATH` -- absolute path to the claude binary (find with `which claude`)

Optional:
- `POLL_INTERVAL_MS` -- how often to check for PRs in milliseconds (default: 180000 = 3 minutes)
- `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` -- for Discord notifications (see Discord Notifications below)
- `DEBUG` -- set to `1` for verbose logging

### 3. Test

```bash
node reviewer.js
```

If you have an open PR on one of your configured repos, it should pick it up within the first poll cycle. Check the PR on GitHub for review comments.

---

## Running Persistently

### Option A: launchd (macOS, recommended)

launchd auto-starts the reviewer on boot and restarts it if it crashes. A template plist file (`com.pr-reviewer.plist`) is included in this repo.

```bash
# Edit the plist with your actual paths (see comments inside the file)
nano com.pr-reviewer.plist

# Copy it to LaunchAgents
cp com.pr-reviewer.plist ~/Library/LaunchAgents/

# Start it
launchctl load ~/Library/LaunchAgents/com.pr-reviewer.plist

# Verify it is running (exit code should be 0)
launchctl list | grep reviewer

# Stop it
launchctl unload ~/Library/LaunchAgents/com.pr-reviewer.plist
```

### Option B: tmux

```bash
chmod +x start.sh stop.sh
./start.sh
```

### Option C: Direct

```bash
node reviewer.js
```

---

## Watching Multiple Repos

Add repos to `GITHUB_REPOS` in `.env`, comma-separated:

```
GITHUB_REPOS=yourname/project1,yourname/project2,yourname/project3
```

Each repo is polled independently. PRs must target the `dev` branch to be reviewed.

---

## Discord Notifications

The reviewer can send a summary to a Discord channel when reviews complete. This pairs with the [Discord Claude Bridge](https://github.com/connor-worthen4/discord-claude-bridge), which lets you control Claude Code from your phone via Discord messages. Together, you get a full workflow: text Claude to build a feature, it creates a PR, the reviewer posts the results, and you get notified in the same Discord channel.

To enable notifications, add `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` to `.env`. If you already have the Discord Claude Bridge running, use the same bot token and channel ID.

Example notification:

```
PR #5 reviewed (yourname/project)
Add rate limiting to API endpoints
Security: passed
Code Quality: passed with suggestions
Test Quality: changes requested
https://github.com/yourname/project/pull/5
```

---

## Customizing Review Rubrics

The review prompts live in `prompts/`:

```
prompts/
  security-review.md
  code-quality-review.md
  test-quality-review.md
```

Each file contains the full rubric that gets sent to Claude along with the PR diff. The included rubrics are a general template currently pointed at a stack using AWS, Python, Next.js, and React. Edit the prompt files to adapt them for your stack and standards.

Changes take effect on the next poll cycle. No restart needed.

### Improving Prompts Over Time

The rubrics improve through iteration. When a review agent produces a false positive or misses something you catch manually, update the rubric:

- **False positive**: Add an exception or clarification. For example, if the security agent keeps flagging test fixtures as hardcoded credentials, add "Test fixtures with obvious fake values (e.g. test@example.com, password123) are acceptable in test files."
- **Missed issue**: Add the pattern as an explicit check under the relevant section.
- **Wrong severity**: Move it to the correct category.
- **Too verbose or too terse**: Adjust the response format section.

Over time the rubrics become a comprehensive, battle-tested specification of your standards.

### Adding New Review Agents

To add a fourth review agent (e.g. documentation review, accessibility review):

1. Create a new prompt file in `prompts/` (e.g. `docs-review.md`)
2. Add an entry to the `REVIEW_TYPES` array in `reviewer.js`:

```javascript
{ name: "docs", file: "docs-review.md", label: "Documentation" }
```

3. Restart the reviewer

---

## Re-reviews

The reviewer tracks the `updatedAt` timestamp for each PR. When new commits are pushed, it detects the change on the next poll cycle and runs all three reviews again. New comments are posted and old review comments remain for history.

To force a re-review of all PRs (e.g. after updating rubrics):

```bash
echo '{}' > ~/pr-reviewer/review-state.json
```

State is stored in `review-state.json` and automatically cleaned up after 30 days.

---

## Logs

```bash
# Application logs
tail -f ~/pr-reviewer/reviewer.log

# launchd logs
tail -f ~/pr-reviewer/launchd-stdout.log
tail -f ~/pr-reviewer/launchd-stderr.log

# Debug mode
DEBUG=1 node reviewer.js
```

---

## License

MIT