# CoCheck harness kit

This folder is everything you need to add an AI agent harness (a coding agent, a desktop agent, a command-line assistant) to CoCheck. You do not write code: you write one JSON manifest, record a real session, and write cases that say what CoCheck must make of it.

- `GUIDE.md` - start here: one page from nothing to a harness that passes `cocheck harness test`, then trying it from your home folder and shipping it by pull request.
- `spec/v1.md` - the specification (v1): the event CoCheck reads, the levels a harness can join at (L0 to L3), every manifest field, what CoCheck loses when a field is missing, the rules for a harness in your own folder, and the case format.
- `cases/` - the conformance cases of the harnesses that ship with CoCheck (`claude`, `codex`, `copilot`), built from real recordings and trimmed to what each case needs. `cocheck harness test --cases public-kit/harness/cases/claude` runs one set. Read a case to see what a finished one looks like.
- `harnesses/` - manifests for harnesses that are not built in, each with its real recording and its cases: `antigravity` (Antigravity CLI), `cursor` (Cursor). Run one with `cocheck harness test --cases public-kit/harness/harnesses/antigravity/cases --manifest public-kit/harness/harnesses/antigravity`.
- `examples/toyagent/` - a made-up harness whose payloads look like none of the built-in ones: its manifest, its recording and its case. A worked example of an outsider harness; run it with `cocheck harness test --cases public-kit/harness/examples/toyagent/cases --manifest public-kit/harness/examples/toyagent`.
- `scaffold/` - the starter that `cocheck harness create` copies: a manifest to fill in, a README and an empty `recordings/` folder.
