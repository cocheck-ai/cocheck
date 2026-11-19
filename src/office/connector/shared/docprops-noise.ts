/**
 * The per-save docProps fields every Office save rewrites (shared by the Excel reader and the Word diff). The lists are the
 * allow-list: a changed title, author (dc:creator), subject, keywords, Company or Manager is not in them and stays visible.
 */
export const CORE_NOISE_FIELDS = ["dcterms:modified", "cp:lastModifiedBy", "cp:revision"] as const;
export const APP_NOISE_FIELDS = ["Application", "AppVersion", "TotalTime", "TitlesOfParts", "HeadingPairs"] as const;

const fieldRegex = (fields: readonly string[]): RegExp => new RegExp(`<(${fields.join("|")})\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/\\1\\s*>)`, "g");
const CORE_NOISE = fieldRegex(CORE_NOISE_FIELDS);
export const APP_NOISE = fieldRegex(APP_NOISE_FIELDS);

/** core.xml text with the noise fields emptied (`<f/>`), so only their presence is compared. */
export const quietCore = (text: string): string => text.replace(CORE_NOISE, "<$1/>");
/** app.xml text with the noise fields emptied. */
export const quietApp = (text: string): string => text.replace(APP_NOISE, "<$1/>");
