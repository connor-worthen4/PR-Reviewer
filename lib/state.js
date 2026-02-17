/**
 * State management for tracked PRs and processed comments.
 * Persists to disk as JSON. Includes automatic cleanup of old entries.
 */

const fs = require("fs");
const { STATE_FILE, log } = require("./config");

let reviewState = {};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      reviewState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (err) {
    log("WARN", `Could not load state: ${err.message}`);
    reviewState = {};
  }
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(reviewState, null, 2));
  } catch (err) {
    log("WARN", `Could not save state: ${err.message}`);
  }
}

function key(repo, number) {
  return `${repo}#${number}`;
}

function get(repo, number) {
  return reviewState[key(repo, number)] || null;
}

function set(repo, number, state) {
  reviewState[key(repo, number)] = state;
  save();
}

/** Remove entries older than 30 days. */
function cleanup() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const k of Object.keys(reviewState)) {
    const entry = reviewState[k];
    if (entry.reviewedAt && new Date(entry.reviewedAt).getTime() < cutoff) {
      delete reviewState[k];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log("INFO", `Cleaned up ${cleaned} stale PR records`);
    save();
  }
}

module.exports = { load, save, get, set, cleanup };
