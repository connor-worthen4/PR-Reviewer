/**
 * Configuration and constants.
 * Loads environment variables and exports all shared config.
 * This module imports nothing from lib/ to prevent circular dependencies.
 */

require("dotenv").config();
const path = require("path");

// ─── Environment ────────────────────────────────────────────────────────────

const REPOS = (process.env.GITHUB_REPOS || "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 180000;
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "..", "reviewer.log");
const STATE_FILE = path.join(__dirname, "..", "review-state.json");
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");
const DEBUG = process.env.DEBUG === "1";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";

const GITHUB_USERNAME = process.env.GITHUB_USERNAME || "";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || "";
const GITHUB_APP_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH || "";

const PROJECT_DIRS = {};
if (process.env.PROJECT_DIRS) {
  for (const entry of process.env.PROJECT_DIRS.split(",")) {
    const [repo, dir] = entry.split("=").map((s) => s.trim());
    if (repo && dir) PROJECT_DIRS[repo] = dir;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BOT_MARKER = "\n\n<!-- pr-reviewer-bot -->";
const BOT_PREFIX = "**PR Reviewer** | ";
const MAX_DIFF_LENGTH = 50000;

const REVIEW_TYPES = [
  { name: "security", file: "security-review.md", label: "Security" },
  { name: "code-quality", file: "code-quality-review.md", label: "Code Quality" },
  { name: "test-quality", file: "test-quality-review.md", label: "Test Quality" },
];

// ─── Logging ────────────────────────────────────────────────────────────────

const fs = require("fs");

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (DEBUG || level !== "DEBUG") console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateConfig() {
  if (REPOS.length === 0) {
    console.error("GITHUB_REPOS not set in .env");
    process.exit(1);
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  REPOS,
  POLL_INTERVAL_MS,
  CLAUDE_PATH,
  LOG_FILE,
  STATE_FILE,
  PROMPTS_DIR,
  DEBUG,
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_USERNAME,
  GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID,
  GITHUB_APP_PRIVATE_KEY_PATH,
  PROJECT_DIRS,
  BOT_MARKER,
  BOT_PREFIX,
  MAX_DIFF_LENGTH,
  REVIEW_TYPES,
  log,
  validateConfig,
};
