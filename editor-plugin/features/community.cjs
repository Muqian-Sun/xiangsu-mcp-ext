'use strict';
// Creator feeds of the user's account: inspirations and tasks from the editor's home window, and the
// rank boards of the 像塑 mobile app, which share the editor's backend; plus binding tasks and
// inspirations to a project the way the editor does. Requests go out like the home window's activity
// center sends them: the editor's login cookie plus its signing headers.
const { M } = require('./common.cjs');

// The activity center marks every task as an effect activity and rewrites task_type; the task detail
// window then launches projects with these fields (ActivityCenter/TaskDetailsWindow).
const EFFECT_ACTIVITY = 0;

// Rank boards of the mobile app's rank page (rank_type -> board name). 8 (特效优秀视频榜) is served by
// excellent_video_rank, which returns nothing for every rank type, so it is left out.
const RANK_TYPES = { 1: '年轻喜爱榜', 2: '特效每日投稿榜', 3: '男生喜爱榜', 4: '女生喜爱榜', 7: '热玩互动榜', 9: '模板每日投稿榜', 10: '特效跟拍榜' };
// The template board lists its entries under `templates` instead of `effects`.
const TEMPLATE_BOARD = 9;
// Options of the rank page's filter panel: label -> code, sent comma-joined under `param`.
const RANK_FILTERS = {
  levels: {
    param: 'effect_lv',
    options: { SSS: 1, SS: 2, S: 3, 'S-': 4, 'A+': 5, A: 6, 'B+': 7, B: 8, C: 9, D: 10, E: 11, F: 13, 'F+': 15, G: 14, 'G+': 16, H: 17, I: 18 },
  },
  panels: { param: 'panel_type', options: { 头饰: 1, 氛围: 2, 扮演: 3, 变形: 4, 游戏: 5, 测一测: 6, 新奇: 7, 美妆: 8, 场景: 9 } },
  preferences: { param: 'perf_type', options: { 友友: 5, 潮酷: 6 } },
  tools: { param: 'tool_type', options: { 像塑桌面端: 1, '轻颜 App': 3, 像塑移动版: 6 } },
};
const YOUNG_LIKE_SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LEVEL_LABELS = Object.fromEntries(Object.entries(RANK_FILTERS.levels.options).map(([label, code]) => [code, label]));
// A board category goes under the field of its level; the server takes one category per level.
const CATEGORY_PARAMS = { 1: 'material_labels3_first', 2: 'material_labels3_second', 3: 'material_labels3_third' };
// Innovation plan picks by artwork type (the app's ArtworkType index); the app itself shows templates.
const PICK_KINDS = { template: 2, effect: 0 };
// Topic collection tabs of the app's 专题合集 page (topic_type).
const SUBJECT_KINDS = { effect: 1, template: 2 };
// subjects and subject_detail answer code 1 for larger counts.
const SUBJECT_MAX = 20;
// The editor's task window page reads task details with this mobile app version.
const TASK_PAGE_APP_VERSION = '11.3.0';
// The server's 「网络开小差了」 code, seen once on a growth task detail that the next three tries
// returned; reads are retried once on it. The wait is picked, not measured (works search uses the same).
const BUSY_CODE = '1';
const BUSY_RETRY_MS = 500;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);
// Image structs inside these snake_case responses keep a camelCase urlList ({ uri, urlList, width, height }).
const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
// The inspiration page stores image sizes this way (its convertToDecimal).
const decimal = (n) => (typeof n === 'number' ? n.toFixed(1) : '0');

function requireId(v, what) {
  if ((typeof v !== 'string' && typeof v !== 'number') || !String(v).trim()) throw Error(`${what}: pass a non-empty id`);
  return String(v).trim();
}

// Inspiration and user ids exceed 2^53; such integers keep their source text.
function keepBigInts(key, value, context) {
  return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value;
}

async function request(lib, what, path, opts = {}) {
  let out = await send(lib, what, path, opts);
  if (out.code === BUSY_CODE && !opts.json && !opts.form) {
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
    out = await send(lib, what, path, opts);
  }
  if (out.code !== '0') throw Error(`${what}_FAILED: code=${out.code} message=${out.message}`);
  return out.data;
}

