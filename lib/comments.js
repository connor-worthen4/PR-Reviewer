/**
 * Comment polling and command handling.
 * Monitors reviewed PRs for new comments and dispatches commands:
 *   !review   → re-trigger review
 *   !fix      → fix a specific finding
 *   !fix-lint → auto-fix all lint issues
 *   (other)   → respond naturally via Claude
 */

const { REPOS, PROJECT_DIRS, BOT_PREFIX, BOT_MARKER, log } = require("./config");
const github = require("./github");
const claude = require("./claude");
const discord = require("./discord");
const state = require("./state");

/**
 * Poll all repos for new comments on reviewed PRs.
 */
async function poll() {
  for (const repo of REPOS) {
    const projectDir = PROJECT_DIRS[repo];
    if (!projectDir) continue;

    const prs = github.listOpenPRs(repo);

    for (const pr of prs) {
      const prState = state.get(repo, pr.number) || {};
      if (!prState.processedCommentIds) prState.processedCommentIds = [];

      const comments = mergeAndFilter(repo, pr.number, prState.processedCommentIds);
      if (comments.length === 0) continue;

      log("INFO", `Found ${comments.length} new comments on ${repo}#${pr.number}`);

      for (const comment of comments) {
        await handleComment(repo, pr, comment, projectDir, prState);
        prState.processedCommentIds.push(comment.id);
        state.set(repo, pr.number, prState);
        await sleep(2000);
      }
    }
  }
}

// ─── Comment Merging & Filtering ────────────────────────────────────────────

