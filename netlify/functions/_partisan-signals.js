// netlify/functions/_partisan-signals.js
// ─── Deterministic Wisconsin partisan-signal lexicon ─────────────────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// Built from the 2026-07 deep-research pass on event-affiliation classification.
// Signal hierarchy (strongest → weakest), mirroring how the verified public
// registries classify organizations:
//   Tier 1 — registered partisan entities: party committees (RPW/DPW and the
//            72 county parties), candidate committees, partisan caucus orgs.
//            → confirmed_*, certainty 100.
//   Tier 2 — organizations with documented partisan alignment: unions and
//            labor federations (Mobilize/ActBlue-side infrastructure),
//            ideological advocacy orgs with known lean.
//            → likely_*, certainty 85-95.
//   Tier 3 — structurally nonpartisan civic hosts (chambers, Lions/Rotary,
//            churches, libraries, fairs): the AREA lean is the only signal.
//
// Matching is regex-on-lowercased-host. Patterns are deliberately generous
// with word boundaries — host strings come from scraped event listings and
// arrive in every imaginable format.

const T1_CONSERVATIVE = [
  /republican party/, /\bgop\b/, /county republicans\b/, /republican women/,
  /young republicans/, /college republicans/, /\brpw\b/,
  /republican committee/, /trump (campaign|victory|force)/,
  /turning point (action|usa)/, /maga\b/,
]

const T1_LIBERAL = [
  /democratic party/, /county democrats\b/, /\bdems\b/, /dem party/,
  /young democrats/, /college democrats/, /\bdpw\b/,
  /democratic committee/, /democratic socialists/, /\bdsa\b/,
]

const T2_CONSERVATIVE = [
  /americans for prosperity/, /moms for liberty/, /right to life/,
  /pro-?life (wisconsin|action|coalition)/, /wisconsin family (action|council)/,
  /\bnra\b/, /friends of nra/, /gun owners of america/, /firearms coalition/,
  /federalist society/, /heritage (foundation|action)/, /freedomworks/,
  /tea party/, /patriot (front|guard|coalition)/, /convention of states/,
  /wisconsin manufacturers (&|and) commerce/, /\bwmc\b/,
  /institute for reforming government/, /badger institute/, /maciver institute/,
  /concerned women for america/, /eagle forum/,
]

const T2_LIBERAL = [
  // Labor — union presence is a verified strong left-side signal
  /\bafscme\b/, /\bseiu\b/, /\bweac\b/, /\bafl-?cio\b/, /\bibew\b/,
  /teamsters/, /\buaw\b/, /steelworkers/, /\busw\b/, /\bafge\b/, /\baft\b/,
  /building trades/, /labor council/, /labor federation/, /central labor/,
  /education association/, /teachers union/, /nurses (united|association)/,
  /united food and commercial/, /\bufcw\b/, /operating engineers/,
  /laborers.? (local|union)/, /machinists/, /iron ?workers/, /carpenters union/,
  // Progressive advocacy / infrastructure
  /indivisible/, /citizen action/, /planned parenthood/, /\bnaral\b/,
  /league of conservation voters/, /sierra club/, /clean wisconsin/,
  /\baclu\b/, /black leaders organizing/, /\bbloc\b/, /voces de la frontera/,
  /working families (party|power)/, /our wisconsin revolution/,
  /moveon/, /swing left/, /run for something/, /emily'?s list/,
  /souls to the polls/, /wisconsin conservation voters/,
  /fair (maps|wisconsin)/, /forward latino/, /power to the polls/,
]

// Structurally nonpartisan hosts — explicit Tier-3 recognition stops the
// classifier from over-reading these (League of Women Voters is legally
// nonpartisan; chambers/fairs/service clubs draw cross-partisan crowds).
const T3_NONPARTISAN = [
  /league of women voters/, /chamber of commerce/, /rotary/, /\blions\b/,
  /kiwanis/, /optimist/, /\bvfw\b/, /american legion/, /knights of columbus/,
  /historical society/, /public library/, /friends of the library/,
  /school district/, /\b4-?h\b/, /\bffa\b/, /farm bureau/,
  /main street/, /senior center/, /county fair/, /agricultural society/,
]

function matchPartisanSignals(hostRaw) {
  if (!hostRaw) return null
  const host = String(hostRaw).toLowerCase().replace(/[.']/g, '')
  for (const re of T1_CONSERVATIVE) if (re.test(host)) return { label: 'confirmed_conservative', score: 90,  certainty: 100, tier: 1, match: re.source }
  for (const re of T1_LIBERAL)      if (re.test(host)) return { label: 'confirmed_liberal',      score: -90, certainty: 100, tier: 1, match: re.source }
  for (const re of T2_CONSERVATIVE) if (re.test(host)) return { label: 'likely_conservative',    score: 70,  certainty: 90,  tier: 2, match: re.source }
  for (const re of T2_LIBERAL)      if (re.test(host)) return { label: 'likely_liberal',         score: -70, certainty: 90,  tier: 2, match: re.source }
  for (const re of T3_NONPARTISAN)  if (re.test(host)) return { label: 'nonpartisan',            score: 0,   certainty: 85,  tier: 3, match: re.source }
  return null
}

module.exports = { matchPartisanSignals }
