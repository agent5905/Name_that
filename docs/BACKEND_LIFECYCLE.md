# Saved-game and repeatable-session backend

Migration `202608110003` is additive. It preserves the original employee-backed room tables and backfills their immutable question equivalents while introducing owner-scoped saved definitions and independent live-session snapshots.

## Credentials

- Admin, host, and participant credentials are distinct random 256-bit opaque tokens.
- Only SHA-256 token hashes are stored.
- Every saved-game and editor-media RPC resolves ownership from the admin token on the server. A game ID alone grants nothing.
- Admin-profile creation shares the existing atomic, source-hashed five-per-fifteen-minute abuse gate.

## Definitions and sessions

Drafts may contain zero questions or questions without images. A session is hostable only with at least one question, 2–10 contiguous choices per question, exactly one correct choice, and one real plus concealed image asset per question. Duplicate game names are allowed.

Creating a session copies question text, reveal name, choice text/correctness, and both private media paths. Later edits and soft deletion of the saved game cannot mutate or break a live/finished session. `Play Again` copies the prior immutable session snapshot into a completely fresh lobby with no players or answers.

Session and play-again POSTs accept a browser-generated `hostToken` and UUID `idempotencyKey`. Retrying the exact operation returns the one room with the same usable credential; reusing the key with a different credential is a conflict.

## Media

Migration `202608110010` replaces automatic mystery generation for new content with an atomic, explicit pair: the host supplies separate `mystery` and `reveal` files. Both are independently normalized, bounded, fully decoded, and canonicalized as PNG; neither is derived from the other. New questions use matching `mysteryMediaAssetId` and `revealMediaAssetId` values for the pair and may include a plain-text optional Fun Fact up to 500 characters. The pair and Fun Fact are copied into immutable session snapshots. Old sessions retain their legacy paths and remain playable.

Each new pair reserves two private source objects: the Mystery Image and phase-gated Reveal Image. Every session question receives a fresh AES-256-GCM key, IV, and authenticated context, including during Play Again. The first reveal-preload request reads the private source, encrypts it with that session-specific material, and stores only ciphertext in Cloudflare's Cache API under a canonical URL containing the immutable session-question UUID. Current/next mystery bytes and inert reveal ciphertext are then shared across participant and display clients. Only Reveal/Results/Complete may obtain the correct choice-scoped key. A key learned in one room cannot decrypt another room's ciphertext. The plaintext reveal route remains a phase-gated fallback.

Quota accounting charges both stored images together. Cleanup, inventory reconciliation, and immutable-session reference checks include both source objects; an interrupted route removes every successfully uploaded object and leaves its pending reservation eligible for retryable GC. Derived ciphertext expires from Cloudflare's bounded cache rather than consuming Storage quota.

The browser accepts JPEG, PNG, or WebP and canvas-normalizes each selected image to a bounded RGBA PNG. The Pages Function caps the actual multipart stream before parsing, verifies every PNG chunk CRC, bounded-decompresses and unfilters both complete images, and canonicalizes them. Paths are generated UUID paths beneath the authenticated owner, never client filenames. Objects live in the private `reveal-media` bucket. Editor previews are owner-authenticated; room media access follows the explicit mystery/preload/reveal rules above.

Every upload is reserved in the database before any Storage write, then marked ready only after both objects exist. Pending interruptions stay quota-accounted and become retryable GC candidates after one hour. Deleted definitions release editor references immediately, while immutable session paths continue to protect media in active or retained rooms. Owner-serialized GC removes every tracked object first and only then finalizes the row; failures remain claimed for retry. The same cleanup pass reconciles old untracked objects under that authenticated owner's prefix after a two-hour safety window.

Media admission is layered: 100 uploads/hour per studio, 30/hour and 250 MiB/day per Cloudflare source hash across rotating studio identities, 200 MiB/500 assets per studio, and an advisory-lock-serialized 512 MiB/day project budget independent of source. The project budget is charged inside the successful database reservation transaction, so a rejected owner/project quota check or failed insert cannot poison shared capacity. Public storage admission stops at 4 GiB/8,000 assets (including a conservative derivative allowance), reserving at least 1 GiB/2,000 objects of operational headroom below the physical ceiling. Admin-profile issuance uses its own 5-per-15-minute source table, separate from legacy room creation.

Saved-game mutations are transactionally limited to 200/day per studio, 100/day per Cloudflare source across rotating studios, and 1,000/day project-wide. Failed validation, stale revisions, and failed inserts roll back all shared budget charges. Definitions are further capped at 50 active and 200 retained rows per studio and 8,000 retained rows project-wide under advisory locks, leaving several days of headroom beyond the daily budget. Opportunistic cleanup removes expired counters, hard-deletes soft-deleted games older than one day only when no room retains their provenance, then removes 30-day-unused studios that own no games or media. Session content remains safe because it is copied into immutable session tables.

Resource growth is bounded by source-hashed session admission (20 per 15 minutes), per-owner limits of 50 active saved games, 500 private media assets / 200 MiB, 10 active sessions, and 50 sessions retained in a rolling 24-hour window. Saved-session and replay paths also invoke the existing bounded room and anonymous-Realtime cleanup.

Deleting a saved game is a soft delete. Assets are deliberately retained because immutable active or historical sessions may still reference them. Room expiry remains responsible for session-row cleanup; private retained objects are not made public or enumerable.

## Late join

`join_room` takes the room-row lock before inspecting phase. Lobby and open-question joins are eligible for the current round. Locked, reveal, and results joins are eligible from the next round and are excluded from the current answer denominator. Complete rooms produce the distinct `GAME_ENDED` marker, mapped to HTTP 410.

## Live phase delivery

Private, receive-only Realtime Broadcast carries a deeply sanitized authoritative snapshot only on phase or round transitions. Same-phase joins and answers remain compact invalidations; polling, reconnect, visibility, and HTTP recovery stay active when a push is missed or malformed.

Latency-sensitive host cues call `host_action_direct` through Supabase REST. The wrapper accepts the original 43-character host capability, rejects NULL or malformed inputs, derives its verifier inside a locked-down `SECURITY DEFINER`, preauthenticates without taking the room lock, and delegates to the same row-locked `host_action` state machine. Saved-game, admin, and media mutations remain Pages/service-role only. The client never transmits the persistent database verifier and does not retry an ambiguous direct action automatically.
