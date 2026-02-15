#!/usr/bin/env node

/**
 * PR Reviewer — Automated code review using Claude Code
 *
 * Polls GitHub for open PRs, runs three review passes
 * (security, code quality, test quality) using Claude Code,
 * and posts results as PR comments.
 *
 * Optionally notifies a Discord channel when reviews complete.
 */

require("dotenv").config();
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Configuration ───────────────────────────────────────────────────────────

const REPOS = (process.env.GITHUB_REPOS || "").split(",").map((r) => r.trim()).filter(Boolean);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 180000; // 3 minutes
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "reviewer.log");
const STATE_FILE = path.join(__dirname, "review-state.json");
const PROMPTS_DIR = path.join(__dirname, "prompts");
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";
const DEBUG = process.env.DEBUG === "1";
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Review types and their prompt files
const REVIEW_TYPES = [
  { name: "security", file: "security-review.md", label: "Security" },
  { name: "code-quality", file: "code-quality-review.md", label: "Code Quality" },
  { name: "test-quality", file: "test-quality-review.md", label: "Test Quality" },
];

// ─── Validation ──────────────────────────────────────────────────────────────

if (REPOS.length === 0) {
  console.error("GITHUB_REPOS not set in .env (comma-separated list of owner/repo)");
  process.exit(1);
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE_BYTES) {
      const rotatedPath = `${LOG_FILE}.1`;
      fs.renameSync(LOG_FILE, rotatedPath);
    }
  } catch {
    // File does not exist yet or cannot be stat'd — nothing to rotate
  }
}

function log(level, msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${msg}`;
  if (DEBUG || level !== "DEBUG") {
    console.log(line);
  }
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ─── State Management ────────────────────────────────────────────────────────

let reviewState = {};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      reviewState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      log("INFO", `Loaded state: ${Object.keys(reviewState).length} tracked PRs`);
    }
  } catch (err) {
    log("WARN", `Could not load state: ${err.message}`);
    reviewState = {};
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(reviewState, null, 2));
  } catch (err) {
    log("WARN", `Could not save state: ${err.message}`);
  }
}

// Key format: "owner/repo#number"
function prKey(repo, number) {
  return `${repo}#${number}`;
}

function getPRState(repo, number) {
  return reviewState[prKey(repo, number)] || null;
}

function setPRState(repo, number, state) {
  reviewState[prKey(repo, number)] = state;
  saveState();
}

// ─── GitHub CLI Helpers ──────────────────────────────────────────────────────

function ghExec(args, options = {}) {
  try {
    const result = execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 60000,
      ...options,
    });
    return result.trim();
  } catch (err) {
    log("ERROR", `gh command failed: gh ${args.join(" ")} — ${err.message}`);
    return null;
  }
}

function listOpenPRs(repo) {
  const json = ghExec(["pr", "list", "--repo", repo, "--base", "dev", "--state", "open", "--json", "number,title,headRefName,updatedAt,additions,deletions"]);
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    log("ERROR", `Failed to parse PR list for ${repo}`);
    return [];
  }
}

function getPRDiff(repo, number) {
  return ghExec(["pr", "diff", String(number), "--repo", repo]);
}

