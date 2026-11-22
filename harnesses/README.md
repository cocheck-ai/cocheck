# Built-in harness manifests

Each folder here holds one `cocheck-harness.json` (schema `cocheck-harness/1`, see "Harness manifest (v1)" in docs/hooks.md) for a host CoCheck ships support for.
The folder name is the manifest's `key`. The build copies this folder to `dist/harnesses/`, so it ships in the npm package and the Homebrew install with the rest of `dist/`.
Adding a built-in harness is a data change here (manifest, plus its cases under `public-kit/harness/cases/<key>/`); nothing under `src/` changes unless the manifest opts into a first-party extra.
