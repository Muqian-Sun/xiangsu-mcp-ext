'use strict';
// Homepage works (the home window's template panel: official projects and user-submitted works),
// browsed and downloaded through the home window's own request and download modules.
const fs = require('fs');
const { M, body } = require('./common.cjs');

const PANEL_KEY = 'tool_template';
// commonInterface.Ranker
const SORT = { suggest: 1, latest: 2, effect_usage: 3, project_usage: 4 };
// commonInterface.SearchType: the homepage search box's 特效名称 and 特效ID options.
const SEARCH_BY = { name: 1, effect_id: 2 };
// Rank boards serve 20 effects a page; one lookup takes one or two requests per effect.
const MAX_EFFECTS = 20;
// The search now and then answers statusCode 28 (调用 搜索 RPC接口失败) to a request that succeeds when
// sent again: 3 times in about 400 live requests on 2026-11-07. Picked, not measured: 2 retries 500 ms apart.
const SEARCH_BUSY = 28;
const SEARCH_RETRIES = 2;
const SEARCH_RETRY_MS = 500;
// Measured on 2026-11-07: a search in 推荐 stops after about 300 matches (6 pages of 50), and the other
// categories hold works 推荐 never returns. A search therefore asks every category, each up to this many.
const SEARCH_CAP = 300;
const SEARCH_PAGE = 50;
// Picked, not measured beyond the runs noted at worksSearchAll: one more pass when the first falls short.
const SEARCH_PASSES = 2;
const MAX_TERMS = 8;
// Picked, not measured: long enough to page through one search, short enough that new works show up.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 20;

// The homepage pages with the cursor plus the previous page's sortingPosition and version, as the home
// window's GeneralTemplatesListModel sends them; with the cursor alone every page is the first one again.
function pageState(info) {
  if (!info.hasNext) return null;
  const state = { cursor: info.cursor };
  if (info.sortingPosition !== undefined) state.sortingPosition = info.sortingPosition;
  if (info.version !== undefined) state.version = info.version;
  return state;
}

const encodeCursor = (state) => (state ? Buffer.from(JSON.stringify(state)).toString('base64url') : null);