async function send(lib, what, path, { query = {}, json, form } = {}) {
  lib.ensureCompatible('community');
  const base = lib.mod(M.urls).Domain.kBackendApiURL;
  const utils = lib.mod(M.bizUtils);
  const headers = {
    cookie: await new (lib.mod(M.orionui).CookieManager)().getCookie(base),
    'x-api-sign-data': utils.PlatformUtils.genSignData(),
    'user-agent': utils.UserAgentUtils.userAgentGenerator()(),
  };
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const init = { method: 'GET', headers, signal: AbortSignal.timeout(15000) };
  if (json) {
    headers['content-type'] = 'application/json';
    Object.assign(init, { method: 'POST', body: JSON.stringify(json) });
  } else if (form) {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, String(v));
    Object.assign(init, { method: 'POST', body });
  }
  const res = await lib.fetch(url.href, init);
  const text = await res.text();
  if (!res.ok) throw Error(`${what}_FAILED: HTTP ${res.status}`);
  let out;
  try {
    out = JSON.parse(text, keepBigInts);
  } catch (_) {
    throw Error(`${what}_FAILED: response is not JSON`);
  }
  return { code: String(out.code), message: out.message || '', data: out.data };
}

function slimInspiration(i) {
  return {
    inspiration_id: String(i.id),
    title: i.title,
    tag: i.tag_desc || null,
    author: i.author_name || null,
    author_uid: str(i.author_uid),
    collect_count: i.total_collection ?? null,
    collected: !!i.is_collect,
    ai: !!i.is_ai_ins,
    cover_url: first(i.cover_img && i.cover_img.urlList),
  };
}

function tagNames(tags) {
  if (typeof tags === 'string') return tags.split(',').filter(Boolean);
  return (tags || []).map((t) => (t && t.name) || t).filter(Boolean);
}

const days = (ms) => (typeof ms === 'number' && ms >= 0 ? Math.floor(ms / 86400000) : null);

