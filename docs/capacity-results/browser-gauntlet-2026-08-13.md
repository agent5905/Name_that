# Production browser gauntlet — 2026-08-13

- Origin: `https://name-that-team-member.pages.dev`
- Deployed runtime commit: `1b3af4d795b21fc08e3c1d56e90aae8a3d6ee0b3`
- Cloudflare deployment: `1f41ea72-6045-4e46-871d-9b482de63d84`
- Browser: installed Google Chrome through Playwright, one serial worker
- Result: **PASS — 11/11 journeys in 2.4 minutes**

The first attempt reached the production source limiter at its first media upload and received `429` with `Retry-After: 1395`. It created no room. Its isolated game/admin teardown completed, and an independent read-only SQL audit found zero games, rooms, and media for that fixture. The limiter was not reset or bypassed. One retry ran only after the full server-provided window expired.

Passing coverage:

1. create, preview, save, reload, host, join, display, and complete a varying-choice two-image/Fun Fact game;
2. Play Again with a fresh code and clean participant/answer state;
3. per-session encrypted reveal isolation across Play Again;
4. a third independent completed session from the same saved game;
5. add/remove/reorder/edit/replace persistence and immutable session snapshotting;
6. late joins and refresh recovery in lobby, question, locked, reveal, and results states with no reveal dialog;
7. staged Mystery/encrypted-Reveal preload and render performance;
8. same-tab lobby→lobby, active→lobby, and finished→active room switching;
9. participant navigation containment and participant-token rejection by owner APIs;
10. stable editor layout at desktop/laptop dimensions and 100%/125% zoom; and
11. distinct completed-room history for one saved game.

Measured image timings against the 500 ms target:

| Observation | Time |
| --- | ---: |
| Display reveal click→paint | 165 ms |
| Mobile participant reveal click→paint | 149 ms |
| Round-two Mystery transition→paint | 140 ms |

The suite's fail-closed teardown completed without error. A separate Supabase Management SQL audit immediately afterward returned `games=0` and `empty_admins=0` for the isolated test window.

The run command was:

```powershell
$env:ACCEPTANCE_REAL='1'
$env:ACCEPTANCE_ORIGIN='https://name-that-team-member.pages.dev'
$env:ACCEPTANCE_EXPECTED_HOSTNAME='name-that-team-member.pages.dev'
node --env-file=.env node_modules/@playwright/test/cli.js test e2e/acceptance.real.spec.ts --workers=1
```
