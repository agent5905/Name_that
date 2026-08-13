# Testing strategy

## Backend gates

`functions/_lib/api.test.ts` exercises request validation, typed error redaction, room-code generation, distinct 256-bit credentials, hashing, and snapshot field allowlisting.

After migration and content upload, `npm run test:integration` verifies private-table/snapshot/RPC denial for `anon`, legacy-anon-JWT private room reception and denied direct client send, reveal-media list/download denial, CSPRNG sequence/choice invariants, atomic five-attempt creation limiting with a persisted sixth rejection, a simultaneous 225th-vs-226th join race, scoped expiry with active-room preservation, absence of plaintext credentials, wrong-host and cross-player rejection, legal/illegal transitions, idempotent replay, immutable changed answers, answer-after-lock rejection, leakage boundaries, protected media release, and result totals. It additionally proves joins and answers emit no same-phase audience event, a phase transition emits exactly one sanitized snapshot push, and a disconnected listener can reconcile authoritative state then receive exactly one subsequent transition after reconnect. Supply `SUPABASE_REALTIME_ANON_KEY` or management credentials that can read the project's legacy `anon` key. Supabase Anonymous Sign-Ins are not required. The test deletes only its uniquely coded rooms and limiter key in `finally`.

`npm run verify` is the complete local gate: lint, typecheck, Vitest, production build, Pages Functions compilation, bundle/source-map scan, and Playwright participant/host/display journeys. Browser tests include narrow phones, 1280×720 and 1920×1080 presentation viewports, QR decoding, protected portrait delivery, and host-session recovery after HTTP 500 and network failures; a 401 test proves definitive authorization rejection clears the session.

The repeatable-game regression suite also covers the saved-game poster library, variable answer counts, image-backed editor preview, the draft → normalized PNG upload → revision-checked update sequence, server-only pre-reveal silhouette URLs, eligible-player answer denominators for late joins, immediate reveal without a dialog, and Play Again idempotency. A failed session-creation retry must reuse the exact 43-character host token and UUID idempotency key. Bright/dark portrait and landscape fixtures guard the adaptive local silhouette preview against disappearing or becoming a solid block.

Visual screenshots are captured for the game library, editor, host controls, phone join/question/submitted/locked/reveal states, and lobby/question/locked/reveal/results/complete display states. The visual gate rejects generic dashboard/polling treatments: the shared display must retain the Studio Mystery File chamber, broadcast hierarchy, phase-specific color/motion, and silhouette-to-reveal continuity at both presentation resolutions.

## Pages HTTP and browser smoke

After copying `.dev.vars.example` to `.dev.vars`, build and start `npx wrangler pages dev dist --port 8788`. In another shell, run `npm run test:smoke`. It refuses non-local target hosts and exercises health, create/join/snapshot, participant and host authorization, idempotent answer, lock, media secrecy, reveal, protected WebP delivery, and results through actual Functions. It uses the server credential only to delete its exact snapshot and room in `finally`.

For a deployed-origin smoke, set `SMOKE_BASE_URL` to the exact HTTPS origin, set `SMOKE_ALLOW_REMOTE=true`, and set `SMOKE_EXPECTED_HOST` to that URL's exact hostname. The double opt-in prevents an accidental run against an arbitrary destination; cleanup remains limited to the room created by that run.

The capacity release gate requires the updated integration/security suite to pass on the deployed schema, including two private listeners authorized with the legacy `anon` JWT, forged-event non-delivery, zero same-phase fan-out, exactly-once phase delivery, reconnect reconciliation, and the 225-player boundary race. Local Wrangler and the exact deployed Pages origin must then pass the HTTP smoke. `npm run test:smoke:browser` covers one real host/participant/display flow; the separate staged protocol harness covers 5, 10, 25, 50, 100, 175, and 225 clients. Neither substitutes for the final small real-browser gauntlet and dashboard review.

Capacity stages must run in order with the explicit remote-target/client-count acknowledgements described in `docs/CAPACITY_HARNESS.md`. Preserve each JSON report, stop on unexplained errors or rising latency, and do not repeat the 175/225 stages after changes unrelated to capacity-critical code. A passing protocol run does not exercise browser image decode, compositor behavior, CDN geography, or presentation layout.

Mocks can isolate unit tests, but do not count as proof of deployed realtime or authorization behavior.