// Activities (kind activity) and effect tasks (kind task) from the activity center's two lists. A task
// is bound through its designer_task_id, which it only gets once received.
function slimTask(lib, t, kind) {
  const bindId = kind === 'task' ? t.designer_task_id : t.id;
  return {
    task_id: String(kind === 'task' ? t.task_id ?? t.item_id : t.id),
    kind,
    title: t.title || t.name || '',
    status: kind === 'task' ? lib.taskStatus(t.process_status) : null,
    status_text: t.process_status_text || null,
    received: kind === 'task' ? !!t.designer_task_id : null,
    bindable: !!bindId,
    tags: tagNames(t.tags),
    days_left: days(t.ttl),
    revenue: t.revenue ?? null,
    can_finish_times: t.can_fin_times ?? null,
    released_at: iso(t.release_at),
    offline_at: iso(t.offline_at),
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

function growthProjects(t) {
  return (t.project_data || []).map((p) => ({ project_id: String(p.project_id), desc: p.project_desc || '' }));
}

function slimRankItem(e, rank) {
  return {
    rank,
    effect_id: str(e.effect_id),
    app_effect_id: appEffectId(e),
    name: e.effect_name,
    icon_url: e.effect_icon || null,
    level: LEVEL_LABELS[e.effect_lv] ?? null,
    is_new: e.is_new_inc ?? null,
    pub_peak: e.peak_pub_val ?? null,
    pub_total: e.all_pub_val ?? null,
    follow_shoot: e.follow_shoot_pub_val ?? null,
    follow_shoot_30d: e.follow_shoot_pub_val_30d ?? null,
    follow_shoot_60d: e.follow_shoot_pub_val60d ?? null,
    male_rate: e.male_pub_rate ?? null,
    female_rate: e.female_pub_rate ?? null,
    young_like_score: e.young_like_score ?? null,
    male_like_score: e.male_like_score ?? null,
    hot_play_score: e.hot_play_score ?? null,
    revenue_total: e.effect_total_rev ?? e.total_rev ?? null,
  };
}

// Template ids overflow app_effect_id into a negative 32-bit number; app_effect_id_str carries the real
// one where the server sends it.
function appEffectId(e) {
  return str(e.app_effect_id_str ?? e.app_effect_id);
}

function slimSubject(s) {
  return {
    subject_id: String(s.subject_id),
    name: String(s.subject_name || '').trim(),
    subtitle: s.sub_title || null,
    online_at: iso(s.online_time),
    views: s.page_view_cnt ?? null,
    cover_url: s.subject_cover_pic || null,
    effects: (s.effects || []).map((e) => ({
      effect_id: str(e.effect_id),
      app_effect_id: appEffectId(e),
      name: e.effect_name,
      icon_url: e.effect_icon || null,
      description: e.effect_desc || '',
    })),
  };
}

function rankType(rank_type) {
  if (!hasOwn(RANK_TYPES, rank_type)) {
    throw Error(`INVALID_RANK_TYPE: ${rank_type}; valid: ${Object.entries(RANK_TYPES).map(([k, n]) => `${k}(${n})`).join(', ')}`);
  }
  return Number(rank_type);
}

function checkDate(date) {
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error(`INVALID_DATE: ${date}; expected YYYY-MM-DD`);
}

function filterCodes(key, labels) {
  const { options } = RANK_FILTERS[key];
  return labels.map((label) => {
    if (!hasOwn(options, label)) throw Error(`INVALID_FILTER(${key}): ${label}; valid: ${Object.keys(options).join(', ')}`);
    return options[label];
  });
}

const methods = {
  taskStatus(code) {
    return this.mod(M.activityTypes).TaskStatus[code] ?? null;
  },

  async inspirationNav() {
    const d = await request(this, 'GET_INSPIRATION_TABS', '/creator_api/inspiration/v1/tabs');
    if (!d.tab_names || !d.tab_names.length) throw Error('NO_INSPIRATION_TABS: the inspiration page returned no tabs');
    return { tabs: d.tab_names };
  },

  async inspirationList({ tab, cursor = 0, count = 20 } = {}) {
    const { tabs } = await this.inspirationNav();
    const name = tab === undefined ? tabs[0] : tab;
    if (!tabs.includes(name)) throw Error(`INVALID_TAB: ${name}; valid: ${tabs.join(', ')}`);
    // The inspiration page asks for its first page with flag 1 and for every later page with flag 2.
    const d = await request(this, 'GET_INSPIRATIONS', '/creator_api/inspiration/v1/list', {
      query: { flag: cursor === 0 ? 1 : 2, cursor, count, tab_name: name },
    });
    return { tab: name, items: (d.list || []).map(slimInspiration), next_cursor: d.cursor ?? null, has_more: !!d.has_more };
  },

  async inspirationCollected(id) {
    const item_type = this.mod(M.inspirationConst).IS_COLLECT_PARAMS_TYPE.Default;
    const d = await request(this, 'GET_COLLECT_STATE', '/creator_api/inspiration/v1/is_collected', { query: { item_id: id, item_type } });
    return !!d.is_collected;
  },

  // Detail plus collection state and count, the three requests the editor's inspiration panel makes.
  async inspirationRecord(id) {
    const [detail, collected, extra] = await Promise.all([
      request(this, 'GET_INSPIRATION', '/creator/v2/inspiration_detail', { query: { id } }),
      this.inspirationCollected(id),
      request(this, 'GET_INSPIRATION_EXTRA', '/creator_api/inspiration/v1/extra', { query: { id } }),
    ]);
    return { detail, collected, collect_count: extra.total_collection ?? null };
  },

  async inspirationDetail({ inspiration_id } = {}) {
    const id = requireId(inspiration_id, 'INVALID_INSPIRATION_ID');
    const { detail: d, collected, collect_count } = await this.inspirationRecord(id);
    const base = d.base || {};
    if (!base.id) throw Error(`INSPIRATION_NOT_FOUND: ${id}`);
    const hot = d.ai_hotspot_info || {};
    return {
      inspiration_id: id,
      title: base.title,
      description: base.detail_desc || '',
      tag: base.tag_desc || null,
      effect_types: (base.effect_types || []).map((t) => t.name),
      bonus_text: base.bonus_text || null,
      images: (base.imgs || []).map((i) => first(i.urlList)).filter(Boolean),
      author: d.designer ? { uid: str(d.designer.uid), name: d.designer.name } : null,
      award: d.award && d.award.amount ? { amount: d.award.amount, text: d.award.text || '', desc: d.award.desc || '' } : null,
      hotspot: hot.title ? { title: hot.title, score: str(hot.score) } : null,
      project: d.project_info && d.project_info.title ? { title: d.project_info.title, desc: d.project_info.desc || '' } : null,
      effects: (d.effects || []).map((e) => ({ name: e.name, published: e.total_pub_num ?? null })),
      videos: (d.videos || []).length,
      collected,
      collect_count,
    };
  },

  // The editor's own agent hook: records the inspiration on the open project (saved with it).
  inspirationBind({ inspiration_id } = {}) {
    this.ensureCompatible('community');
    const id = requireId(inspiration_id, 'INVALID_INSPIRATION_ID');
    const EF = this.mod(M.ef);
    if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    this.mod(M.inspirationBridge).markAgentInspirationUsed({ inspirationId: id });
    return { bound: id, next: 'save_project to keep it' };
  },

  async inspirationCollect({ inspiration_id, collect = true } = {}) {
    const id = requireId(inspiration_id, 'INVALID_INSPIRATION_ID');
    const { detail: d, collect_count } = await this.inspirationRecord(id);
    const base = d.base || {};
    const img = first(base.imgs) || {};
    const designer = d.designer || {};
    // The card the inspiration page stores with a collection; the collection list renders from it.
    const extra = {
      img_url: first(img.urlList),
      img_width: decimal(img.width),
      img_height: decimal(img.height),
      tag_desc: base.tag_desc || '',
      author: designer.name,
      avatar: designer.avatar,
      collect_num: collect_count,
    };
    const item_type = this.mod(M.inspirationConst).IS_COLLECT_PARAMS_TYPE.Default;
    await request(this, 'COLLECT_INSPIRATION', '/creator_api/inspiration/v1/collect', {
      json: { item_id: id, item_name: base.title, item_type, action: collect ? 1 : 0, extra: JSON.stringify(extra) },
    });
    const now = await this.inspirationCollected(id);
    if (now !== !!collect) throw Error(`COLLECT_NOT_APPLIED: inspiration ${id} is ${now ? 'still' : 'not'} collected`);
    return { inspiration_id: id, title: base.title, collected: now };
  },

  // kind=effect: the activity center's activities and effect tasks; kind=growth: its growth tasks.
  // raw goes to the MCP server, which keeps it for task_detail, task_receive and task_bind.
  async tasksList({ kind = 'effect' } = {}) {
    const { DomainPath } = this.mod(M.urls);
    if (kind === 'effect') {
      const [acts, tasks] = await Promise.all([
        request(this, 'GET_ACTIVITIES', DomainPath.kActivityAPI),
        request(this, 'GET_EFFECT_TASKS', DomainPath.kTaskListAPI),
      ]);
      const rows = [...(acts.activities || []).map((t) => ['activity', t]), ...(tasks.effect_tasks || []).map((t) => ['task', t])];
      const items = rows.map(([k, t]) => slimTask(this, t, k));
      const raw = rows.map(([k, t]) => ({
        kind: k,
        item_id: k === 'task' ? String(t.item_id) : null,
        extra: (k === 'task' ? t.designer_task_id : t.id) ? activityExtra(this, t, k) : null,
      }));
      return { kind, items, raw };
    }
    if (kind === 'growth') {
      const { growthTaskType } = this.mod(M.activityTypes);
      const d = await request(this, 'GET_GROWTH_TASKS', DomainPath.kGrowthTaskList);
      const tasks = d.growth_tasks || [];
      const items = tasks.map((t) => ({
        task_id: String(t.task_id),
        kind: 'growth',
        title: t.name || '',
        // fen: 1000 comes with the tag 「10元奖励」
        bonus_yuan: t.bonus_amount != null ? t.bonus_amount / 100 : null,
        tags: t.tags || [],
        newbie: t.growth_task_type === growthTaskType.Newbie,
        bindable: false,
        projects: growthProjects(t),
        icon_url: t.icon || null,
      }));
      return { kind, items, raw: tasks.map(() => ({ kind: 'growth', item_id: null, extra: null })) };
    }
    throw Error(`INVALID_KIND: ${kind}; valid: effect, growth`);
  },

  async taskDetail({ kind, id } = {}) {
    const key = requireId(id, 'INVALID_TASK_ID');
    if (kind === 'task') {
      const query = { item_id: key, app_version: TASK_PAGE_APP_VERSION };
      const [d, c] = await Promise.all([
        request(this, 'GET_EFFECT_TASK', '/effectcam/v2/effect_task_detail', { query }),
        request(this, 'GET_EFFECT_TASK_CONTENT', '/effectcam/v2/effect_task_content', { query }),
      ]);
      return {
        kind,
        title: d.title,
        status: this.taskStatus(d.process_status),
        status_text: d.s_desc || null,
        tags: (d.tags || []).map((x) => x.name),
        reward_begin: d.reward_begin || null,
        reward_end: d.reward_end || null,
        offline_at: iso(d.offline_at_unix),
        can_finish_times: d.can_fin_times ?? null,
        content: (c.modules || []).map((m) => JSON.parse(m.render_content)),
      };
    }
    if (kind === 'growth') {
      const d = await request(this, 'GET_GROWTH_TASK', '/cam_api/task/v1/growth_task_detail', { query: { task_id: key } });
      return {
        kind,
        title: d.name || '',
        bonus_yuan: d.bonus_amount != null ? d.bonus_amount / 100 : null,
        tags: d.tags || [],
        projects: growthProjects(d),
        inspirations: (d.inspiration_list || []).map(slimInspiration),
        tutorial: d.tutorial_title ? { title: d.tutorial_title, desc: d.tutorial_desc || '', video_url: d.tutorial_video_url || null } : null,
      };
    }
    throw Error(`INVALID_KIND: ${kind}; valid: task, growth`);
  },

  // Same request as the activity center's 领取 button, which it only offers while the task waits to be received.
  async taskReceive({ item_id } = {}) {
    const id = requireId(item_id, 'INVALID_ITEM_ID');
    const { TaskStatus } = this.mod(M.activityTypes);
    const d = await request(this, 'GET_EFFECT_TASKS', this.mod(M.urls).DomainPath.kTaskListAPI);
    const t = (d.effect_tasks || []).find((x) => String(x.item_id) === id);
    if (!t) throw Error(`UNKNOWN_TASK: ${id} is not in the effect task list`);
    if (t.process_status !== TaskStatus.WAIT_RECEIVE) throw Error(`TASK_NOT_RECEIVABLE: ${id} status=${this.taskStatus(t.process_status)}`);
    const r = await request(this, 'RECEIVE_TASK', '/creator/v1/receive_task', { form: { id: t.receive_id } });
    if (!r || !r.designer_task_id) throw Error(`RECEIVE_TASK_FAILED: task ${id} returned no designer_task_id`);
    return {
      title: t.title,
      designer_task_id: String(r.designer_task_id),
      status: this.taskStatus(r.process_status ?? TaskStatus.WAIT_SUBMIT),
    };
  },

  async rankCategories(rank_type, date) {
    const d = await request(this, 'GET_RANK_CATEGORIES', '/cam_api/rank/v1/tag', { query: { rank_type, date } });
    return d.map((t) => ({ name: t.tagName, level: t.level, count: t.num }));
  },

  async rankNav({ rank_type = 1, date } = {}) {
    const rt = rankType(rank_type);
    checkDate(date);
    const filters = Object.fromEntries(Object.entries(RANK_FILTERS).map(([key, f]) => [key, Object.keys(f.options)]));
    return {
      rank_types: Object.entries(RANK_TYPES).map(([k, name]) => ({ rank_type: Number(k), name })),
      filters: { ...filters, young_like_scores: YOUNG_LIKE_SCORES },
      rank_type: rt,
      categories: await this.rankCategories(rt, date),
    };
  },

  async rankList(params = {}) {
    const { rank_type = 1, date, categories, young_like_scores, cursor = 0, count = 20 } = params;
    const rt = rankType(rank_type);
    checkDate(date);
    const query = { rank_type: rt, date, cursor, count };
    for (const [key, f] of Object.entries(RANK_FILTERS)) {
      if (params[key] && params[key].length) query[f.param] = filterCodes(key, params[key]).join(',');
    }
    if (young_like_scores && young_like_scores.length) {
      for (const s of young_like_scores) if (!YOUNG_LIKE_SCORES.includes(s)) throw Error(`INVALID_FILTER(young_like_scores): ${s}; valid: 1-10`);
      query.young_like_score = young_like_scores.join(',');
    }
    if (categories && categories.length) {
      const known = await this.rankCategories(rt, date);
      for (const name of categories) {
        const hit = known.find((c) => c.name === name);
        if (!hit) throw Error(`INVALID_CATEGORY: ${name}; valid: ${known.map((c) => c.name).join(', ')}`);
        if (!hasOwn(CATEGORY_PARAMS, hit.level)) throw Error(`UNSUPPORTED_CATEGORY_LEVEL: ${name} has level ${hit.level}`);
        const param = CATEGORY_PARAMS[hit.level];
        if (query[param] !== undefined) throw Error(`ONE_CATEGORY_PER_LEVEL: ${query[param]} and ${name} are both level ${hit.level}`);
        query[param] = name;
      }
    }
    const d = await request(this, 'GET_RANK', '/cam_api/rank/v1/detail', { query });
    const list = (rt === TEMPLATE_BOARD ? d.templates : d.effects) || [];
    return {
      rank_type: rt,
      name: RANK_TYPES[rt],
      date: d.date,
      updated_at: d.update_time || null,
      total: d.total,
      items: list.map((e, i) => slimRankItem(e, cursor + i + 1)),
      next_cursor: d.cursor,
      has_more: d.cursor < d.total,
    };
  },

  async rankHotspots({ count, topic_id } = {}) {
    if (topic_id !== undefined) {
      const id = requireId(topic_id, 'INVALID_TOPIC_ID');
      const d = await request(this, 'GET_HOTSPOT_INSPIRATIONS', '/cam_api/hotspot/v1/insp_tabs', { query: { topic_id: id } });
      const tabs = (d.insp_tabs || []).map((t) => ({
        tab: t.title,
        inspirations: (t.insps || []).map((i) => ({
          inspiration_id: String(i.id),
          title: i.title,
          tag: i.tag || null,
          description: i.detail || '',
          cover_url: first(i.cover && i.cover.urlList),
        })),
      }));
      return { topic_id: id, tabs };
    }
    const d = await request(this, 'GET_HOTSPOTS', '/cam_api/hotspot/v1/rank', { query: { count } });
    // Hotspots arrive ordered by heat; rank_num is not their position.
    const items = (d.hotspots || []).map((h, i) => ({
      rank: i + 1,
      topic_id: String(h.topic_id),
      title: h.title,
      description: h.description || '',
      heat: h.hot_core ?? null,
      heat_text: first(h.tags),
      inspirations_text: h.subtitle_text || null,
      cover_url: first(h.cover && h.cover.urlList),
    }));
    return { rank_time: d.rank_time || null, subtitle: d.subtitle || null, items };
  },

  async subjectPage(kind, cursor, count) {
    const d = await request(this, 'GET_SUBJECTS', '/cam_api/discover/v1/subjects', { query: { cursor, count, type: SUBJECT_KINDS[kind] } });
    // Past the last page the server answers code 0 without data.
    return { total: d ? d.total : null, subjects: (d && d.subjects) || [] };
  },

  // The 专题合集 page: monthly themed boards, newest first. `cursor` is an offset the server echoes back.
  async rankSubjects({ subject_id, kind = 'effect', keyword, cursor = 0, count = SUBJECT_MAX } = {}) {
    if (subject_id !== undefined) {
      const id = requireId(subject_id, 'INVALID_SUBJECT_ID');
      const d = await request(this, 'GET_SUBJECT', '/cam_api/discover/v1/subject_detail', { query: { subject_id: id, cursor: 0, count: SUBJECT_MAX } });
      return slimSubject(d.subject);
    }
    if (!hasOwn(SUBJECT_KINDS, kind)) throw Error(`INVALID_KIND: ${kind}; valid: ${Object.keys(SUBJECT_KINDS).join(', ')}`);
    if (keyword !== undefined) {
      const q = String(keyword).trim();
      if (!q) throw Error('INVALID_KEYWORD: keyword must be a non-empty string');
      const all = [];
      for (let at = 0; ; at += SUBJECT_MAX) {
        const page = await this.subjectPage(kind, at, SUBJECT_MAX);
        all.push(...page.subjects);
        if (page.subjects.length < SUBJECT_MAX) break;
      }
      const subjects = all.filter((s) => String(s.subject_name || '').includes(q)).map(slimSubject);
      return { kind, keyword: q, total: subjects.length, subjects };
    }
    const page = await this.subjectPage(kind, cursor, count);
    const next = cursor + page.subjects.length;
    return { kind, total: page.total, subjects: page.subjects.map(slimSubject), next_cursor: next, has_more: page.total !== null && next < page.total };
  },

  async rankCreatorsMonth() {
    const d = await request(this, 'GET_CREATOR_MONTH_RANK', '/cam_api/innovation_plan/v1/user_month_rank');
    const items = d.map((u) => ({
      rank: u.rank_no,
      uid: String(u.uid),
      name: u.username,
      avatar_url: u.avatar || null,
      material_count: u.material_cnt ?? null,
      follow_pub: u.display_follow_pub ?? null,
      follow_pub_count: u.follow_pub_val ?? null,
      award_text: u.display_val || null,
      // fen: 300000 comes with 「预计奖3000元」
      award_yuan: u.award_num != null ? u.award_num / 100 : null,
    }));
    return { items };
  },

  async rankInnovationPicks({ kind = 'template', offset = 0, count = 20 } = {}) {
    if (!hasOwn(PICK_KINDS, kind)) throw Error(`INVALID_KIND: ${kind}; valid: ${Object.keys(PICK_KINDS).join(', ')}`);
    const d = await request(this, 'GET_INNOVATION_PICKS', '/cam_api/innovation_plan/v1/rank_list', {
      query: { page_size: count, offset, tab_id: 'all', artwork_type: PICK_KINDS[kind] },
    });
    const items = (d.effect_list || []).map((e) => ({
      effect_id: str(e.effect_id_str),
      app_effect_id: str(e.app_effect_id_str),
      name: e.name,
      icon_url: e.icon || null,
      label: e.label || null,
      pub_count: e.pub_val ?? null,
      revenue_total: e.total_rev ?? null,
      reviewed_on: e.review_date || null,
      cover_url: e.cover_img || null,
      video_item_id: str(e.video_item_id),
    }));
    // offset counts the server's entries before it filters a page, so a page can hold fewer than `count`.
    return { kind, date: d.date || null, total: d.total, items, next_offset: offset + count, has_more: !!d.has_more };
  },
};

const METHODS = {
  inspiration_nav: 'inspirationNav',
  inspiration_list: 'inspirationList',
  inspiration_detail: 'inspirationDetail',
  inspiration_collect: 'inspirationCollect',
  inspiration_bind: 'inspirationBind',
  tasks_list: 'tasksList',
  task_detail: 'taskDetail',
  task_receive: 'taskReceive',
  rank_nav: 'rankNav',
  rank_list: 'rankList',
  rank_hotspots: 'rankHotspots',
  rank_subjects: 'rankSubjects',
  rank_creators_month: 'rankCreatorsMonth',
  rank_innovation_picks: 'rankInnovationPicks',
};

module.exports = { methods, METHODS, PICK_KINDS, SUBJECT_KINDS };
