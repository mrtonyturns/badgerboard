// election-night-update.js
// Called by a scheduled task OR by the front-end every 15 minutes on election night
// (6pm–3am CST). Searches for Wisconsin election results using Claude AI and
// updates the database.

const { createClient } = require('@supabase/supabase-js')

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
)

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

// Is it election night? 6pm–3am CST
function isElectionNightWindow() {
  const now = new Date()
  // CST = UTC-6, CDT = UTC-5. Use UTC offset approach.
  const utcHour = now.getUTCHours()
  // 6pm CST = 00:00 UTC (next day), 3am CST = 09:00 UTC
  // 6pm CDT = 23:00 UTC, 3am CDT = 08:00 UTC
  // Use conservative range: UTC 22–09 (covers both CDT and CST)
  return utcHour >= 22 || utcHour <= 9
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  // Parse optional body for force mode (bypasses time check)
  let force = false
  try {
    const body = JSON.parse(event.body || '{}')
    force = body.force === true
  } catch {}

  if (!force && !isElectionNightWindow()) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ skipped: true, reason: 'Outside election night window (6pm–3am CST)' }),
    }
  }

  try {
    // 1. Find elections happening today or in the last 24 hours
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const { data: elections } = await supabase
      .from('elections')
      .select('id, name, election_date, type, year, notes')
      .gte('election_date', yesterday.toISOString().split('T')[0])
      .lte('election_date', today.toISOString().split('T')[0])

    if (!elections || elections.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No elections today', updated: 0 }),
      }
    }

    // 2. For each election, get candidates in it
    const results = []
    for (const election of elections) {
      const { data: candidates } = await supabase
        .from('candidates')
        .select(`
          id, name, party, status,
          office:offices(name, district_name, level)
        `)
        .eq('election_id', election.id)

      if (!candidates || candidates.length === 0) continue

      const candidateList = candidates.map(c =>
        `- ${c.name} (${c.party || 'No party'}) running for ${c.office?.name || 'Unknown office'}${c.office?.district_name ? ' — ' + c.office.district_name : ''}`
      ).join('\n')

      // 3a. Use Perplexity to fetch real-time results
      let perplexityResults = null
      if (process.env.PERPLEXITY_API_KEY) {
        try {
          const ctrl = new AbortController()
          setTimeout(() => ctrl.abort(), 20000)
          const pRes = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'sonar',
              messages: [
                { role: 'system', content: 'You are a Wisconsin election results researcher. Search for and return the latest vote totals and results for the specified election. Include vote counts, percentages, winner declarations, and reporting percentages.' },
                { role: 'user', content: `Find the latest election results for: ${election.name} on ${election.election_date} in Wisconsin. Candidates: ${candidateList}` }
              ],
              max_tokens: 1500
            })
          })
          if (pRes.ok) {
            const pData = await pRes.json()
            perplexityResults = pData.choices?.[0]?.message?.content || null
          }
        } catch (e) { console.warn('[election-night] Perplexity search failed:', e.message) }
      }

      // 3b. Ask Claude to search for current results
      const prompt = `You are a Wisconsin political election results researcher. It is election night and you need to find the latest vote counts and results for this Wisconsin election.

Election: ${election.name} (${election.election_date})
Type: ${election.type}

Candidates in our database running in this election:
${candidateList}

Please search for the most recent available Wisconsin election results for this election. Look for:
- Current vote totals per candidate
- Percentage of vote received
- Whether any candidate has been declared winner
- Percentage of precincts/results reporting
- Any notable race information

Respond with a JSON object in this exact format:
{
  "election_id": "${election.id}",
  "election_name": "${election.name}",
  "reporting_pct": "XX%",
  "last_updated": "ISO timestamp",
  "results": [
    {
      "candidate_name": "Name as listed above",
      "votes": 12345,
      "percentage": 52.3,
      "winner": true or false,
      "declared": true or false
    }
  ],
  "summary": "1-2 sentence plain English summary of the race status"
}

If you cannot find real results, return an empty results array and explain in summary. Do NOT fabricate vote totals.${perplexityResults ? '\n\nREAL-TIME SEARCH RESULTS FROM WEB:\n' + perplexityResults + '\n\nUse these real results above to populate the JSON. Do not fabricate numbers.' : ''}`

      let electionResults = null
      try {
        const text = await callClaude(prompt)
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          electionResults = JSON.parse(jsonMatch[0])
        }
      } catch (parseErr) {
        console.error('[election-night] Parse failed for:', election.name, 'Raw:', text?.slice(0,200))
        continue
      }

      if (!electionResults || !electionResults.results?.length) continue

      // 4. Update the election notes with results JSON
      const existingNotes = (() => {
        try { return JSON.parse(election.notes || '[]') } catch { return [] }
      })()

      // Merge new results into notes format
      const updatedResults = electionResults.results.map(r => {
        // Find matching candidate
        const candidate = candidates.find(c => {
          const cn = c.name.toLowerCase()
          const rn = (r.candidate_name || '').toLowerCase()
          return cn === rn || cn.includes(rn) || rn.includes(cn)
        })
        return {
          candidate_name: r.candidate_name,
          candidate_id: candidate?.id || null,
          party: candidate?.party || '',
          office: candidate?.office?.name || '',
          votes: r.votes,
          percentage: r.percentage,
          winner: r.winner || false,
          declared: r.declared || false,
        }
      })

      await supabase
        .from('elections')
        .update({
          notes: JSON.stringify({
            results: updatedResults,
            reporting_pct: electionResults.reporting_pct,
            summary: electionResults.summary,
            last_updated: new Date().toISOString(),
            auto_updated: true,
          })
        })
        .eq('id', election.id)

      // 5. Update winning candidates' status and section timestamps
      for (const r of electionResults.results) {
        if (r.winner && r.declared) {
          const candidate = candidates.find(c => {
            const cn = c.name.toLowerCase()
            const rn = (r.candidate_name || '').toLowerCase()
            return cn === rn || cn.includes(rn) || rn.includes(cn)
          })
          if (candidate) {
            await supabase
              .from('candidates')
              .update({
                status: 'elected',
                section_timestamps: {
                  election_result: {
                    updated_at: new Date().toISOString(),
                    updated_by: 'Election Night AI',
                    votes: r.votes,
                    percentage: r.percentage,
                  }
                }
              })
              .eq('id', candidate.id)
          }
        }
      }

      results.push({
        election: election.name,
        candidates_found: candidates.length,
        results_updated: updatedResults.length,
        summary: electionResults.summary,
      })
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        elections_checked: elections.length,
        elections_updated: results.length,
        results,
        timestamp: new Date().toISOString(),
      }),
    }
  } catch (err) {
    console.error('Election night update error:', err)
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    }
  }
}
