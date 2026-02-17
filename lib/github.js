/**
 * GitHub API client.
 *
 * Two authentication layers:
 *   1. GitHub App (JWT → installation token) for posting comments/reviews as a bot
 *   2. gh CLI fallback for everything else (reading PRs, diffs, labels)
 *
 * Every public function that posts content tries the App API first,
 * then falls back to gh CLI transparently.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID,
  GITHUB_APP_PRIVATE_KEY_PATH,
  GITHUB_USERNAME,
  BOT_MARKER,
  BOT_PREFIX,
  log,
} = require("./config");

// ─── App Token Management ───────────────────────────────────────────────────

let _token = null;
let _tokenExpiresAt = 0;

function generateJWT() {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY_PATH) return null;

  const privateKey = fs.readFileSync(GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 600, iss: GITHUB_APP_ID });
  const input = `${header}.${payload}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(input);
  return `${input}.${sign.sign(privateKey, "base64url")}`;
}

async function getAppToken() {
  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID || !GITHUB_APP_PRIVATE_KEY_PATH) {
    return null;
  }

  // Return cached token if still valid (refresh 5 min before expiry)
  if (_token && Date.now() < _tokenExpiresAt - 300_000) return _token;

  const jwt = generateJWT();
  if (!jwt) return null;

  try {
    const res = await fetch(
      `https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!res.ok) {
      log("ERROR", `App token refresh failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    _token = data.token;
    _tokenExpiresAt = new Date(data.expires_at).getTime();
    log("INFO", "GitHub App token refreshed");
    return _token;
  } catch (err) {
    log("ERROR", `App token refresh failed: ${err.message}`);
    return null;
  }
}

/** Authenticated GitHub API request via App token. Returns parsed JSON or null. */
async function appApi(method, endpoint, body = null) {
  const token = await getAppToken();
  if (!token) return null;

  const options = {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const url = endpoint.startsWith("https://")
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    log("WARN", `App API ${method} ${endpoint}: ${res.status} ${text.substring(0, 200)}`);
    return null;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ─── gh CLI ─────────────────────────────────────────────────────────────────

function ghExec(args, options = {}) {
  try {
    return execSync(`gh ${args}`, { encoding: "utf8", timeout: 60000, ...options }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    log("ERROR", `gh ${args.split(" ").slice(0, 3).join(" ")}... failed${stderr ? `: ${stderr.substring(0, 150)}` : ""}`);
    return null;
  }
}

// ─── Read Operations (gh CLI) ───────────────────────────────────────────────

function listOpenPRs(repo) {
  const json = ghExec(
    `pr list --repo ${repo} --base dev --state open --json number,title,headRefName,updatedAt,headRefOid,labels`
  );
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}

function getPRDiff(repo, number) {
  return ghExec(`pr diff ${number} --repo ${repo}`);
}

function getPRUpdatedAt(repo, number) {
  const json = ghExec(`pr view ${number} --repo ${repo} --json updatedAt`);
  if (!json) return null;
  try { return JSON.parse(json).updatedAt; } catch { return null; }
}

function getFullCommitSha(repo, number) {
  const sha = ghExec(`pr view ${number} --repo ${repo} --json headRefOid --jq '.headRefOid'`);
  if (sha && sha.length === 40) return sha;
  const fallback = ghExec(`api repos/${repo}/pulls/${number}/commits --jq '.[-1].sha'`);
  if (fallback && fallback.length === 40) return fallback;
  return null;
}

function getBranchName(repo, number) {
  const json = ghExec(`pr view ${number} --repo ${repo} --json headRefName`);
  if (!json) return null;
  try { return JSON.parse(json).headRefName; } catch { return null; }
}

function addLabel(repo, number, label) {
  ghExec(`pr edit ${number} --repo ${repo} --add-label ${label}`);
}

function removeLabel(repo, number, label) {
  ghExec(`pr edit ${number} --repo ${repo} --remove-label ${label}`);
}

// ─── Comment Reading ────────────────────────────────────────────────────────

function getUnprocessedReviewComments(repo, number) {
  const json = ghExec(
    `api "repos/${repo}/pulls/${number}/comments?sort=created&direction=asc&per_page=100"`
  );
  if (!json) return [];
  try { return JSON.parse(json).filter(isUserComment); } catch { return []; }
}

function getUnprocessedIssueComments(repo, number) {
  const json = ghExec(`api "repos/${repo}/issues/${number}/comments"`);
  if (!json) return [];
  try { return JSON.parse(json).filter(isUserComment); } catch { return []; }
}

/** Filter out bot-generated and non-user comments. */
function isUserComment(c) {
  if (c.body.includes("<!-- pr-reviewer-bot -->")) return false;
  if (GITHUB_USERNAME && c.user.login !== GITHUB_USERNAME) return false;
  if (c.user.type === "Bot") return false;
  if (c.body.includes("Automated review by PR Reviewer")) return false;
  if (/^\*\*\[(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*/.test(c.body)) return false;
  if (c.body.includes("Review Summary")) return false;
  if (c.body.includes("**PASSED**")) return false;
  if (c.body.startsWith("Fixed in commit")) return false;
  return true;
}

// ─── Write Operations (App API → gh CLI fallback) ───────────────────────────

/** Post a general comment on a PR. */
async function postComment(repo, number, body) {
  const result = await appApi("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  if (result) return;

  const tmp = writeTmp(body);
  try {
    ghExec(`pr comment ${number} --repo ${repo} --body-file ${tmp}`);
  } finally {
    cleanTmp(tmp);
  }
}

/** Post a pull request review with inline comments. */
async function postReview(repo, number, payload) {
  const result = await appApi("POST", `/repos/${repo}/pulls/${number}/reviews`, payload);
  if (result) return true;

  const tmp = writeTmp(JSON.stringify(payload));
  try {
    return !!ghExec(`api repos/${repo}/pulls/${number}/reviews --method POST --input ${tmp}`);
  } finally {
    cleanTmp(tmp);
  }
}

/** Reply to an inline review comment, threaded under the original. */
async function replyToComment(repo, number, commentId, body) {
  const taggedBody = BOT_PREFIX + body + BOT_MARKER;

  const result = await appApi(
    "POST",
    `/repos/${repo}/pulls/${number}/comments/${commentId}/replies`,
    { body: taggedBody }
  );
  if (result) return;

  // Fallback to gh CLI
  const tmp = writeTmp(JSON.stringify({ body: taggedBody }));
  try {
    const ok = ghExec(
      `api repos/${repo}/pulls/${number}/comments/${commentId}/replies --method POST --input ${tmp}`
    );
    if (!ok) {
      // Last resort: post as general comment
      await postComment(repo, number, taggedBody);
    }
  } catch {
    await postComment(repo, number, taggedBody);
  } finally {
    cleanTmp(tmp);
  }
}

// ─── Temp File Helpers ──────────────────────────────────────────────────────

function writeTmp(content) {
  const file = path.join(__dirname, "..", `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.writeFileSync(file, content);
  return file;
}

function cleanTmp(file) {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Read
  listOpenPRs,
  getPRDiff,
  getPRUpdatedAt,
  getFullCommitSha,
  getBranchName,
  addLabel,
  removeLabel,
  getUnprocessedReviewComments,
  getUnprocessedIssueComments,
  // Write
  postComment,
  postReview,
  replyToComment,
  // Auth
  isAppConfigured: () => !!(GITHUB_APP_ID && GITHUB_APP_INSTALLATION_ID && GITHUB_APP_PRIVATE_KEY_PATH),
};
