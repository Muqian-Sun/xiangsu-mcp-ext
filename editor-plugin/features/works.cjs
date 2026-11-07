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
    return { items: raw.map((t) => slimWork(t, transform)), raw, next_cursor: info.cursor ?? null, has_more: !!info.hasNext };
  },

  async worksList({ category_id, cursor = 0, count = 30, sort } = {}) {
    const ranker = sortValue(sort);
    const category = await this.worksCategory(category_id);
    const data = body(
      await this.mod(M.worksCategory).apiTemplatesCategory({ cursor, count, panelKey: PANEL_KEY, categoryId: category.id, ranker, getCollectStatus: true }),
      'GET_WORKS_LIST',
    );
    return { category, ...this.worksPage(data.dataInfos || {}) };
  },

  // Same request the homepage search box sends, scoped to one category.
  async worksSearchPage(category, word, by, { cursor = 0, count = 30, ranker = SORT.suggest } = {}) {
    const params = { cursor, count, panelKey: PANEL_KEY, categoryId: category.id, ranker, getCollectStatus: true, searchWord: word, searchType: SEARCH_BY[by] };
    let res;
    for (let i = 0; ; i++) {
      res = await this.mod(M.worksCategory).apiSearchTemplatesCategory(params);
      if (!(res && res.body && res.body.statusCode === SEARCH_BUSY) || i === SEARCH_RETRIES) break;
      await new Promise((r) => setTimeout(r, SEARCH_RETRY_MS));
    }
    return this.worksPage(body(res, 'SEARCH_WORKS').dataInfos || {});
  },

  // Matched on the project name, like the homepage search box's default 特效名称 option.
  async worksSearch({ query, category_id, cursor, count, sort } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw Error('INVALID_QUERY: query must be a non-empty string');
    const ranker = sortValue(sort);
    const category = await this.worksCategory(category_id);
    const q = query.trim();
    return { query: q, category, ...(await this.worksSearchPage(category, q, 'name', { cursor, count, ranker })) };
  },

  // Effects (effect_id and optional name, as rank boards list them) looked up one by one with the
  // homepage's 特效ID search. A work matches an effect only on its effect_id. An effect without one may
  // still have homepage works of the same name (another creator's copy, or a re-upload); those come
  // back as same_name candidates, never as the effect itself.
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

module.exports = { methods, METHODS, SORT, MAX_EFFECTS };
