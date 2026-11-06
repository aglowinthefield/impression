# GitHub sign-in and per-repo access

Status: plan, not started.

## Goal

People sign in with GitHub and see only the projects for repos they can access. This works the same for a solo user with personal repos and for org members. An allowlist decides who may use the server.

## Decisions

- **GitHub App, not an OAuth App.** An OAuth App needs the `repo` scope to see private repos, and that scope grants write access to code. A GitHub App asks for read-only Metadata and can be installed on a personal account or an org.
- **The allowlist gates installations.** `GITHUB_ALLOWED_ACCOUNTS` holds a comma-separated list of GitHub logins, users or orgs. An installation counts only if its account is on the list. A user may sign in if at least one counting installation gives them access to a repo.
- **Keep the `imp_` token model.** Sign-in mints an `imp_` token tied to the GitHub user and revokes that user's previous web token. The SPA receives it through `/#token=...` and stores it like a pasted token. `requireAuth` keeps working for the CLI, hooks and MCP.
- **Memories are private by default.** A `project` memory is visible only to its author, even when others can access the repo. A `team` memory is visible to everyone who can access that repo. Promoting a memory from `project` to `team` is an explicit action, and nothing is promoted automatically.
- **The project key is the repo.** Project keys are already `github.com/owner/repo` (`packages/shared/src/project.ts`), so the access check compares the key against the user's repo list.

## Sign-in flow

1. `GET /auth/github` redirects to GitHub with a `state` cookie.
2. `GET /auth/github/callback` exchanges the code for a user token, then calls `GET /user` and `GET /user/installations`.
3. If the allowlist leaves no installations, the callback shows a page linking to the app's install URL, or refuses with "not on the allowlist".
4. Otherwise the callback upserts the user, mints a token and redirects to `/#token=...`.

## Stages

### Stage 1: sign-in

- Add a `users` table with `githubId`, `login`, an encrypted refresh token and `createdAt`.
- Add `userId` to `api_tokens`. Tokens from `token:create` stay valid. They map to a user, or to an admin principal, until stage 2 lands.
- Add "Sign in with GitHub" to the login page and keep the token form.
- Add `impression login --github` with GitHub's device flow, so CLI tokens belong to a GitHub user and no one pastes a token. Required for stage 1, because the hooks and MCP server run on CLI tokens.

### Stage 2: per-repo filtering

- On each request, resolve the token's user to a set of accessible repo keys. Cache the set for 10 minutes per user so the prompt hook stays fast.
- Filter every project-scoped route by that set, then by author for `project` and `user` memories (`team` memories pass on repo access alone): projects, memories, search, core, proposals, sessions and evals. `packages/api/src/projects.ts` currently returns every project.
- Return 404, not 403, for a project outside the set, so a probe can't confirm that a repo exists.
- Refresh the set on a cache miss with the stored refresh token. If GitHub is down, use the last known set.

## Open questions

- **`path:` projects.** These have no repo. Proposal: add `createdBy` to `projects` and show a `path:` project only to its creator.
- **User-scoped memories.** `memories.owner` is a fixed value today. It becomes the user id, and existing rows need a backfill to the operator's user.
- **Promotion.** Decide who can promote a memory to `team` (its author only, or any repo member) and whether a `team` memory can be demoted. Existing `project` memories have no clear author split, so decide whether to backfill them as the operator's private memories.
- **Public repos without an installation.** A user token can probably read public repos where the app isn't installed. I haven't verified this against GitHub's docs. Until it's checked, only installed repos count.
- **Revocation lag.** Someone removed from a repo keeps access for up to the 10-minute cache window.
- **Existing principals.** Current tokens use free-text names (for example `me`). Eval turns and request logs keyed by those names need mapping to the new user ids.
