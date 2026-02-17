#!/usr/bin/env node

/**
 * PR Reviewer — Automated code review using Claude Code.
 *
 * Polls GitHub for open PRs, runs specialized review agents,
 * posts inline comments on specific lines, handles commands,
 * and sends Discord notifications.
 *
 * See USAGE.md for the full workflow guide.
 */

const { REPOS, POLL_INTERVAL_MS, log, validateConfig } = require("./lib/config");
const github = require("./lib/github");
const state = require("./lib/state");
const { reviewPR } = require("./lib/review");
const comments = require("./lib/comments");

// ─── Poll Cycle ─────────────────────────────────────────────────────────────

async function pollForReviews() {
  for (const repo of REPOS) {
    const prs = github.listOpenPRs(repo);

    const reviewable = prs.filter((pr) => {
      const prState = state.get(repo, pr.number);
      const hasReviewLabel = (pr.labels || []).some((l) => l.name === "review");
      return !prState || hasReviewLabel;
    });

    if (reviewable.length === 0) {
      log("INFO", `${repo}: ${prs.length} open PRs, none need review`);
      continue;
    }

    for (const pr of reviewable) {
      const prState = state.get(repo, pr.number);
      const hasReviewLabel = (pr.labels || []).some((l) => l.name === "review");

      if (!prState) {
        log("INFO", `${repo}#${pr.number} is new, starting review`);
      } else {
        log("INFO", `${repo}#${pr.number} has "review" label, re-reviewing`);
      }

      try {
        await reviewPR(repo, pr);
        if (hasReviewLabel) {
          github.removeLabel(repo, pr.number, "review");
        }
      } catch (err) {
        log("ERROR", `Failed to review ${repo}#${pr.number}: ${err.message}`);
      }
    }
  }
}

async function pollCycle() {
  log("INFO", "Poll cycle starting");
  await comments.poll();
  await pollForReviews();
  await comments.poll();
  log("INFO", "Poll cycle complete");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();

  log("INFO", "PR Reviewer starting");
  log("INFO", `Watching: ${REPOS.join(", ")}`);
  log("INFO", `Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  log("INFO", `GitHub App: ${github.isAppConfigured() ? "enabled" : "disabled"}`);

  state.load();
  state.cleanup();

  await pollCycle();

  setInterval(async () => {
    try {
      await pollCycle();
    } catch (err) {
      log("ERROR", `Poll cycle error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

process.on("SIGINT", () => { state.save(); process.exit(0); });
process.on("SIGTERM", () => { state.save(); process.exit(0); });

main().catch((err) => { log("ERROR", `Fatal: ${err.message}`); process.exit(1); });
