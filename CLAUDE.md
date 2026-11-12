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

Extra approval rules (keep in sync with `.claude/settings.json`): Bash(git -C * push:*), Bash(git -c * push:*), Bash(git checkout --:*), Bash(git restore:*), Bash(npx shopify app deploy:*), Bash(npx shopify app release:*), Bash(npx shopify theme push:*), Bash(npx shopify theme publish:*), Bash(npm run deploy:*), Bash(npm run shopify:*), Bash(npm run prisma:*), Bash(npm run setup:*), Bash(prisma migrate deploy:*), Bash(npx prisma migrate deploy:*), Bash(gcloud run deploy:*), Bash(gcloud run services update:*), Bash(gcloud run services update-traffic:*), Bash(gcloud run services replace:*), Bash(gcloud run services delete:*), Bash(gcloud secrets create:*), Bash(gcloud secrets delete:*), Bash(gcloud secrets versions add:*), Bash(gcloud secrets versions access:*), Bash(gcloud secrets versions destroy:*), Bash(gcloud secrets versions disable:*), Bash(docker push:*), Bash(gh workflow run:*), Bash(rm *-r*), Bash(rm *-R*), Bash(rm *-fr*), Bash(rm *-fR*), PowerShell(git push:*), PowerShell(git reset --hard:*), PowerShell(git clean:*), PowerShell(git branch -D:*), PowerShell(shopify app deploy:*), PowerShell(shopify app release:*), PowerShell(shopify theme push:*), PowerShell(shopify theme publish:*), PowerShell(npm publish:*), PowerShell(prisma migrate reset:*), PowerShell(npx prisma migrate reset:*), PowerShell(prisma db push --force-reset:*), PowerShell(npx prisma db push --force-reset:*), PowerShell(git -C * push:*), PowerShell(git -c * push:*), PowerShell(git checkout --:*), PowerShell(git restore:*), PowerShell(npx shopify app deploy:*), PowerShell(npx shopify app release:*), PowerShell(npx shopify theme push:*), PowerShell(npx shopify theme publish:*), PowerShell(npm run deploy:*), PowerShell(npm run shopify:*), PowerShell(npm run prisma:*), PowerShell(npm run setup:*), PowerShell(prisma migrate deploy:*), PowerShell(npx prisma migrate deploy:*), PowerShell(gcloud run deploy:*), PowerShell(gcloud run services update:*), PowerShell(gcloud run services update-traffic:*), PowerShell(gcloud run services replace:*), PowerShell(gcloud run services delete:*), PowerShell(gcloud secrets create:*), PowerShell(gcloud secrets delete:*), PowerShell(gcloud secrets versions add:*), PowerShell(gcloud secrets versions access:*), PowerShell(gcloud secrets versions destroy:*), PowerShell(gcloud secrets versions disable:*), PowerShell(docker push:*), PowerShell(gh workflow run:*), PowerShell(Remove-Item *-r*)
<!-- delegation:end -->
