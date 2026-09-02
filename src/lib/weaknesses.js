// Key-weakness extraction from a generated profile (dossier markdown).
//
// candidates.weaknesses is populated from the profile's Controversies section
// (Section 6), the SWOT "Weaknesses" quadrant and the Section 13 attack table.
// The previous extractor flipped into "capture mode" on ANY line containing the
// words Controversies / Weaknesses (including a Section 1 summary sentence) and
// then treated every `**Bold label:**` line it met as a weakness — which is how
// schema field labels like "Background Narrative:" and "WEC Committee Filing:"
// ended up rendering as empty cards on the Opposition tab.
//
// PURE MODULE — no imports, no JSX. netlify/functions/_weaknesses.js is a
// CommonJS mirror of the block between the sentinels below (the background
// function cannot import from src/); tests/weaknesses.test.mjs asserts the two
// copies are byte-identical, so edit both together.

// ─── WEAKNESSES PURE HELPERS BEGIN ───
const WEAKNESS_MIN_CHARS = 25
const WEAKNESS_MAX = 8

// Cells / values the model emits when a row is a template or a non-finding.
const NON_FINDING = /^(?:none|n\/a|na|nil|null|tbd|unknown|not found|none found|no(?:ne)? (?:known|found|identified|documented|located)|not applicable|—|–|-|\?|_+)\.?$/i

// "Label: No violations found" / "Bankruptcy: None on record" — a clean result.
const NEGATIVE_VALUE = /^[^:]{1,80}:\s*(?:no|none|nothing|not)\b/i

// Table header words the prompt hands the model — a row made only of these is
// the schema header, not a finding.
const TABLE_HEADER_CELLS = new Set([
  'issue', 'date', 'summary', 'summary (2 sent.)', 'source', 'src', 'response', 'status',
  'confidence', 'conf', 'vulnerability', 'evidence', 'framing', 'finding', 'sources',
  'item', 'value', 'field', 'priority', 'research priority', 'type', 'notes',
])

/** Strip markdown emphasis, bullets, checkboxes and citation markers. */
function cleanWeaknessText(raw) {
  return String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/^\s*(?:[-*•]\s*)+/, '')                   // leading bullet glyphs
    .replace(/^\s*\[\s*[xX]?\s*\]\s*/, '')              // checkbox "[ ]" / "[x]"
    .replace(/\*\*\[[^\]]*\]\*\*/g, ' ')                // "**[RESEARCH REQUIRED]**"
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')             // "[3]" / "[1, 2]" citations
    .replace(/\[\^[^\]]*\]/g, '')                       // "[^note]" footnotes
    .replace(/\*\*|__/g, '')                            // bold markers
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:])/g, '$1$2') // *italic* / _italic_
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/^[\s:;,.\-–—|·•]+/, '')
    .replace(/[\s\-–—|·•]+$/, '')
    .trim()
}

/** The text with every bracket token removed — what a reader would actually get. */
function weaknessSubstance(text) {
  return cleanWeaknessText(text)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[\s:;,.\-–—|·•]+|[\s:;,.\-–—|·•]+$/g, '')
    .trim()
}

/**
 * "Background Narrative:" / "**WEC Committee Filing:**" / "Committees: —" — a
 * field label with nothing (or a non-finding) after the colon.
 */
function isLabelOnly(text) {
  const s = cleanWeaknessText(text)
  if (!s) return true
  const m = s.match(/^([^:]{1,80}):\s*(.*)$/)
  if (!m) return false
  const value = weaknessSubstance(m[2])
  return value === '' || NON_FINDING.test(value)
}

/** Is this a weakness worth showing (not empty, not a placeholder, not a bare label)? */
function isRealWeakness(entry, minChars = 12) {
  const text = typeof entry === 'string' ? entry : entry?.text
  const s = cleanWeaknessText(text)
  if (!s) return false
  if (/^#{1,6}\s/.test(String(text).trim())) return false
  if (isLabelOnly(s)) return false
  const substance = weaknessSubstance(s)
  if (substance.length < minChars) return false
  if (NON_FINDING.test(substance)) return false
  return true
}

function sliceSection(content, num) {
  const re = new RegExp(`^##\\s*SECTION\\s*${num}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s*SECTION\\s*\\d+|(?![\\s\\S]))`, 'im')
  const m = String(content ?? '').match(re)
  return m ? m[1] : ''
}

function tableCells(line) {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) return null // |---|---| separator
  return cells
}

