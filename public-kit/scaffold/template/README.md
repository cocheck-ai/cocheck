# My connector

A starter connector. It reads two state files and answers `hello` and `diff` over line-JSON on standard output.

Two places are yours to replace in `connector.mjs`, each marked `REPLACE`: how a state file is read, and how a difference becomes a change. Also edit `cocheck-connector.json`: the `matches` entry says which files this connector handles.

Check your work with:

```
cocheck connector test .
```

The spec is in `../spec/README.md` when this folder sits inside the kit.
