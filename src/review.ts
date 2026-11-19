import { userInfo } from "node:os";

/**
 * The reviewer's default name (review server). Core does not format cell values: that belongs to the spreadsheet reader.
 */

/** The reviewer name when none is given: the OS user name. */
export function defaultReviewer(): string {
  return userInfo().username;
}
