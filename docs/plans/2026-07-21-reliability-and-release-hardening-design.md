# Userscript Reliability and Release Hardening Design

Date: 2026-07-21
Status: Approved

## Goal

Resolve the repository-wide review findings in one focused pull request while preserving each userscript's public behavior.
The work covers Wanted request reliability and URL targeting, Gemini Export-All completeness, dependency and GitHub Actions supply-chain hardening, and documentation alignment.

## Scope

### Wanted request scheduler

Queued and running requests will share one job-ID keyed pending structure.
Each entry retains every anchor for that job so duplicate cards reuse one request before and after a concurrency slot becomes available.

The details request will retry once after 500 ms.
If both attempts fail, the rejection will be consumed and logged, the pending entry will be removed, and its anchors will become eligible for a later DOM scan.
Failures will not be cached.

### Wanted URL targeting

The userscript metadata will include both `www.wanted.co.kr` and `wanted.co.kr` with `/wdlist*` patterns.
Because that wildcard also matches strings such as `/wdlisting`, runtime startup will require `pathname === "/wdlist" || pathname.startsWith("/wdlist/")` before installing observers or issuing requests.
Queries and fragments do not change this pathname decision.

The details API will use a relative `/api/chaos/jobs/v4/<jobId>/details` URL so execution remains same-origin on either accepted host.
Generated `dist/*.user.js` files remain untracked build artifacts and will not be edited directly.

### Wanted verification seam

Wanted will gain a Node VM harness over the built userscript, matching the exporter packages' existing convention.
The harness will cover:

- duplicate job IDs queued while all concurrency slots are occupied;
- one transient rejection followed by a successful retry without `unhandledRejection`;
- two failed attempts followed by eligibility for a later scan;
- both accepted hosts and `/wdlist`, `/wdlist/`, child-path, query, and fragment forms;
- rejection of unrelated paths such as `/wdlisting`;
- generated metadata entries for both hosts.

### Gemini Export-All completeness

Conversation enumeration will succeed only when the server cursor is exhausted.
An empty parsed page with a remaining cursor and exhaustion of the 200-page local safety cap will both raise a visible error instead of returning a partial list.
Existing parsing, pacing, deduplication, and export behavior remain unchanged.

### Supply-chain hardening

The transitive `brace-expansion` override will move to the first patched `1.1.x` release identified by the advisory and the pnpm lockfile will be regenerated with the repository-pinned pnpm version.
All GitHub Actions `uses:` references in check and release workflows will be pinned to reviewed full commit SHAs with version comments retained for maintainability.

### Documentation alignment

The Wanted installation instructions will stop using the repository-wide `releases/latest` asset URL.
The root README will list Gemini and both exporter test harnesses.
The Gemini Export-All reconnaissance blueprint will state that implementation shipped and document the deliberate pinned-RPC divergence.
The known Markdown lint violation and stale Claude UI wording will be corrected without changing runtime behavior.

## Alternatives Considered

### Enumerate every Wanted URL form in metadata

Host-specific exact, query, and child-path patterns would reduce broad metadata matching but duplicate policy across several entries and remain easy to drift.
The chosen two-pattern metadata plus exact runtime guard keeps the accepted path contract in one testable function.

### Keep the hard-coded `www` API origin

This preserves current code but makes apex-host execution cross-origin and dependent on unverified CORS and cookie behavior.
The relative API path is smaller and keeps credentials same-origin.

### Extract scheduler modules

Splitting the Wanted scheduler into imported modules would improve unit isolation but conflicts with the package's import-free source convention and is unnecessary for this repair.
The built-bundle VM harness provides the required behavioral coverage without a new abstraction.

## Commit and Pull Request Structure

The implementation will use one branch and one draft pull request with concern-level Conventional Commits:

1. Wanted reliability and its regression tests.
2. Wanted URL targeting and its URL/header tests.
3. Gemini pagination completeness and its regression tests.
4. Dependency and workflow supply-chain hardening.
5. Documentation alignment.

## Verification

The change is complete only when all of the following succeed on the final commit:

```bash
pnpm typecheck
pnpm build
pnpm -r test
trunk check --all
```

The Wanted tests must demonstrate the intended failures before implementation and pass afterward.
The final review must also inspect the generated Wanted metadata and execute the request retry and deduplication scenarios through the built bundle.
