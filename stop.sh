#!/bin/bash
tmux kill-session -t "pr-reviewer" 2>/dev/null && \
  echo "PR Reviewer stopped" || \
  echo "No running reviewer session found"