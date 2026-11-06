'use strict';
// Creator tasks / activities and creative inspirations, read with the editor's login, and binding them
// to a project the way the editor does.
const { M } = require('./common.cjs');

// The activity center marks every task as an effect activity and rewrites task_type; the task detail
// window then launches projects with these fields (ActivityCenter/TaskDetailsWindow).
const EFFECT_ACTIVITY = 0;

async function backendGet(lib, apiPath) {
  const { Domain } = lib.mod(M.urls);
  const { PlatformUtils, UserAgentUtils } = lib.mod(M.bizUtils);
  const cookie = await new (lib.mod(M.orionui).CookieManager)().getCookie(Domain.kBackendApiURL);
  const res = await fetch(Domain.kBackendApiURL + apiPath, {
    headers: { cookie, 'x-api-sign-data': PlatformUtils.genSignData(), 'user-agent': UserAgentUtils.userAgentGenerator()() },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Error(`BACKEND_HTTP_${res.status}: ${apiPath}`);
  const json = await res.json();
  if (json.code !== 0) throw Error(`BACKEND_FAILED: ${apiPath} code=${json.code} message=${json.message || ''}`);
  return json.data || {};
}

function tagNames(tags) {
  if (typeof tags === 'string') return tags.split(',').filter(Boolean);
  return (tags || []).map((t) => (t && t.name) || t).filter(Boolean);
}

const days = (ms) => (typeof ms === 'number' && ms >= 0 ? Math.floor(ms / 86400000) : null);

function slimTask(t, kind) {
  const bindId = kind === 'task' ? t.designer_task_id : t.id;
  return {
    task_id: String(kind === 'task' ? t.task_id ?? t.item_id : t.id),
    kind,
    title: t.title || t.name || '',
    status: t.process_status_text || null,
    received: kind === 'task' ? !!t.designer_task_id : null,
    bindable: !!bindId,
    tags: tagNames(t.tags),
    days_left: days(t.ttl),
    revenue: t.revenue ?? null,
    icon_url: t.icon_url || null,
  };
}

// What the task detail window passes as launch extras when it opens a project for a task.
function activityExtra(lib, t, kind) {
  const model = { ...t, display_type: EFFECT_ACTIVITY, task_type: kind === 'task' ? 'Normal' : 'Growup', id: kind === 'task' ? t.designer_task_id : t.id };
  return {
    activity_id: model.id,
    activity_name: model.title,
    activity_enter_from: 'homepage',
    activity_type: lib.mod(M.activityTypes).getTypeName(model),
    task_type: model.task_type,
  };
}

const methods = {
  async tasksList() {
    this.ensureCompatible('community');
    const { DomainPath } = this.mod(M.urls);
    const [acts, tasks] = await Promise.all([backendGet(this, DomainPath.kActivityAPI), backendGet(this, DomainPath.kTaskListAPI)]);
    const rows = [...(acts.activities || []).map((t) => ['activity', t]), ...(tasks.effect_tasks || []).map((t) => ['task', t])];
    const items = rows.map(([kind, t]) => slimTask(t, kind));
    const raw = rows.map(([kind, t]) => ({ kind, extra: (kind === 'task' ? t.designer_task_id : t.id) ? activityExtra(this, t, kind) : null }));
    return { items, raw };
  },

  async inspirationDetail({ id }) {
    this.ensureCompatible('community');
    if (typeof id !== 'string' || !id.trim()) throw Error('INVALID_ID: pass an inspiration id');
    const res = await this.mod(M.inspiration).getInspirationDetail({ id: id.trim() });
    const b = res && res.body;
    if (!b || b.code !== 0) throw Error(`INSPIRATION_FAILED: code=${b && b.code} message=${(b && b.message) || ''}`);
    const d = b.data || {};
    const base = d.base || {};
    return {
      id: id.trim(),
      base: { ...base, imgs: (base.imgs || []).map((i) => (i.urlList || [])[0]).filter(Boolean) },
      designer: d.designer ? { name: d.designer.name } : null,
      artwork_type: d.inspArtworkType ?? null,
      award: d.award ?? null,
      task_award: d.taskAward ?? null,
      effects: d.effects ?? null,
      music: d.musicInfo ?? null,
      videos: (d.videos || []).length,
    };
  },

  // The editor's own agent hook: records the inspiration on the open project (saved with it).
  inspirationBind({ id }) {
    this.ensureCompatible('community');
    if (typeof id !== 'string' || !id.trim()) throw Error('INVALID_ID: pass an inspiration id');
    const EF = this.mod(M.ef);
    if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    this.mod(M.inspirationBridge).markAgentInspirationUsed({ inspirationId: id.trim() });
    return { bound: id.trim(), next: 'save_project to keep it' };
  },
};

const METHODS = { tasks_list: 'tasksList', inspiration_detail: 'inspirationDetail', inspiration_bind: 'inspirationBind' };

module.exports = { methods, METHODS, activityExtra, slimTask };