function postPRComment(repo, number, body) {
  // Write comment to temp file to avoid shell escaping issues
  const tmpFile = path.join(__dirname, `.tmp-comment-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmpFile, body);
    ghExec(["pr", "comment", String(number), "--repo", repo, "--body-file", tmpFile]);
    log("INFO", `Posted comment on ${repo}#${number}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function getPRUpdatedAt(repo, number) {
  const json = ghExec(["pr", "view", String(number), "--repo", repo, "--json", "updatedAt"]);
  if (!json) return null;
  try {
    return JSON.parse(json).updatedAt;
  } catch {
    return null;
  }
}

// ─── Claude Code Execution ──────────────────────────────────────────────────

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, ["-p"], {
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`,
      },
      timeout: 300000, // 5 minute timeout per review
    });

    let stdout = "";
    let stderr = "";

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0 || stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

// ─── Discord Notification ────────────────────────────────────────────────────

async function notifyDiscord(message) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) return;

  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: message }),
      }
    );

    if (!response.ok) {
      log("WARN", `Discord notification failed: ${response.status}`);
    }
  } catch (err) {
    log("WARN", `Discord notification error: ${err.message}`);
  }
}

// ─── Review Logic ────────────────────────────────────────────────────────────

async function reviewPR(repo, pr) {
  const { number, title, headRefName } = pr;
  log("INFO", `Reviewing ${repo}#${number}: ${title} (${headRefName})`);

  // Get the diff
  const diff = getPRDiff(repo, number);
  if (!diff) {
    log("ERROR", `Could not get diff for ${repo}#${number}`);
    return;
  }

  // Truncate very large diffs to avoid overwhelming Claude
  const MAX_DIFF_LENGTH = 50000;
  const truncatedDiff = diff.length > MAX_DIFF_LENGTH
    ? diff.substring(0, MAX_DIFF_LENGTH) + "\n\n[Diff truncated — only first 50000 characters reviewed]"
    : diff;

  const results = [];

  for (const reviewType of REVIEW_TYPES) {
    const promptFile = path.join(PROMPTS_DIR, reviewType.file);
    if (!fs.existsSync(promptFile)) {
      log("ERROR", `Prompt file not found: ${promptFile}`);
      continue;
    }

    const rubric = fs.readFileSync(promptFile, "utf8");
    const fullPrompt = `${rubric}\n\n---\n\nHere is the pull request diff to review:\n\nPR Title: ${title}\nBranch: ${headRefName}\nRepository: ${repo}\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

    log("INFO", `Running ${reviewType.name} review on ${repo}#${number}...`);

    try {
      const review = await runClaude(fullPrompt);
      results.push({ type: reviewType, review });

      // Post as individual comment
      const comment = `## ${reviewType.label} Review\n\n${review}\n\n---\n*Automated review by PR Reviewer*`;
      postPRComment(repo, number, comment);

      log("INFO", `${reviewType.name} review complete for ${repo}#${number}`);
    } catch (err) {
      log("ERROR", `${reviewType.name} review failed for ${repo}#${number}: ${err.message}`);
      results.push({ type: reviewType, review: null, error: err.message });
    }

    // Brief pause between reviews to avoid rate limiting
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Update state
  const updatedAt = getPRUpdatedAt(repo, number) || new Date().toISOString();
  setPRState(repo, number, {
    reviewedAt: new Date().toISOString(),
    lastPRUpdate: updatedAt,
    reviews: results.map((r) => ({
      type: r.type.name,
      success: !!r.review,
      error: r.error || null,
    })),
  });

  // Build Discord summary
  const summaryParts = results.map((r) => {
    if (!r.review) return `${r.type.label}: failed (${r.error})`;
    if (r.review.includes("CHANGES REQUESTED")) return `${r.type.label}: changes requested`;
    if (r.review.includes("PASSED WITH SUGGESTIONS")) return `${r.type.label}: passed with suggestions`;
    return `${r.type.label}: passed`;
  });

  const discordMsg = `PR #${number} reviewed (${repo})\n${title}\n${summaryParts.join("\n")}\nhttps://github.com/${repo}/pull/${number}`;
  await notifyDiscord(discordMsg);

  log("INFO", `All reviews complete for ${repo}#${number}`);
}

// ─── Polling Loop ────────────────────────────────────────────────────────────

async function pollOnce() {
  for (const repo of REPOS) {
    log("DEBUG", `Checking ${repo} for open PRs...`);

    const prs = listOpenPRs(repo);
    if (prs.length === 0) {
      log("DEBUG", `No open PRs targeting dev in ${repo}`);
      continue;
    }

    for (const pr of prs) {
      const state = getPRState(repo, pr.number);
      const currentUpdatedAt = pr.updatedAt;

      if (state && state.lastPRUpdate === currentUpdatedAt) {
        log("DEBUG", `${repo}#${pr.number} already reviewed at this version, skipping`);
        continue;
      }

      if (state) {
        log("INFO", `${repo}#${pr.number} has new commits since last review, re-reviewing`);
      }

      try {
        await reviewPR(repo, pr);
      } catch (err) {
        log("ERROR", `Failed to review ${repo}#${pr.number}: ${err.message}`);
      }
    }
  }
}

// ─── Cleanup Old State ───────────────────────────────────────────────────────

function cleanupOldState() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
  let cleaned = 0;
  for (const key of Object.keys(reviewState)) {
    const state = reviewState[key];
    if (state.reviewedAt && new Date(state.reviewedAt).getTime() < cutoff) {
      delete reviewState[key];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log("INFO", `Cleaned up ${cleaned} old PR review records`);
    saveState();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log("INFO", "PR Reviewer starting");
  log("INFO", `Watching repos: ${REPOS.join(", ")}`);
  log("INFO", `Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  log("INFO", `Discord notifications: ${DISCORD_BOT_TOKEN ? "enabled" : "disabled"}`);

  loadState();
  cleanupOldState();

  // Run immediately on start
  await pollOnce();

  // Then poll on interval
  setInterval(async () => {
    try {
      await pollOnce();
    } catch (err) {
      log("ERROR", `Poll cycle error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  console.log("PR Reviewer is running. Press Ctrl+C to stop.");
}

// Graceful shutdown
process.on("SIGINT", () => {
  log("INFO", "Shutting down...");
  saveState();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("INFO", "Shutting down...");
  saveState();
  process.exit(0);
});

main().catch((err) => {
  log("ERROR", `Fatal error: ${err.message}`);
  process.exit(1);
});