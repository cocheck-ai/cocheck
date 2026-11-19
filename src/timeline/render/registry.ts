import { createRegistry } from "../../connector/registry.ts";
import type { ChangeInfo, FormatRenderer } from "./types.ts";

/** Thin calls into the connector registry with no installed connectors and no plugins: the built-in table is the whole answer. */
const registry = createRegistry();

export const registeredExtensions = (): string[] => registry.registeredExtensions();

/** By extension first. A file with no entry whose change the text tier read (decided by content, not by name) gets the text renderer. */
/** `home` lets the claims of installed connectors count; without it only the built-ins' claims do. */
export const rendererFor = (file: string, generic?: ChangeInfo["generic"], home?: string): FormatRenderer => (home === undefined ? registry : createRegistry({ home })).rendererFor(file, generic);
