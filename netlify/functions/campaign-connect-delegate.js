// Campaign Connect — delegated access into a linked candidate account's workspace.
// Every call verifies an ACTIVE link + the required permission scope, and audit-logs writes.
const H = require('./_campaign-connect')

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H.CORS, body: '' }
  if (event.httpMethod !== 'POST')  return { statusCode: 405, headers: H.CORS, body: JSON.stringify({ error: 'POST only' }) }

  const user = await H.verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return { statusCode: 401, headers: H.CORS, body: JSON.stringify({ error: 'Not authenticated' }) }

  let body; try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, headers: H.CORS, body: JSON.stringify({ error: 'Invalid JSON' }) } }
  const { action, candidate_user_id } = body
  const reply = (obj, code = 200) => ({ statusCode: code, headers: H.CORS, body: JSON.stringify(obj) })

  if (!candidate_user_id) return reply({ error: 'candidate_user_id required' }, 400)
  const link = await H.activeLinkFor(user.id, candidate_user_id)
  if (!link) return reply({ error: 'No active Campaign Connect link with this candidate.' }, 403)
  const perms = { ...H.DEFAULT_PERMS, ...(link.permissions || {}) }
  const need = (scope) => { if (!perms[scope]) throw Object.assign(new Error(`Missing permission: ${scope}`), { code: 403 }) }

  try {
    switch (action) {
      case 'workspace': {
        need('view')
        const [cands, doss, miles] = await Promise.all([
          H.sb(`candidates?created_by=eq.${candidate_user_id}&select=id,name,party,status,office:offices(name,district_name)&order=created_at.desc`),
          H.sb(`dossiers?created_by=eq.${candidate_user_id}&select=id,title,created_at&order=created_at.desc&limit=50`),
          H.sb(`game_plan_milestones?created_by=eq.${candidate_user_id}&select=*&order=due_date.asc.nullslast`),
        ])
        const milestones = Array.isArray(miles.data) ? miles.data : []
        const openCount = milestones.filter(m => m.status !== 'done' && m.status !== 'complete').length
        const metrics = {
          candidates: (cands.data || []).length,
          profiles: (doss.data || []).length,
          tasks_total: milestones.length,
          tasks_open: openCount,
          tasks_done: milestones.length - openCount,
        }
        return reply({ ok: true, permissions: perms, relationship_type: link.relationship_type,
          candidates: cands.data || [], profiles: doss.data || [], tasks: milestones, metrics })
      }

      case 'task_create': {
        need('manage_tasks')
        const row = {
          created_by: candidate_user_id,
          candidate_id: body.candidate_id || null,
          title: String(body.title || '').slice(0, 300),
          phase: body.phase || 'planning',
          category: body.category || 'general',
          status: body.status || 'todo',
          due_date: body.due_date || null,
        }
        if (!row.title) return reply({ error: 'Task title required' }, 400)
        const ins = await H.sb('game_plan_milestones', 'POST', row)
        if (!ins.ok) return reply({ error: 'Could not create task' }, 500)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_created', { title: row.title })
        return reply({ ok: true, task: ins.data[0] })
      }

      case 'task_update': {
        need('manage_tasks')
        const { task_id } = body
        const patch = {}
        for (const k of ['title', 'phase', 'category', 'status', 'due_date']) if (k in body) patch[k] = body[k]
        const upd = await H.sb(`game_plan_milestones?id=eq.${task_id}&created_by=eq.${candidate_user_id}`, 'PATCH', patch)
        if (!upd.ok) return reply({ error: 'Could not update task' }, 500)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_updated', { task_id, patch })
        return reply({ ok: true, task: (upd.data || [])[0] })
      }

      case 'task_toggle': {
        need('manage_tasks')
        const { task_id, done } = body
        const upd = await H.sb(`game_plan_milestones?id=eq.${task_id}&created_by=eq.${candidate_user_id}`, 'PATCH', { status: done ? 'done' : 'todo' })
        if (!upd.ok) return reply({ error: 'Could not update task' }, 500)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_toggled', { task_id, done })
        return reply({ ok: true, task: (upd.data || [])[0] })
      }

      case 'task_delete': {
        need('manage_tasks')
        const { task_id } = body
        const del = await H.sb(`game_plan_milestones?id=eq.${task_id}&created_by=eq.${candidate_user_id}`, 'DELETE')
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_deleted', { task_id })
        return reply({ ok: true })
      }

      case 'activity': {
        need('view')
        const { data } = await H.sb(`cc_activity?candidate_user_id=eq.${candidate_user_id}&select=*&order=created_at.desc&limit=50`)
        return reply({ ok: true, activity: Array.isArray(data) ? data : [] })
      }

      default:
        return reply({ error: 'Unknown action.' }, 400)
    }
  } catch (e) {
    const code = e.code === 403 ? 403 : 500
    console.error('[cc-delegate]', e)
    return reply({ error: e.message }, code)
  }
}
