@AGENTS.md

<!-- delegation:start -->
## Agent Usage Rules (this project only)
Project context for all agents lives in `.claude/project-context.md`. Every sub-agent brief must tell the agent to read it and this file first, and must include the specific files and findings relevant to its task.

- Use plan-agent for high-level planning, architecture decisions, and breaking down features.
- Use reader-agent for finding code and understanding how things work.
- Use maker-agent for writing, editing, and refactoring code.
- Use test-agent for writing and running tests after code changes.
- Use security-agent to review changes touching auth, user input, payments, webhooks, or secrets.
- Use debug-agent to diagnose errors before fixing them.
- Use docs-agent for documentation, and to update `.claude/project-context.md` when the stack, structure, or commands change.

Small questions and one-line edits may be handled directly without delegating.

Extra approval rules: Bash(npm run deploy:*), Bash(prisma migrate deploy:*), Bash(npx prisma migrate deploy:*), Bash(gcloud run deploy:*), Bash(gcloud run services update-traffic:*), Bash(gcloud run services delete:*), Bash(gcloud secrets:*), Bash(gh workflow run:*)
<!-- delegation:end -->
