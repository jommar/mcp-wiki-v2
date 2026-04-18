#!/bin/bash
# Pre-commit hook: run lint and format

echo "Running lint..."
cd "$(dirname "$0")/.." || exit 1
npm run lint
if [ $? -ne 0 ]; then
  echo "Lint failed. Fix issues before committing."
  exit 1
fi

echo "Running prettier..."
npm run format
if [ $? -ne 0 ]; then
  echo "Prettier failed."
  exit 1
fi

# Re-add any files changed by prettier
git add -A > /dev/null 2>&1

echo "Lint and format passed."
exit 0