# Jesse Agent product parity

This document is the release gate for the native macOS and web clients. A
feature is complete only when the service contract, macOS surface, web surface,
and automated coverage are all marked complete.

| ID | Capability | Service | Web | macOS | Automated coverage | Status |
| --- | --- | --- | --- | --- | --- | --- |
| NAV-01 | Project list, add, select, rename, remove | Complete | Complete | Complete | Partial | In progress |
| NAV-02 | Chat and project session history | Complete | Complete | Complete | Partial | In progress |
| NAV-03 | Rename, archive, and copy session title | Complete | Complete | Complete | Partial | In progress |
| RUN-01 | Persistent run start, observe, reconnect, stop | Complete | Complete | Complete | Complete | Complete |
| RUN-02 | Scoped approval and cancellation by run ID | Complete | Complete | Complete | Complete | Complete |
| CHAT-01 | Streamed text, status, and tool activity | Complete | Complete | Complete | Partial | In progress |
| CHAT-02 | Markdown, code, tables, links, and selection | Complete | Complete | Complete | Partial | In progress |
| CHAT-03 | Copy, edit, retry, and queued follow-up | Complete | Complete | Partial | Partial | In progress |
| INPUT-01 | Text composer and permission mode | Complete | Complete | Complete | Partial | In progress |
| INPUT-02 | Approval card and three approval choices | Complete | Complete | Complete | Partial | In progress |
| INPUT-03 | Image pick, paste, drop, validation, and preview | Complete | Complete | Complete | Complete | Complete |
| OUT-01 | Changed files, diffs, command output, and sources | Complete | Complete | Complete | Partial | In progress |
| WORK-01 | Scratch workspace and save as project | Complete | Complete | Complete | Complete | Complete |
| LOG-01 | Daily changelog list and detail | Complete | Complete | Complete | Partial | In progress |
| COMP-01 | Menu bar, global ring, and recent results | Complete | N/A | Complete | Complete | Complete |
| SYNC-01 | One session and run visible from every client | Complete | Complete | Complete | Complete | Complete |
| PACK-01 | App runs without repository, npm, or system Node | Complete | N/A | Complete | Complete | Complete |

## Release rules

1. New capabilities start with a service contract and contract fixture.
2. macOS defines the primary product interaction; web ships the corresponding
   capability in the same milestone.
3. A feature cannot move to Complete while either client or its automated
   coverage is missing.
4. Routines and scheduled tasks remain a backend prototype and are outside the
   first native-parity milestone.

## Latest verification (2026-08-13)

- 38 TypeScript service tests and 6 Web tests pass.
- 83 Swift tests pass, including the shared protocol fixture, scoped control
  request bodies, attachment limits, clipboard images, deep links, and login
  launch policy.
- The packaged app is ad-hoc signed, uses an embedded Node 22 arm64 runtime,
  does not link WebKit, and contains no source checkout absolute path.
- A copy of the app under `/tmp` served API v3, the browser client, and the Run
  API without using the repository or system Node/npm.
