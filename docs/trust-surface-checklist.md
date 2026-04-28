# Trust surface checklist

TJT-12 prepares the open-source core package trust and discovery surface from code/docs only. Platform/admin metadata changes are intentionally left for a human owner.

## README review gate

- [x] README badges/flairs communicate package status, CI tests, MIT license, and privacy/trust positioning.
- [x] README treats the browser tracker as a first-class audited artifact.
- [x] README links to readable tracker source in the repository (`src/tracker.src.js`).
- [x] README links to the generated readable package module (`src/tracker-source.js`).
- [x] README links to the hosted readable endpoint (`https://api.agentanalytics.sh/tracker.src.js`).
- [x] README links to the hosted minified runtime endpoint (`https://api.agentanalytics.sh/tracker.js`).
- [x] README explains the default privacy contract: no dynamic script loading, no eval/new Function, no document.write, no form value collection, no hard browser fingerprinting, sanitized URL/referrer, standard UTM-only query capture, scoped storage, local dev no-send behavior, and opt-in high-sensitivity listeners.
- [x] README mentions `aa.identify(userId, { email })` as explicit-only and explains that email is stripped from event rows/profile traits by default.
- [x] README references tracker unit tests and privacy guardrail coverage.
- [x] README documents `/tracker.src.js` alongside `/tracker.js` in utility endpoints.

## Automated gate

`test/readme-trust-surface.test.mjs` checks the README for the badges/flairs, source links, hosted endpoint links, privacy contract terms, and tracker test references listed above. It runs as part of `npm test`.

## HITL/admin metadata still required

Do not perform these from code or local tooling without explicit human/admin approval:

- [ ] Confirm or set the GitHub repository description to emphasize the open-source analytics core and auditable browser tracker.
- [ ] Confirm or set GitHub repository topics/tags for discovery, suggested: `analytics`, `privacy`, `tracker`, `events`, `growth`, `agent`, `agent-analytics`, `web-analytics`, `open-source`, `javascript`.
- [ ] Confirm repository social preview/sidebar metadata if the platform supports it.
- [ ] Confirm npm package metadata/keywords during the next package publish if maintainers want package-registry discovery to mirror the GitHub topics.
- [ ] Verify the hosted readable endpoint is live after the hosted API deploy that includes `/tracker.src.js`; local check during TJT-12 preparation saw `https://api.agentanalytics.sh/tracker.js` return `200 application/javascript` with a browser user agent, while `https://api.agentanalytics.sh/tracker.src.js` still returned `404 Not Found`.
