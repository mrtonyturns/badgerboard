// src/lib/profileContent.js — display-time filtering of "nothing found" content
// in AI-generated profiles. NEVER mutates stored data: callers filter a copy at
// render time; the full original stays in the database.

const NO_FINDINGS_PATTERNS = [
  /no (?:public |verified |significant |notable |known |additional |specific |such )*(?:information|records?|data|findings?|results?|evidence|coverage|posts?|activity|history|controversies|endorsements?|mentions?)[^.\n]*(?:found|available|identified|located|exists?|discovered|uncovered|verified)?/i,
  /(?:none|nothing) (?:was |were |could be )?(?:found|identified|available|located|discovered|uncovered|verified)/i,
  /could not (?:find|locate|verify|identify|confirm|uncover)/i,
  /could not be (?:found|located|verified|identified|confirmed|uncovered)/i,
  /^no\b[^.\n]{0,60}(?:found|identified|available|located|discovered|verified|uncovered|exists?|on record)/i,
  /unable to (?:find|locate|verify|identify|confirm|uncover)/i,
  /not (?:publicly )?(?:available|found|located|identified)/i,
  /insufficient (?:public )?(?:information|data|records?)/i,
  /no results? (?:found|returned|available)/i,
  /does not (?:appear|seem) to have (?:any|a)\b/i,
  /^(?:n\/a|none|not applicable)\.?$/i,
  /research (?:did not|failed to) (?:surface|find|locate|identify)/i,
  /(?:searches?|research) (?:returned|yielded|produced) no\b/i,
]

/** Strip markdown scaffolding so we can judge whether real content remains. */
function stripScaffolding(text = '') {
  return text
    .replace(/^#{1,6} .*$/gm, '')            // headings
    .replace(/\*\*\[[A-Z ]+\]\*\*/g, '')     // confidence badges
    .replace(/^[-*_]{3,}\s*$/gm, '')         // hr separators
    .replace(/^\s*[-*•]\s*$/gm, '')          // empty bullets
    .replace(/[*_`>#|]/g, '')                // md syntax
    .trim()
}

/** True when a piece of text contains substantive findings (not just "nothing found"). */
export function hasFindings(text = '') {
  const body = stripScaffolding(text)
  if (body.length < 25) return false
  // Judge line-by-line: a section is empty when every substantive line is a no-findings statement
  const lines = body.split(/\n+/).map(l => l.trim()).filter(l => l.length > 3)
  if (!lines.length) return false
  const contentLines = lines.filter(l => !NO_FINDINGS_PATTERNS.some(re => re.test(l)))
  // Real content = at least one line that isn't a no-findings phrase and carries some substance
  return contentLines.some(l => l.length >= 25)
}

/**
 * Filter a section's markdown: drop sub-blocks (split on ### / #### headings and
 * paragraph gaps after them) whose content has no findings. Returns the filtered
 * markdown, or null when the whole section is empty of findings.
 */
export function filterSectionContent(content = '') {
  if (!content.trim()) return null
  // Keep the section's own "## ..." heading line aside
  const headingMatch = content.match(/^(#{1,2} .*)$/m)
  // Split into blocks at sub-headings (###+) — each block = subheading + its body
  const blocks = content.split(/\n(?=#{3,6} )/)
  const kept = blocks.filter((block, i) => {
    // Never drop the very first block if it contains the section heading AND findings elsewhere survive;
    // judge each block by its own body (minus its subheading line).
    const body = block.replace(/^#{1,6} .*$/m, '')
    if (hasFindings(body)) return true
    // First block with only the section title and no body: keep it only if other blocks survive (handled after)
    return false
  })
  if (!kept.length) return null
  let result = kept.join('\n')
  // Re-attach the section heading if it was dropped with an empty intro block
  if (headingMatch && !result.includes(headingMatch[1])) {
    result = `${headingMatch[1]}\n\n${result}`
  }
  return hasFindings(result) ? result : null
}

/**
 * Filter parsed sections for display. Adds displayContent; drops empty sections.
 * Pass showEmpty=true to keep everything (raw view).
 */
export function filterSections(sections = [], showEmpty = false) {
  const out = []
  let hiddenCount = 0
  for (const s of sections) {
    const displayContent = filterSectionContent(s.content)
    if (displayContent) {
      out.push({ ...s, displayContent })
    } else {
      hiddenCount++
      if (showEmpty) out.push({ ...s, displayContent: s.content, isEmptySection: true })
    }
  }
  return { sections: out, hiddenCount }
}
