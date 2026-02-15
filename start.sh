#!/bin/bash
SESSION_NAME="pr-reviewer"
REVIEWER_DIR="$HOME/pr-reviewer"

tmux kill-session -t "$SESSION_NAME" 2>/dev/null
tmux new-session -d -s "$SESSION_NAME" -c "$REVIEWER_DIR"
tmux send-keys -t "$SESSION_NAME" 'node reviewer.js' Enter

echo "PR Reviewer started in tmux session '$SESSION_NAME'"
echo ""
echo "   Attach:  tmux attach -t $SESSION_NAME"
echo "   Detach:  Ctrl+B then D"
echo "   Logs:    tail -f $REVIEWER_DIR/reviewer.log"
echo "   Stop:    ./stop.sh"