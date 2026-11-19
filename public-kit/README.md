# CoCheck connector kit

This folder is everything you need to build a CoCheck connector for a product of your own.

- `GUIDE.md` - start here: one page from nothing to a connector that passes `cocheck connector test`, including a product reached through MCP and installing it.
- `examples/` - four working connectors: `toy-level-1` (a change list for a file), `toy-level-3` (pictures and boxes), `toy-export` (print the item as text), `toy-vendor` (a product reached through an MCP tool, with a `subjects` template and `snapshot`).
- `toy-product/` - a tiny file-backed notes store with recorded before and after states, the pairs the examples are tested on.
- `spec/` - the connector specification (v1): `spec/v1.md` for the change document, `spec/README.md` for the manifest, the methods, installing and testing.
- `scaffold/` - a starter project. `cocheck connector create` writes a copy.
- `conformance/` - the conformance cases that `cocheck connector test <dir> --cases` runs; see `spec/README.md#testing`.
