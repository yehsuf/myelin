/**
 * Shell-argument quoting helpers shared by every generator that splices a
 * managed (MYELIN_DIR-derived, therefore arbitrary user-supplied) path into a
 * shell command or profile snippet. Centralized so the security-critical
 * escaping can never drift between the shell-profile writer (install.mjs) and
 * the RTK Copilot hook (tools/rtk.mjs).
 *
 * Node stdlib only — safe to import from the shared leaf layer.
 */

/**
 * Wrap a value in POSIX single quotes so an arbitrary path (spaces, `$`,
 * `$(...)`, backticks, `$VAR`, globbing chars, …) survives verbatim and is
 * NEVER executed or expanded when the string is sourced/run by a POSIX shell.
 * An embedded single quote is closed, escaped, and reopened (`'\''`).
 * @param {unknown} value
 */
export function posixSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a value in PowerShell single quotes (verbatim string — no `$`, `$(...)`,
 * or backtick expansion). An embedded single quote is doubled (`''`), per
 * PowerShell literal-string rules. Used for managed paths spliced into $PROFILE.
 * @param {unknown} value
 */
export function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `''`)}'`;
}
