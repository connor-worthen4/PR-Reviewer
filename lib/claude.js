/**
 * Claude Code execution and response parsing.
 * Spawns `claude -p` with prompts and parses structured JSON responses.
 */

const { spawn } = require("child_process");
const { CLAUDE_PATH, log } = require("./config");

/**
 * Run a prompt through Claude Code and return the raw text response.
 * @param {string} prompt - The prompt to send
 * @param {string|null} cwd - Working directory for the Claude process
 * @returns {Promise<string>}
 */
function run(prompt, cwd = null) {
  return new Promise((resolve, reject) => {
    const options = {
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`,
      },
      timeout: 300_000,
    };
    if (cwd) options.cwd = cwd;

    const proc = spawn(CLAUDE_PATH, ["-p"], options);
    let stdout = "";
    let stderr = "";

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0 || stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

/**
 * Parse a structured review response from Claude.
 * Handles markdown fences and extracts the JSON object.
 * @returns {{ status: string, findings: Array, summary: string }}
 */
function parseReviewResponse(raw) {
  let cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in Claude response");
  }

  const parsed = JSON.parse(cleaned.substring(start, end + 1));

  if (!parsed.status || !Array.isArray(parsed.findings)) {
    throw new Error("Response missing required fields (status, findings)");
  }

  return parsed;
}

/**
 * Parse a commit-info JSON response (used by !fix and !fix-lint).
 * @returns {{ commit: string, summary: string }}
 */
function parseCommitResponse(raw) {
  const match = raw.match(/\{[\s\S]*"commit"[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  return { commit: "unknown", summary: raw.substring(0, 200) };
}

module.exports = { run, parseReviewResponse, parseCommitResponse };