function mergeAndFilter(repo, number, processedIds) {
  const review = github.getUnprocessedReviewComments(repo, number);
  const issue = github.getUnprocessedIssueComments(repo, number);

  return [
    ...review.map((c) => ({ ...c, isInline: true })),
    ...issue.map((c) => ({ ...c, isInline: false })),
  ]
    .filter((c) => !processedIds.includes(c.id))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

// ─── Command Dispatch ───────────────────────────────────────────────────────

async function handleComment(repo, pr, comment, projectDir, prState) {
  const command = parseCommand(comment.body);
  const context = comment.isInline ? getCommentContext(comment) : {};

  try {
    switch (command) {
      case "review":
        return await handleReview(repo, pr);
      case "fix-lint":
        return await handleFixLint(repo, pr, projectDir);
      case "fix":
        return await handleFix(repo, pr, comment, context, projectDir);
      default:
        return await handleResponse(repo, pr, comment, context);
    }
  } catch (err) {
    log("ERROR", `Failed to handle comment on ${repo}#${pr.number}: ${err.message}`);
  }
}

function parseCommand(body) {
  const trimmed = body.trim().toLowerCase();
  if (trimmed === "!review") return "review";
  if (trimmed === "!fix-lint") return "fix-lint";
  if (trimmed.startsWith("!fix")) return "fix";
  return null;
}

function getCommentContext(comment) {
  return {
    file: comment.path || null,
    line: comment.line || comment.original_line || null,
    originalComment: comment.in_reply_to_id ? null : comment.body,
    diff_hunk: comment.diff_hunk || null,
  };
}

// ─── Command Handlers ───────────────────────────────────────────────────────

async function handleReview(repo, pr) {
  log("INFO", `!review command on ${repo}#${pr.number}`);
  github.addLabel(repo, pr.number, "review");
}

async function handleFixLint(repo, pr, projectDir) {
  log("INFO", `!fix-lint command on ${repo}#${pr.number}`);

  const branch = github.getBranchName(repo, pr.number);
  if (!branch) throw new Error("Could not get branch name");

  const prompt = `You are fixing lint issues on branch "${branch}" in the project at ${projectDir}.

Instructions:
1. git checkout ${branch} && git pull origin ${branch}
2. For backend Python files: run "cd ${projectDir}/backend && ruff check . --fix && ruff format ."
3. For frontend files: run "cd ${projectDir}/frontend && npx eslint . --fix" (only if frontend/node_modules exists)
4. Check if there are any changes with git status
5. If there are changes, commit with message: "style: auto-fix lint issues"
6. Push to origin
7. If there were NO changes (lint was already clean), respond with: {"commit": "none", "summary": "No lint issues found"}
8. If there were changes, respond with ONLY a JSON object: {"commit": "full_40_char_sha", "summary": "brief description of what was fixed"}`;

  const raw = await claude.run(prompt, projectDir);
  const result = claude.parseCommitResponse(raw);

  const replyBody = result.commit === "none"
    ? "No lint issues found — code is already clean."
    : `Lint fixes applied in commit ${result.commit}.\n\n${result.summary}`;

  await github.postComment(repo, pr.number, BOT_PREFIX + replyBody + BOT_MARKER);

  if (result.commit !== "none") {
    await discord.notify(
      `**PR #${pr.number}** — lint fixes pushed\n> ${result.summary}\nhttps://github.com/${repo}/commit/${result.commit}`
    );
  }
}

async function handleFix(repo, pr, comment, context, projectDir) {
  log("INFO", `!fix command on ${repo}#${pr.number}`);

  const branch = github.getBranchName(repo, pr.number);
  if (!branch) throw new Error("Could not get branch name");

  let prompt = `You are fixing ONE specific code review finding on branch "${branch}".\n\n`;
  prompt += `IMPORTANT: Fix ONLY the specific issue described below. Do NOT fix any other issues in the file, even if you see them. Make the minimum change necessary.\n\n`;

  if (context.file) prompt += `File: ${context.file}\n`;
  if (context.line) prompt += `Line: ${context.line}\n`;
  if (context.diff_hunk) prompt += `\nRelevant code:\n\`\`\`\n${context.diff_hunk}\n\`\`\`\n`;
  if (context.originalComment) prompt += `\nThe review finding to fix:\n${context.originalComment}\n`;

  prompt += `\nDeveloper said: ${comment.body}\n\n`;
  prompt += `Instructions:\n`;
  prompt += `1. git checkout ${branch} && git pull origin ${branch}\n`;
  prompt += `2. Fix ONLY the specific issue described above in ${context.file || "the relevant file"}. Do not touch anything else.\n`;
  prompt += `3. Commit with message: "fix: [brief description of the single fix]"\n`;
  prompt += `4. Push to origin\n`;
  prompt += `5. Respond with ONLY a JSON object: {"commit": "full_sha", "summary": "one sentence describing what you fixed"}\n`;

  const raw = await claude.run(prompt, projectDir);
  const fix = claude.parseCommitResponse(raw);

  if (comment.isInline && comment.id) {
    await github.replyToComment(repo, pr.number, comment.id, `Fixed in commit ${fix.commit}.\n\n${fix.summary}`);
  } else {
    await github.postComment(repo, pr.number, `${BOT_PREFIX}Fixed in commit ${fix.commit}.\n\n${fix.summary}${BOT_MARKER}`);
  }

  await discord.notify(
    `**PR #${pr.number}** — fix pushed\n> ${fix.summary}\nhttps://github.com/${repo}/commit/${fix.commit}`
  );
}

async function handleResponse(repo, pr, comment, context) {
  log("INFO", `Responding to comment on ${repo}#${pr.number}`);

  let prompt = "You are a code reviewer responding to a developer's comment on a pull request.\n\n";
  if (context.file) prompt += `File: ${context.file}\n`;
  if (context.line) prompt += `Line: ${context.line}\n`;
  if (context.diff_hunk) prompt += `\nCode context:\n\`\`\`\n${context.diff_hunk}\n\`\`\`\n`;
  if (context.originalComment) prompt += `\nOriginal review finding:\n${context.originalComment}\n`;

  prompt += `\nDeveloper's comment:\n${comment.body}\n\n`;
  prompt += `Respond naturally and concisely. No emojis.\n`;
  prompt += `- If they asked a question, answer it directly.\n`;
  prompt += `- If they disagree, engage with their reasoning.\n`;
  prompt += `- If they suggest an alternative, evaluate it honestly.\n`;
  prompt += `- If they need clarification, ask a specific follow-up.\n`;
  prompt += `- If they acknowledge the finding, respond briefly.\n`;
  prompt += `- If a code change would help, suggest it and mention they can reply with "!fix".\n`;

  const response = await claude.run(prompt);

  if (comment.isInline && comment.id) {
    await github.replyToComment(repo, pr.number, comment.id, response);
  } else {
    await github.postComment(repo, pr.number, BOT_PREFIX + response + BOT_MARKER);
  }

  const preview = comment.body.substring(0, 80).replace(/\n/g, " ");
  await discord.notify(
    `**PR #${pr.number}** — replied to comment\n> ${preview}\nhttps://github.com/${repo}/pull/${pr.number}`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { poll };
