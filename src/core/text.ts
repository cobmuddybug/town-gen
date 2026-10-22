// Small text helpers shared by every module.

/** "John's", "James'": the possessive of a name. */
export function poss(name: string): string {
  return /s$/.test(name) ? `${name}'` : `${name}'s`;
}

/** Tidy a filled template: "Roberts's" to "Roberts'", doubled spaces and stray commas. */
export function tidy(s: string): string {
  return s.replace(/\b([A-Z][\w-]*s)'s\b/g, "$1'").replace(/ {2,}/g, " ").replace(/ ,/g, ",").replace(/,,/g, ",");
}
