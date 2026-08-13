// Campaign Connect — delegated access into a linked candidate account's workspace.
// Every call verifies an ACTIVE link + the required permission scope, and audit-logs writes.
const H = require('./_campaign-connect')

// gp_tasks (the Game Plan board's table) → the shape Campaign Connect renders.
// The board stores `content` + `completed`; the delegate UI reads `title` +
// `status`, so translate at the boundary rather than in the page.
const toClientTask = (r) => (r ? {
  id: r.id,
  title: r.content,
  status: r.completed ? 'done' : 'todo',
  due_date: r.due_date || null,
  priority: r.priority ?? 4,
  description: r.description || null,
  project_id: r.project_id || null,
  created_at: r.created_at || null,
} : null)

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H.CORS, body: '' }
  if (event.httpMethod !== 'POST')  return { statusCode: 405, headers: H.CORS, body: JSON.stringify({ error: 'POST only' }) }

  const user = await H.verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return { statusCode: 401, headers: H.CORS, body: JSON.stringify({ error: 'Not authenticated' }) }

  let body; try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, headers: H.CORS, body: JSON.stringify({ error: 'Invalid JSON' }) } }
  const { action, candidate_user_id } = body
  const reply = (obj, code = 200) => ({ statusCode: code, headers: H.CORS, body: JSON.stringify(obj) })

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!candidate_user_id || !UUID.test(candidate_user_id)) return reply({ error: 'valid candidate_user_id required' }, 400)
  const enc = encodeURIComponent
  const link = await H.activeLinkFor(user.id, candidate_user_id)
  if (!link) return reply({ error: 'No active Campaign Connect link with this candidate.' }, 403)
  const perms = { ...H.DEFAULT_PERMS, ...(link.permissions || {}) }
  const need = (scope) => { if (!perms[scope]) throw Object.assign(new Error(`Missing permission: ${scope}`), { code: 403 }) }

  try {
    switch (action) {
      case 'workspace': {
        need('view')
        const [cands, doss, taskRes] = await Promise.all([
          H.sb(`candidates?created_by=eq.${enc(candidate_user_id)}&select=id,name,party,status,office:offices(name,district_name)&order=created_at.desc`),
          H.sb(`dossiers?created_by=eq.${enc(candidate_user_id)}&select=id,title,created_at&order=created_at.desc&limit=50`),
          // gp_tasks is the Game Plan board's real table; owner_id is the plan
          // owner (the candidate), created_by is whoever added the row.
          H.sb(`gp_tasks?owner_id=eq.${enc(candidate_user_id)}&parent_id=is.null&select=*&order=due_date.asc.nullslast,sort_order.asc`),
        ])
        const rows  = Array.isArray(taskRes.data) ? taskRes.data : []
        const tasks = rows.map(toClientTask)
        const openCount = tasks.filter(t => t.status !== 'done').length
        const metrics = {
          candidates: (cands.data || []).length,
          profiles: (doss.data || []).length,
          tasks_total: tasks.length,
          tasks_open: openCount,
          tasks_done: tasks.length - openCount,
        }
        return reply({ ok: true, permissions: perms, relationship_type: link.relationship_type,
          candidates: cands.data || [], profiles: doss.data || [], tasks, metrics })
      }

      case 'task_create': {
        need('manage_tasks')
        const content = String(body.title || '').slice(0, 300)
        if (!content) return reply({ error: 'Task title required' }, 400)
        const row = {
          owner_id: candidate_user_id,   // the plan this task belongs to
          created_by: user.id,           // the delegated actor, per gp_can_edit
          content,
          description: body.description ? String(body.description).slice(0, 2000) : null,
          due_date: body.due_date || null,
          completed: body.status === 'done',
          completed_at: body.status === 'done' ? new Date().toISOString() : null,
        }
        const ins = await H.sb('gp_tasks', 'POST', row)
        if (!ins.ok) return reply({ error: 'Could not create task' }, 500)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_created', { title: content })
        return reply({ ok: true, task: toClientTask((ins.data || [])[0]) })
      }

      case 'task_update': {
        need('manage_tasks')
        const { task_id } = body
        if (!UUID.test(task_id || '')) return reply({ error: 'valid task_id required' }, 400)
        const patch = {}
        if ('title' in body)       patch.content = String(body.title || '').slice(0, 300)
        if ('description' in body) patch.description = body.description ? String(body.description).slice(0, 2000) : null
        if ('due_date' in body)    patch.due_date = body.due_date || null
        if ('status' in body) {
          patch.completed = body.status === 'done'
          patch.completed_at = body.status === 'done' ? new Date().toISOString() : null
        }
        if (Object.keys(patch).length === 0) return reply({ error: 'Nothing to update' }, 400)
        const upd = await H.sb(`gp_tasks?id=eq.${enc(task_id)}&owner_id=eq.${enc(candidate_user_id)}`, 'PATCH', patch)
        if (!upd.ok) return reply({ error: 'Could not update task' }, 500)
        if (!(upd.data || []).length) return reply({ error: 'Task not found' }, 404)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_updated', { task_id, patch })
        return reply({ ok: true, task: toClientTask((upd.data || [])[0]) })
      }

      case 'task_toggle': {
        need('manage_tasks')
        const { task_id, done } = body
        if (!UUID.test(task_id || '')) return reply({ error: 'valid task_id required' }, 400)
        const upd = await H.sb(
          `gp_tasks?id=eq.${enc(task_id)}&owner_id=eq.${enc(candidate_user_id)}`,
          'PATCH',
          { completed: !!done, completed_at: done ? new Date().toISOString() : null }
        )
        if (!upd.ok) return reply({ error: 'Could not update task' }, 500)
        if (!(upd.data || []).length) return reply({ error: 'Task not found' }, 404)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_toggled', { task_id, done })
        return reply({ ok: true, task: toClientTask((upd.data || [])[0]) })
      }

      case 'task_delete': {
        need('manage_tasks')
        const { task_id } = body
        if (!UUID.test(task_id || '')) return reply({ error: 'valid task_id required' }, 400)
        const del = await H.sb(`gp_tasks?id=eq.${enc(task_id)}&owner_id=eq.${enc(candidate_user_id)}`, 'DELETE')
        if (!del.ok) return reply({ error: 'Could not delete task' }, 500)
        await H.logActivity(link.id, user.id, candidate_user_id, 'task_deleted', { task_id })
        return reply({ ok: true })
      }

      case 'activity': {
        need('view')
        const { data } = await H.sb(`cc_activity?candidate_user_id=eq.${enc(candidate_user_id)}&select=*&order=created_at.desc&limit=50`)
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