function decodeCursor(cursor) {
  if (cursor === undefined) return { cursor: 0 };
  let state;
  try {
    state = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch (_) {
    state = null;
  }
  if (!state || !Number.isInteger(state.cursor) || state.cursor < 0) throw Error(`INVALID_CURSOR: ${cursor}; pass the previous page's next_cursor as is`);
  return state;
}

function slimWork(t, transform) {
  const w = transform(t, '');
  const ugc = w.ugcExtraInfoObj || {};
  return {
    template_id: String(t.templateId),
    title: t.title,
    description: w.description || t.desc || '',
    tags: w.tags || [],
    creator: w.creatorName || null,
    effect_id: w.effectId ? String(w.effectId) : null,
    publish_count: ugc.publish_count ?? null,
    use_count: w.bindMaterialUseCnt ?? null,
    file_size: w.fileSize ?? null,
    cover_url: w.coverPath || w.backupCoverPath || null,
    gif_url: w.gifPath || null,
    tutorial: w.tutorial || null,
  };
}

function sortValue(sort = 'suggest') {
  if (!Object.prototype.hasOwnProperty.call(SORT, sort)) throw Error(`INVALID_SORT: ${sort}; valid: ${Object.keys(SORT).join(', ')}`);
  return SORT[sort];
}

const methods = {
  async worksNav() {
    this.ensureCompatible('works');
    const data = body(await this.mod(M.worksPanel).apiTemplatesPanel({ cursor: 0, count: 100, panelKey: PANEL_KEY }), 'GET_WORKS_PANEL');
    const categories = (data.categories || []).map((c) => ({ id: String(c.id), name: c.name }));
    if (!categories.length) throw Error('NO_CATEGORIES: the homepage panel returned no categories');
    return { categories, sorts: Object.keys(SORT) };
  },

  async worksCategory(category_id) {
    const { categories } = await this.worksNav();
    if (category_id === undefined) return categories[0];
    const hit = categories.find((c) => c.id === String(category_id));
    if (!hit) throw Error(`INVALID_CATEGORY_ID: ${category_id}; valid: ${categories.map((c) => `${c.id}(${c.name})`).join(', ')}`);
    return hit;
  },

  // Windows come and go while an agent works, so the plugin keeps no works state: the raw records go
  // back with the slim items and the MCP server hands one back to works_download.
  worksPage(info) {
    const transform = this.mod(M.worksUtil).transformTemplate;
    const raw = (info.template || []).filter((t) => t && t.templateId);
    const next = pageState(info);
    return { items: raw.map((t) => slimWork(t, transform)), raw, next, has_more: !!next };
  },

  async worksList({ category_id, cursor, count = 30, sort } = {}) {
    const ranker = sortValue(sort);
    const state = decodeCursor(cursor);
    const category = await this.worksCategory(category_id);
    const data = body(
      await this.mod(M.worksCategory).apiTemplatesCategory({ ...state, count, panelKey: PANEL_KEY, categoryId: category.id, ranker, getCollectStatus: true }),
      'GET_WORKS_LIST',
    );
    const { next, ...page } = this.worksPage(data.dataInfos || {});
    return { category, ...page, next_cursor: encodeCursor(next) };
  },

  // Same request the homepage search box sends, scoped to one category; `state` is where the page starts.
  async worksSearchPage(category, word, by, { state = { cursor: 0 }, count = SEARCH_PAGE, ranker = SORT.suggest } = {}) {
    const params = { ...state, count, panelKey: PANEL_KEY, categoryId: category.id, ranker, getCollectStatus: true, searchWord: word, searchType: SEARCH_BY[by] };
    let res;
    for (let i = 0; ; i++) {
      res = await this.mod(M.worksCategory).apiSearchTemplatesCategory(params);
      if (!(res && res.body && res.body.statusCode === SEARCH_BUSY) || i === SEARCH_RETRIES) break;
      await new Promise((r) => setTimeout(r, SEARCH_RETRY_MS));
    }
    return this.worksPage(body(res, 'SEARCH_WORKS').dataInfos || {});
  },

  // Every match of `word` in one category, up to SEARCH_CAP, in the server's order. The server now and
  // then ends a pass early (6 passes of 头套 in 推荐 on 2026-11-07: five reached the cap, one stopped at
  // 249; another stopped at 84), so a pass short of the cap is run once more and the two are merged.
  async worksSearchAll(category, word, by, ranker) {
    const items = [];
    const raw = [];
    const seen = new Set();
    let stalled = false;
    for (let pass = 0; pass < SEARCH_PASSES && items.length < SEARCH_CAP; pass++) {
      const inPass = new Set();
      let state = { cursor: 0 };
      stalled = false;
      while (state && items.length < SEARCH_CAP) {
        const page = await this.worksSearchPage(category, word, by, { state, ranker });
        const before = inPass.size;
        page.items.forEach((w, i) => {
          inPass.add(w.template_id);
          if (seen.has(w.template_id)) return;
          seen.add(w.template_id);
          items.push(w);
          raw.push(page.raw[i]);
        });
        // A page with nothing this pass has not seen means the server is handing the same page back.
        stalled = !!page.next && inPass.size === before;
        state = stalled ? null : page.next;
      }
    }
    return { items: items.slice(0, SEARCH_CAP), raw: raw.slice(0, SEARCH_CAP), stalled };
  },

  // Matched on the project name, like the homepage search box's default 特效名称 option. Without a
  // category every category is searched; works are merged in the order 推荐 returns them, then the
  // ones only other categories have, category by category (sort applies within each category).
  async worksSearch({ query, queries, category_id, offset = 0, count = 30, sort } = {}) {
    if (query !== undefined && queries !== undefined) throw Error('INVALID_QUERY: pass query or queries, not both');
    const list = queries !== undefined ? queries : query !== undefined ? [query] : [];
    if (!Array.isArray(list) || !list.length || list.length > MAX_TERMS) throw Error(`INVALID_QUERY: pass query, or 1-${MAX_TERMS} queries`);
    const terms = list.map((q) => (typeof q === 'string' ? q.trim() : ''));
    if (terms.some((q) => !q)) throw Error('INVALID_QUERY: every query must be a non-empty string');
    const unique = [...new Set(terms)];
    const ranker = sortValue(sort);
    const categories = category_id === undefined ? (await this.worksNav()).categories : [await this.worksCategory(category_id)];
    const key = JSON.stringify({ unique, category_id, ranker });
    this.worksCache = this.worksCache || new Map();
    const hit = this.worksCache.get(key);
    let merged = hit && Date.now() - hit.at < CACHE_MS ? hit.value : null;
    if (!merged) {
      const rows = new Map();
      const incomplete = new Set();
      for (const term of unique) {
        const found = await Promise.all(categories.map((c) => this.worksSearchAll(c, term, 'name', ranker)));
        found.forEach((page, k) => page.stalled && incomplete.add(categories[k].name));
        found.forEach((page, k) =>
          page.items.forEach((w, i) => {
            const row = rows.get(w.template_id) || { w, raw: page.raw[i], found_in: new Set(), matched: new Set() };
            row.found_in.add(categories[k].name);
            row.matched.add(term);
            rows.set(w.template_id, row);
          }),
        );
      }
      const all = [...rows.values()];
      const counts = categories.map((c) => ({ id: c.id, name: c.name, count: all.filter((r) => r.found_in.has(c.name)).length }));
      merged = {
        items: all.map((r) => ({ ...r.w, found_in: [...r.found_in], ...(queries !== undefined ? { matched_queries: [...r.matched] } : {}) })),
        raw: all.map((r) => r.raw),
        by_category: counts.filter((c) => c.count),
        incomplete: [...incomplete],
      };
      this.worksCache.set(key, { at: Date.now(), value: merged });
      while (this.worksCache.size > CACHE_ENTRIES) this.worksCache.delete(this.worksCache.keys().next().value);
    }
    const end = offset + count;
    return {
      ...(queries !== undefined ? { queries: unique } : { query: unique[0] }),
      ...(category_id !== undefined ? { category: categories[0] } : {}),
      total: merged.items.length,
      items: merged.items.slice(offset, end),
      raw: merged.raw.slice(offset, end),
      next_offset: end < merged.items.length ? end : null,
      has_more: end < merged.items.length,
      by_category: merged.by_category,
      ...(merged.incomplete.length ? { incomplete: merged.incomplete } : {}),
    };
  },

  // Effects (effect_id and optional name, as rank boards list them) looked up one by one with the
  // homepage's 特效ID search. A work matches an effect only on its effect_id. An effect without one may
  // still have homepage works of the same name (another creator's copy, or a re-upload); those come
  // back as same_name candidates, never as the effect itself. Unlike the name search, the 特效ID search
  // in 推荐 covers works the name search only finds in other categories (8 of 8 checked on 2026-11-07;
  // the same ids searched in their own category found none), so 推荐 alone is asked.
  async worksByEffect({ effects, category_id } = {}) {
    if (!Array.isArray(effects) || !effects.length || effects.length > MAX_EFFECTS) throw Error(`INVALID_EFFECTS: pass 1-${MAX_EFFECTS} effects`);
    const items = [];
    const raw = [];
    // Keeps the works of a page that pass `keep`, once each, and returns their template ids.
    const take = (page, keep) => {
      const ids = [];
      page.items.forEach((w, i) => {
        if (!keep(w)) return;
        if (!items.some((x) => x.template_id === w.template_id)) items.push(w), raw.push(page.raw[i]);
        ids.push(w.template_id);
      });
      return ids;
    };
    const wanted = effects.map((e) => {
      const id = String((e && e.effect_id) || '').trim();
      if (!/^\d+$/.test(id)) throw Error(`INVALID_EFFECT_ID: ${e && e.effect_id}`);
      return { id, name: e.name === undefined ? null : String(e.name).trim() || null };
    });
    const category = await this.worksCategory(category_id);
    const out = [];
    for (const { id, name } of wanted) {
      const found = take(await this.worksSearchPage(category, id, 'effect_id'), (w) => w.effect_id === id);
      if (found.length) {
        out.push({ effect_id: id, name, status: 'found', template_ids: found });
        continue;
      }
      const same = name ? take(await this.worksSearchPage(category, name, 'name'), (w) => w.title === name) : [];
      out.push({ effect_id: id, name, status: same.length ? 'same_name' : 'not_on_homepage', template_ids: same });
    }
    return { category, effects: out, items, raw };
  },

  // Downloads the project zip (into the editor's LokiDownload/TemplateResources cache) and unzips a
  // fresh copy into the instance's ProjectCreatedTmp/CreatedFromTemplate, exactly as opening a work
  // from the homepage does; the project itself is not opened. `item` is a raw record from works_list /
  // works_search / works_by_effect.
  async worksDownload({ item: t }) {
    this.ensureCompatible('works');
    if (!t || !t.templateId) throw Error('INVALID_WORK: pass the raw work record returned by works_list / works_search / works_by_effect');
    if (!Object.values((t.businessExtra && t.businessExtra.fileMap) || {}).some((f) => f && f.url)) {
      throw Error(`NO_PACKAGE_FILE: work ${t.templateId} has no downloadable project`);
    }
    const model = new (this.mod(M.worksDownload).DownloadTemplateModel)();
    const zip = model.getTemplateProjectPath(String(t.templateId));
    // A zip already cached belongs to the user's own homepage use; one this call downloads is removed
    // once unzipped (with the partial .tmp a failed download leaves) so nothing lingers.
    const cached = fs.existsSync(zip);
    let res;
    try {
      res = await model.startDownload({ ...t, templateID: String(t.templateId), name: t.title });
    } finally {
      if (typeof model.destroy === 'function') model.destroy();
      if (!cached) for (const f of [zip, zip.replace(/\.zip$/, '.tmp')]) fs.rmSync(f, { force: true });
    }
    if (!res || res.status !== 'success' || !res.unzipPath) {
      throw Error(`WORK_DOWNLOAD_FAILED: work ${t.templateId} status=${res && res.status} stage=${(res && res.errorInfo) || ''}`);
    }
    return { template_id: String(t.templateId), title: t.title, project_path: res.unzipPath, package_cached: cached };
  },
};

const METHODS = {
  works_nav: 'worksNav',
  works_list: 'worksList',
  works_search: 'worksSearch',
  works_by_effect: 'worksByEffect',
  works_download: 'worksDownload',
};

module.exports = { methods, METHODS, SORT, MAX_EFFECTS, MAX_TERMS };
