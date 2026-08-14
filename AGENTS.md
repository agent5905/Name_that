# Project agent instructions

## Scope

Continue this repository and its existing production system. Do not restart completed work, replace the approved React/Cloudflare Pages/Supabase stack, or reopen a passed Gauntlet without evidence that its result expired.

## Approved release destinations

- GitHub repository: `https://github.com/agent5905/Name_that.git`
- Cloudflare Pages project: `name-that-team-member`
- Supabase: the existing project configured by this repository's local environment

The project owner grants standing authorization for normal project release operations at these destinations. Within the active tool and safety policy, agents may fetch, pull, branch, commit, push project code and QA evidence, create or update pull requests, inspect and repair CI, merge qualifying PRs to `main`, synchronize branches, deploy this project to its existing Pages project, apply version-controlled project migrations, run project-scoped verification, create isolated test fixtures, and remove those exact fixtures.

Do not request renewed human approval solely because a routine project push, PR, merge, deployment, migration, smoke test, or isolated-fixture cleanup targets one of the approved destinations above. Tooling may still require an approval prompt; describe the action accurately and use the narrowest relevant command scope.

## Hard boundaries

- Never commit or push `.env` files, credentials, tokens, passwords, database passwords, service-role keys, privileged JWTs, or other secrets.
- Inspect QA/capacity artifacts for secrets and unnecessary personal information before committing them.
- Do not change billing, purchase services, alter spend limits, delete the Supabase project, modify unrelated Cloudflare resources/domains/DNS, touch unrelated Supabase projects, or destroy unrelated production data.
- Escalate when credentials genuinely fail, the destination differs from the approved destinations, paid/billing changes are needed, significant production data could be destroyed, unrelated infrastructure would be affected, a security concern makes the action unsafe, or a genuine product decision requires human judgment.
- Preserve unrelated user changes in a dirty worktree and use explicit, bounded cleanup targets.

## Release completion

Unless the owner explicitly limits the task, a successful engineering Gauntlet continues through:

1. implement;
2. test;
3. obtain independent critique when the task calls for it;
4. fix and re-test until the relevant gates pass;
5. commit and push a project branch;
6. create or update a PR when appropriate;
7. wait for CI and fix failures;
8. merge a qualifying PR to `main`;
9. deploy the merged `main` commit to the existing Cloudflare Pages project;
10. run proportionate production smoke verification;
11. verify exact test-fixture cleanup;
12. verify local `main`, `origin/main`, CI, and production state;
13. report the released commit, PR, deployment, checks, cleanup, and any real caveats.

Do not stop merely after coding, local tests, a commit, push, PR creation, merge, or deployment when the next normal release step remains authorized and safe.

## Evidence and expensive tests

- Project-generated capacity reports, browser-gauntlet reports, screenshots, benchmarks, and release checkpoints may be committed to the approved GitHub repository when useful for reproducibility.
- Preserve historical failure and baseline evidence when current documentation relies on it; label superseded evidence clearly rather than rewriting history.
- Do not rerun the 175/225 production capacity ladder unless capacity-critical behavior changed, required evidence is missing or invalid, or the owner explicitly asks. Prefer the smallest verification proportional to the change.
- All production tests must be fail-closed and clean up only their uniquely identified rooms, games, profiles, limiter keys, and storage objects.

## Current release reference

The scoring/leaderboard release was merged in PR #2 and deployed from merge commit `4705a94a924d8ece623a7fa5e6bd3ffefd65aa31`. Treat `docs/PROJECT_STATUS.md`, `docs/CAPACITY.md`, and the current GitHub/Cloudflare/Supabase state as the authority for newer releases.
