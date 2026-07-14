# Enterpret Broker Integration

This document describes the Enterpret-specific integration layered onto the
upstream Google Calendar MCP server. It records the runtime contract, security
boundaries, implementation changes, validation, and release requirements for
the independently versioned `@enterpret/google-calendar-mcp` package.

## Purpose and scope

Enterpret Agent uses Nango to authorize Google, refresh access, and retrieve a
fresh short-lived bearer. Wisdom injects that bearer into a newly started MCP
subprocess for each discovery or execution request.

The subprocess has deliberately narrow responsibilities:

- consume one Google OAuth access token from its environment;
- retain the token only in process memory;
- attach it to Google Calendar API requests through `OAuth2Client`;
- expose the approved Calendar tool surface over stdio; and
- exit without refreshing or persisting credentials.

The package does not contain a Nango SDK, accept tokens as MCP tool arguments,
handle refresh tokens, or create a second customer-facing OAuth connection.
The inherited interactive OAuth and multi-account mode remains available when
the broker environment variable is absent.

## Runtime contract

Broker mode is selected by the presence of
`GOOGLE_CALENDAR_OAUTH_BEARER`.

```bash
GOOGLE_CALENDAR_OAUTH_BEARER=<short-lived-access-token> \
  npx --yes @enterpret/google-calendar-mcp@0.1.0
```

The production invocation should pin an immutable package version. The token
must be supplied through the subprocess environment rather than command-line
arguments or MCP request data.

Mode selection fails closed:

- variable absent: use the inherited interactive OAuth flow;
- variable present and non-blank: use broker mode; and
- variable present but empty or whitespace-only: fail startup rather than
  falling back to interactive OAuth.

Broker mode supports stdio only. HTTP transport is rejected because its
long-lived account-management and callback behavior does not match Wisdom's
ephemeral subprocess model.

Before registering tools, the server performs a bounded Google
`calendarList.list` probe. This confirms that the supplied bearer can reach the
Calendar API. The probe has a ten-second provider-client deadline and returns
only a normalized failure plus an optional HTTP status.

## Tool surface

Broker mode exposes exactly these ten tools:

- `list-calendars`
- `list-events`
- `search-events`
- `get-event`
- `create-event`
- `update-event`
- `delete-event`
- `get-freebusy`
- `get-current-time`
- `respond-to-event`

It does not expose `manage-accounts`, `list-colors`, or bulk `create-events`.
Write tools remain subject to the caller's approval policy; their presence in
MCP discovery is not approval to execute them.

## Authentication and persistence boundary

Broker mode creates one `OAuth2Client` for the process-local `default`
account. Broker-created clients are marked in memory so shared provider-client
code can avoid inherited credential-file behavior.

While broker mode is active, the server does not:

- load Desktop OAuth client credentials;
- initialize `TokenManager`;
- read or write token files;
- start a browser or callback server;
- refresh the access token;
- register account-management tools; or
- attach the token to logs, MCP arguments, or persisted configuration.

Interactive mode retains its existing browser authorization, refresh-token
storage, multi-account behavior, HTTP support, and detailed diagnostics.

## Error and data handling

Provider failures in broker mode are normalized at tool boundaries. Responses
may include a useful error category and a numeric HTTP status, but must not
include raw Google response bodies, provider messages, event or calendar data,
credential objects, authorization headers, access tokens, or internal error
text.

The normalization distinguishes common cases such as invalid input, missing
resources, denied access, rate limiting, and general provider failures. Calendar
name-resolution errors direct callers to `list-calendars` without enumerating
calendar names or identifiers.

Interactive mode preserves the inherited provider diagnostics because those
messages remain useful for local OAuth troubleshooting.

## Calendar correctness changes

Two focused correctness fixes accompany broker mode:

1. RFC3339 inputs accept optional fractional seconds. A timestamp returned by
   `get-current-time` can therefore be passed directly to tools that accept
   date-time arguments without truncation or schema rejection.
2. `update-event` forwards its declared `sendUpdates` value through ordinary
   patches, single-instance recurring patches, and both patch and insert calls
   used for `thisAndFollowing`. The schema default remains `all`, with
   `externalOnly` and `none` forwarded unchanged.

These changes are not new Calendar capabilities; they make existing declared
contracts behave consistently.

## Package and runtime contract

The fork is published independently from upstream:

- package: `@enterpret/google-calendar-mcp`
- initial version: `0.1.0`
- command: `google-calendar-mcp`
- supported runtime: Node.js 22 or newer
- build target and Docker base: Node.js 22
- package contents: bundled runtime under `build/`, `README.md`, and `LICENSE`

CI installs with Node.js 22, audits dependencies, checks declared imports,
type-checks, builds, performs package and version smokes, and runs unit tests
with coverage. The publication workflow repeats the release-critical checks
before publishing with npm provenance.

Release Please tracks the Enterpret package from `0.1.0`. Because the package
is initially unpublished, the first public npm publication is a bootstrap
operation. After the package exists, npm Trusted Publishing must be configured
for this repository and its release workflow before relying on GitHub Actions
OIDC for later releases.

## Validation evidence

The reviewed source tree passed the following credential-free checks on Node
22:

- declared-import validation;
- TypeScript type-checking;
- all unit tests;
- production build;
- built `--version` smoke;
- `npm pack --dry-run`;
- high-severity dependency audit; and
- `git diff --check`.

The unit suite covers bearer presence, absence, and blank values; broker
precedence; unchanged interactive OAuth selection; in-memory credential
attachment; startup deadline and error redaction; exact tool discovery;
credential-file avoidance; provider and calendar-resolution sanitization;
fractional timestamp chaining; and `sendUpdates` forwarding.

An authorized read-only local package smoke also started separate npx
subprocesses for initialization/tool discovery, calendar listing, and event
listing. It confirmed the ten-tool surface, successful harmless reads, no
bearer or provider-sentinel leakage in captured output, no credential artifacts,
and cleanup of the temporary tarball, npm cache, and harness. No Calendar write
was performed.

## Deployment and release checklist

Before source release:

1. Review the complete diff and commit only product, test, release, and
   documentation changes.
2. Run import checking, type-checking, unit tests, build, built-version smoke,
   package dry-run, audit, and whitespace validation.
3. Inspect the packed file list and confirm the package name, version, command,
   and Node.js engine.
4. Confirm that no credential, token, provider payload, temporary harness, or
   review-only asset is included.

External steps after the source change is reviewed and merged:

1. Perform the separately authorized first publication of
   `@enterpret/google-calendar-mcp@0.1.0`.
2. Configure and verify npm Trusted Publishing for subsequent releases.
3. Pin Wisdom to the immutable published package version.
4. Reconnect or refresh the staging Nango Google account as needed.
5. Verify health, initialization, exact tool discovery, `list-calendars`, and a
   bounded `list-events` read through the deployed Wisdom path.
6. Exercise create, update, response, or delete operations only with explicit
   approval and a defined cleanup plan.

The local tarball smoke verifies the package and subprocess boundary. It does
not replace post-publication resolution through npm or the final Nango-to-Wisdom
staging test.

## Change map

The implementation is intentionally split into reviewable concerns:

- broker authentication and server-mode selection;
- credential isolation and broker-only error sanitization;
- fractional RFC3339 timestamp compatibility;
- update notification forwarding;
- package, Node.js, CI, Docker, and release preparation; and
- user, operator, and developer documentation.

Tests live with the concern they validate. Generated dependency-lock changes
belong with package and release preparation rather than being treated as a
separate behavioral change.