function weaknessFromTableRow(cells) {
  const norm = cells.map(c => cleanWeaknessText(c))
  if (norm.filter(Boolean).every(c => TABLE_HEADER_CELLS.has(c.toLowerCase()))) return null
  const issue = norm[0]
  if (!issue || !weaknessSubstance(issue) || NON_FINDING.test(weaknessSubstance(issue))) return null
  // The most informative other cell is the summary / evidence column — take the
  // longest one that carries real text (dates, sources and Y/N cells are short).
  const detail = norm.slice(1)
    .filter(c => weaknessSubstance(c).length >= WEAKNESS_MIN_CHARS && !NON_FINDING.test(weaknessSubstance(c)))
    .sort((a, b) => b.length - a.length)[0]
  if (!detail) return weaknessSubstance(issue).length >= WEAKNESS_MIN_CHARS ? issue : null
  const issueLc = issue.toLowerCase()
  return detail.toLowerCase().startsWith(issueLc) ? detail : `${issue.replace(/[.:]$/, '')}: ${detail}`
}

function collectFromLines(lines, out, seen) {
  for (const rawLine of lines) {
    if (out.length >= WEAKNESS_MAX) return
    const line = rawLine.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue                         // headings
    if (/^\s*(?:[-*•]\s*)?\[\s*[xX ]?\s*\]/.test(line)) continue // research-framework checkboxes
    if (/^\*[^*].*\*$/.test(line)) continue                      // *italic note lines*
    let text = null
    const cells = tableCells(line)
    if (cells) {
      text = weaknessFromTableRow(cells)
    } else if (/^[-*•]\s+/.test(line)) {
      text = cleanWeaknessText(line)
    } else if (/^\*\*[^*]+\*\*/.test(line)) {
      // "**Tax lien:** $12,000 WDFI lien filed 2019" — keep label + value;
      // "**Background Narrative:**" alone is a field label and is dropped below.
      text = cleanWeaknessText(line)
    } else {
      continue // plain prose is never lifted as a weakness (unchanged behaviour)
    }
    if (!text || !isRealWeakness(text, WEAKNESS_MIN_CHARS)) continue
    // "Campaign finance: No WEC violations found" is a clean bill, not a weakness.
    if (NEGATIVE_VALUE.test(text)) continue
    const key = weaknessSubstance(text).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
}

/**
 * Extract key weaknesses from dossier markdown. Sources, in priority order:
 * Section 6 (Controversies) rows and bullets, the SWOT "Weaknesses" quadrant,
 * then the Section 13 attack-angles table. Returns plain strings, max 8.
 */
function extractWeaknesses(content) {
  if (!content) return []
  const out = []
  const seen = new Set()

  collectFromLines(sliceSection(content, 6).split('\n'), out, seen)

  // SWOT quadrant: "- **Weaknesses** (...)" followed by indented "  - bullet" lines.
  const swot = String(content).match(/^\s*[-*]?\s*\*\*Weaknesses\*\*[^\n]*\n([\s\S]*?)(?=^\s*[-*]?\s*\*\*(?:Strengths|Opportunities|Threats)\*\*|^##\s|(?![\s\S]))/im)
  if (swot) collectFromLines(swot[1].split('\n'), out, seen)

  const s13 = sliceSection(content, 13)
  const attackOnly = s13.split(/^\*\*Defense prep/im)[0]
  collectFromLines(attackOnly.split('\n'), out, seen)

  return out.slice(0, WEAKNESS_MAX)
}
// ─── WEAKNESSES PURE HELPERS END ───

export { cleanWeaknessText, weaknessSubstance, isLabelOnly, isRealWeakness, extractWeaknesses, WEAKNESS_MIN_CHARS, WEAKNESS_MAX }
