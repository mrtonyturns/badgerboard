// Run with: SB_URL=... SB_ANON=... SB_SRK=... node tests/gamePlanTasks.integration.test.mjs
// Game Plan Tasks — live integration test with disposable users.
// Verifies: user isolation, CRUD, Campaign Connect sharing (view+manage),
// revocation, and label upsert. Cleans up everything it creates.
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env.SB_URL, ANON = process.env.SB_ANON, SRK = process.env.SB_SRK
const admin = createClient(URL_, SRK, { auth: { persistSession: false } })
const rand = Math.random().toString(36).slice(2, 8)
const PW = 'Test!' + rand + 'aA1'
const users = {}
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗ FAIL:', name, extra) }
}

async function makeUser(tag) {
  const email = `gp-test-${tag}-${rand}@example.com`
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true })
  if (error) throw new Error('createUser ' + tag + ': ' + error.message)
  const client = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { error: e2 } = await client.auth.signInWithPassword({ email, password: PW })
  if (e2) throw new Error('signIn ' + tag + ': ' + e2.message)
  users[tag] = { id: data.user.id, email, client }
  return users[tag]
}

try {
  console.log('— setup: creating candidate / action / stranger test users')
  const cand = await makeUser('candidate')
  const act  = await makeUser('action')
  const str  = await makeUser('stranger')

  console.log('— candidate: own-plan CRUD')
  const { data: proj, error: pe } = await cand.client.from('gp_projects')
    .insert({ name: 'Test Campaign', color: '#8B0000', created_by: cand.id, owner_id: cand.id }).select().single()
  ok('candidate creates project', !!proj && !pe, pe?.message)
  const { data: sec } = await cand.client.from('gp_sections')
    .insert({ project_id: proj.id, name: 'GOTV', created_by: cand.id, owner_id: cand.id }).select().single()
  ok('candidate creates section', !!sec)
  const { data: task, error: te } = await cand.client.from('gp_tasks')
    .insert({ content: 'Knock doors', project_id: proj.id, section_id: sec.id, priority: 2,
              labels: ['outreach'], due_date: '2026-08-01', created_by: cand.id, owner_id: cand.id }).select().single()
  ok('candidate creates task', !!task && !te, te?.message)
  const { data: ownRead } = await cand.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('candidate reads own tasks', ownRead?.length === 1)

  console.log('— isolation: BEFORE any link')
  const { data: preRead } = await act.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('action account sees nothing before link', (preRead || []).length === 0)
  const { error: preIns } = await act.client.from('gp_tasks')
    .insert({ content: 'Sneaky', created_by: act.id, owner_id: cand.id }).select().single()
  ok('action account cannot insert before link (RLS blocks)', !!preIns)
  const { data: strRead } = await str.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('stranger sees nothing', (strRead || []).length === 0)

  console.log('— link: service role activates Campaign Connect (manage_tasks)')
  const { data: link, error: le } = await admin.from('account_links').insert({
    action_user_id: act.id, candidate_email: cand.email, candidate_user_id: cand.id,
    status: 'active', accepted_at: new Date().toISOString(),
    permissions: { view: true, manage_tasks: true, manage_page: false, receive_profiles: false },
  }).select().single()
  ok('link created', !!link && !le, le?.message)

  console.log('— connected action account: view + manage candidate plan')
  const { data: postProj } = await act.client.from('gp_projects').select('*').eq('owner_id', cand.id)
  ok('action sees candidate projects', postProj?.length === 1)
  const { data: postRead } = await act.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('action sees candidate tasks', postRead?.length === 1)
  const { data: mgrTask, error: me } = await act.client.from('gp_tasks')
    .insert({ content: 'File finance report', project_id: proj.id, section_id: sec.id,
              priority: 1, created_by: act.id, owner_id: cand.id }).select().single()
  ok('action adds task to candidate plan', !!mgrTask && !me, me?.message)
  const { data: upd, error: ue } = await act.client.from('gp_tasks')
    .update({ completed: true, completed_at: new Date().toISOString() }).eq('id', task.id).select().single()
  ok('action completes candidate task', !!upd?.completed && !ue, ue?.message)
  const { data: candSees } = await cand.client.from('gp_tasks').select('*').eq('owner_id', cand.id).eq('completed', false)
  ok('candidate sees manager-added task in their own plan', candSees?.some(t => t.id === mgrTask.id))
  ok('manager-added task keeps honest audit trail', candSees?.find(t => t.id === mgrTask.id)?.created_by === act.id)

  console.log('— spoof check: action cannot forge created_by')
  const { error: forge } = await act.client.from('gp_tasks')
    .insert({ content: 'Forged', created_by: cand.id, owner_id: cand.id }).select().single()
  ok('created_by must equal auth.uid()', !!forge)

  console.log('— label upsert per owner')
  const { error: l1 } = await act.client.from('gp_labels')
    .upsert({ name: 'finance', created_by: act.id, owner_id: cand.id }, { onConflict: 'owner_id,name' }).select().single()
  const { error: l2 } = await act.client.from('gp_labels')
    .upsert({ name: 'finance', created_by: act.id, owner_id: cand.id }, { onConflict: 'owner_id,name' }).select().single()
  ok('label upsert works and is idempotent', !l1 && !l2, l1?.message || l2?.message)

  console.log('— revocation')
  await admin.from('account_links').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', link.id)
  const { data: revRead } = await act.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('revoked link: action sees nothing again', (revRead || []).length === 0)
  const { error: revIns } = await act.client.from('gp_tasks')
    .insert({ content: 'After revoke', created_by: act.id, owner_id: cand.id }).select().single()
  ok('revoked link: action cannot insert', !!revIns)

  console.log('— view-only permission')
  await admin.from('account_links').update({ status: 'active', permissions: { view: true, manage_tasks: false } }).eq('id', link.id)
  const { data: voRead } = await act.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('view-only: can still read', (voRead || []).length >= 1)
  const { error: voIns } = await act.client.from('gp_tasks')
    .insert({ content: 'View-only write', created_by: act.id, owner_id: cand.id }).select().single()
  ok('view-only: writes blocked', !!voIns)
  const { data: voUpd } = await act.client.from('gp_tasks')
    .update({ content: 'hacked' }).eq('owner_id', cand.id).select()
  ok('view-only: updates blocked (0 rows)', (voUpd || []).length === 0)

  console.log('— project cascade delete')
  const { error: de } = await cand.client.from('gp_projects').delete().eq('id', proj.id)
  const { data: after } = await cand.client.from('gp_tasks').select('*').eq('owner_id', cand.id)
  ok('deleting project cascades tasks', !de && (after || []).length === 0, de?.message)

} catch (e) {
  fail++
  console.error('TEST HARNESS ERROR:', e.message)
} finally {
  console.log('— cleanup: deleting test users (cascades all rows)')
  for (const tag of Object.keys(users)) {
    const { error } = await admin.auth.admin.deleteUser(users[tag].id)
    console.log('  deleted', tag, error ? 'ERROR ' + error.message : 'ok')
  }
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
