// src/lib/office.js — ONE way to render an office as a line of text.
//
// Three copies of this existed, each with the same district-name-then-number
// fallback but a different separator and a different "no office" result:
//   • dashboard/shared.jsx  officeLine   → ' — ',  null  when no office
//   • dashboard/ActionDashboard.jsx officeText → ' · ', 'No office linked'
//   • profiler/ReportReader.jsx (inline) → ' — ',  ''    when no office
//
// The separator and the empty-case are the only real differences, so they are
// options rather than three functions. Every existing output string is
// preserved exactly; tests/tier3a.test.mjs asserts the three formats.

/**
 * The bits an office line is built from, blanks dropped:
 *   ['State Representative', 'Assembly District 1']
 * `district_name` wins over the numeric fallback, which is what all three
 * copies did.
 * @returns {string[]}
 */
export function officeParts(office) {
  if (!office) return []
  const district = office.district_name ||
    (office.district_number ? `District ${office.district_number}` : null)
  return [office.name, district].filter(Boolean)
}

/**
 * "State Representative — Assembly District 1".
 * @param {object|null} office
 * @param {{sep?: string, empty?: any}} opts
 *   sep   — joiner between office name and district (default ' — ')
 *   empty — what to return when there is no office at all (default null)
 */
export function officeLine(office, { sep = ' — ', empty = null } = {}) {
  if (!office) return empty
  return officeParts(office).join(sep)
}
