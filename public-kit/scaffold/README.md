# scaffold

A starter project for a new connector. It is a Node connector with no dependencies. It reads two JSON state files and answers `hello` and `diff`, with a level 1 change list (`cocheck.changes/1`, see `../spec/v1.md`). It passes the kit's checks as it is, so you can change one piece at a time.

There are two routes.

Command route:

```
cocheck connector create my-connector --id my-connector
```

This copies `template/` into the new folder, writes your id into `cocheck-connector.json`, and prints the next two commands. The folder must not exist yet, or must be empty. The command refuses to write into a folder that already holds files. The id starts with a letter or digit and then uses only letters, digits, `.`, `_` and `-`.

Copy route: copy the `template/` folder anywhere you like, then set `id` in `cocheck-connector.json` yourself.

Then edit `connector.mjs` where it says `REPLACE` (the reading of a state file, and the mapping to changes), and run:

```
cocheck connector test <dir>
```

The spec is in [../spec/README.md](../spec/README.md). The toy product in `../toy-product/` shows how product states change.
