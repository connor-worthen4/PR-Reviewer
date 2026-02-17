/**
 * Review orchestration.
 * Runs each review agent against a PR diff, maps findings to diff positions,
 * posts inline comments, and sends a summary.
 */

const fs = require("fs");
const path = require("path");
const { REVIEW_TYPES, PROMPTS_DIR, MAX_DIFF_LENGTH, BOT_MARKER, log } = require("./config");
const github = require("./github");
const claude = require("./claude");
const diff = require("./diff");
const discord = require("./discord");
const state = require("./state");

/**
 * Run all review agents on a PR and post results.
 */
async function reviewPR(repo, pr) {
  const { number, title, headRefName, headRefOid } = pr;
  log("INFO", `Reviewing ${repo}#${number}: ${title}`);

  const commitSha = github.getFullCommitSha(repo, number) || headRefOid;
  if (!commitSha || commitSha.length < 40) {
    log("ERROR", `Could not get full commit SHA for ${repo}#${number}`);
    return;
  }

  const rawDiff = github.getPRDiff(repo, number);
  if (!rawDiff) {
    log("ERROR", `Could not get diff for ${repo}#${number}`);
    return;
  }

  const diffData = diff.parseDiffPositions(rawDiff);
  const truncatedDiff = rawDiff.length > MAX_DIFF_LENGTH
    ? rawDiff.substring(0, MAX_DIFF_LENGTH) + "\n\n[Diff truncated]"
    : rawDiff;

  const results = [];

  for (const reviewType of REVIEW_TYPES) {
    const promptFile = path.join(PROMPTS_DIR, reviewType.file);
    if (!fs.existsSync(promptFile)) {
      log("ERROR", `Prompt file missing: ${reviewType.file}`);
      results.push({ type: reviewType, parsed: null });
      continue;
    }

    log("INFO", `Running ${reviewType.name} review on ${repo}#${number}`);

    try {
      const rubric = fs.readFileSync(promptFile, "utf8");
      const prompt = [
        rubric,
        "\n---\n\nHere is the pull request diff to review:\n",
        `PR Title: ${title}\nBranch: ${headRefName}\nRepository: ${repo}\n`,
        `\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
      ].join("");

      const raw = await claude.run(prompt);
      const parsed = claude.parseReviewResponse(raw);
      log("INFO", `${reviewType.name}: ${parsed.status}, ${parsed.findings.length} findings`);

      mapFindingsToPositions(parsed.findings, diffData);

      if (parsed.findings.length > 0) {
        await postInlineReview(repo, number, commitSha, reviewType, parsed);
      } else {
        await postPassedReview(repo, number, commitSha, reviewType, parsed);
      }

      results.push({ type: reviewType, parsed });
    } catch (err) {
      log("ERROR", `${reviewType.name} review failed: ${err.message}`);
      results.push({ type: reviewType, parsed: null, error: err.message });
    }

    await sleep(2000);
  }

  const { totalFindings, breakdown } = buildSummary(results);
  await postSummaryComment(repo, number, results);
  await updateState(repo, pr, commitSha, results);
  await notifyReviewComplete(repo, number, title, totalFindings, breakdown);

  log("INFO", `Review complete for ${repo}#${number}: ${totalFindings} findings`);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function mapFindingsToPositions(findings, diffData) {
  for (const finding of findings) {
    if (!finding.file) continue;
    const targetLine = finding.line || 0;

    if (targetLine === 0) {
      const fileData = diffData[finding.file];
      finding.position = fileData?.validPositions.size > 0
        ? Math.min(...fileData.validPositions)
        : null;
    } else {
      finding.position = diff.lineToPosition(finding.file, targetLine, diffData) || null;
    }
  }
}

async function postInlineReview(repo, number, commitSha, reviewType, parsed) {
  const commentMap = new Map();

  for (const f of parsed.findings) {
    if (!f.file || !f.position) continue;
    const key = `${f.file}:${f.position}`;
    if (commentMap.has(key)) {
      commentMap.get(key).body += `\n\n**[${f.severity}]** ${f.message}`;
    } else {
      commentMap.set(key, {
        path: f.file,
        position: f.position,
        body: `**[${f.severity}]** ${f.message}`,
      });
    }
  }

  const comments = Array.from(commentMap.values());
  if (comments.length === 0) {
    await postFallbackComment(repo, number, reviewType, parsed);
    return;
  }

  const payload = {
    commit_id: commitSha,
    body: `## ${reviewType.label} Review\n\n**${parsed.status.replace(/_/g, " ")}** — ${parsed.summary}`,
    event: "COMMENT",
    comments,
  };

  const ok = await github.postReview(repo, number, payload);
  if (!ok) {
    await postFallbackComment(repo, number, reviewType, parsed);
  }
}

async function postPassedReview(repo, number, commitSha, reviewType, parsed) {
  await github.postReview(repo, number, {
    commit_id: commitSha,
    body: `## ${reviewType.label} Review\n\n**PASSED** — ${parsed.summary}`,
    event: "COMMENT",
    comments: [],
  });
}

async function postFallbackComment(repo, number, reviewType, parsed) {
  let body = `## ${reviewType.label} Review\n\n**${parsed.status.replace(/_/g, " ")}** — ${parsed.summary}\n\n`;
  for (const f of parsed.findings) {
    body += `- **[${f.severity}]** \`${f.file}:${f.line}\` — ${f.message}\n`;
  }
  body += `\n---\n*Automated review by PR Reviewer*${BOT_MARKER}`;
  await github.postComment(repo, number, body);
}

async function postSummaryComment(repo, number, results) {
  const lines = ["## Review Summary\n"];
  let total = 0;

  for (const r of results) {
    if (!r.parsed) {
      lines.push(`**${r.type.label}**: failed to run`);
      continue;
    }
    const count = r.parsed.findings.length;
    total += count;
    const display = r.parsed.status.replace(/_/g, " ");

    if (count === 0) {
      lines.push(`**${r.type.label}**: ${display}`);
    } else {
      const counts = {};
      for (const f of r.parsed.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
      const sev = Object.entries(counts).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ");
      lines.push(`**${r.type.label}**: ${display} (${sev})`);
    }
  }

  lines.push(total === 0
    ? "\nAll checks passed. No issues found."
    : `\n${total} total findings. See inline comments for details.`
  );
  lines.push(`\n---\n*Automated review by PR Reviewer*${BOT_MARKER}`);

  await github.postComment(repo, number, lines.join("\n"));
}

function buildSummary(results) {
  let totalFindings = 0;
  const breakdown = [];

  for (const r of results) {
    if (!r.parsed) { breakdown.push(`${r.type.label}: error`); continue; }
    const count = r.parsed.findings.length;
    totalFindings += count;
    if (count === 0) {
      breakdown.push(`${r.type.label}: passed`);
    } else {
      const counts = {};
      for (const f of r.parsed.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
      const sev = Object.entries(counts).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ");
      breakdown.push(`${r.type.label}: ${count} issues (${sev})`);
    }
  }

  return { totalFindings, breakdown };
}

async function updateState(repo, pr, commitSha, results) {
  const existing = state.get(repo, pr.number) || {};
  const updatedAt = github.getPRUpdatedAt(repo, pr.number) || new Date().toISOString();

  state.set(repo, pr.number, {
    ...existing,
    reviewedAt: new Date().toISOString(),
    lastPRUpdate: updatedAt,
    commitSha,
    reviews: results.map((r) => ({
      type: r.type.name,
      status: r.parsed?.status || "ERROR",
      findings: r.parsed?.findings?.length || 0,
      error: r.error || null,
    })),
  });
}

async function notifyReviewComplete(repo, number, title, totalFindings, breakdown) {
  const url = `https://github.com/${repo}/pull/${number}`;
  const msg = totalFindings === 0
    ? `**PR #${number}** — all checks passed\n> ${title}\n${url}`
    : `**PR #${number}** — ${totalFindings} issues found\n> ${title}\n${breakdown.join(" | ")}\n${url}`;
  await discord.notify(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { reviewPR };
