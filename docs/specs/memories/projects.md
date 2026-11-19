---
domain: memories
status: draft
issues:
  - https://github.com/aglowinthefield/impression/issues/95
surfaces:
  - api
  - web
---

## Goal

A project is a place memories live, and the dashboard lists projects so a person can narrow to one repo. Today every session upload creates a project for the folder it ran in, so `/`, `/tmp`, `~/.pi` and path-keyed copies of real repos pile up as empty entries: 21 of 34 in prod on 2026-11-19. A project should exist only once a memory lands in it, and the list should show only projects that hold memories.

## Non-goals

- No change to how a session's folder becomes a project key (git remote first, then the folder path). A path-keyed copy of a repo with a remote is a separate bug in key resolution.
- No change to which sessions are uploaded. Sessions outside a repo still upload, since their practices still matter.
- No merging of projects that already hold memories under two keys.
- No cleanup of projects that hold memories but have gone quiet.

## Acceptance criteria

- AC1: The dashboard's repo filter, and the project list it reads, show only projects holding at least one memory. A project whose only data is uploaded sessions isn't listed.
- AC2: Uploading a session for a project key that has no project creates no project. The session is still stored, a duplicate upload within a day is still handed back as a duplicate, and the session is still extracted.
- AC3: The first memory that lands in a project creates that project, with the key and name a session upload would have given it. This holds for extraction, for a memory added by an agent or the CLI, and for a practice moved back into a project.
- AC4: A session whose extraction lands no project memory, only practices or nothing, leaves no project behind. Practices extracted from it keep working as before.
- AC5: A person uploading a session for a GitHub repo they can't reach is still refused with not found, and nothing is stored.
- AC6: A person's sessions, listed for one project key, include the sessions uploaded before that project existed.
- AC7: After the release, no project in prod holds only sessions. The sessions of the three that did (`/`, `somewhere.garden` and one temp folder on 2026-11-19) are kept and still listed under their project key.
- AC8: Uploading eval turns for a project key with no project does not create the project until a memory lands
- AC9 (after deploy): seven days after the release, prod has no project created after the release that holds no memory.

## Setup note

AC1 to AC8 run against the test database in API tests, plus a local dev server for AC1 by eye. AC7 needs the migration run against a prod fork before release. AC9 is one query against prod seven days after the deploy: projects whose `created_at` is after the release and that no memory references.

## Surfaces touched

- API
- Web dashboard (AC1 only)

## Cost and scale

No model calls. One migration over `sessions` (a few hundred rows in prod). The project list query adds one indexed existence check per project.
