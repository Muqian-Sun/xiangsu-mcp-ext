'use strict';
// Homepage works (the home window's template panel: official projects and user-submitted works),
// browsed and downloaded through the home window's own request and download modules.
const fs = require('fs');
const { M, body } = require('./common.cjs');

const PANEL_KEY = 'tool_template';
// commonInterface.Ranker
const SORT = { suggest: 1, latest: 2, effect_usage: 3, project_usage: 4 };

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

  rememberWorks(items) {
    const transform = this.mod(M.worksUtil).transformTemplate;
    for (const t of items) if (t && t.templateId) this.works.set(String(t.templateId), t);
    return items.filter((t) => t && t.templateId).map((t) => slimWork(t, transform));
  },

  async worksList({ category_id, cursor = 0, count = 30, sort } = {}) {
    const ranker = sortValue(sort);
    const category = await this.worksCategory(category_id);
    const data = body(
      await this.mod(M.worksCategory).apiTemplatesCategory({ cursor, count, panelKey: PANEL_KEY, categoryId: category.id, ranker, getCollectStatus: true }),
      'GET_WORKS_LIST',
    );
    const info = data.dataInfos || {};
    return { category, items: this.rememberWorks(info.template || []), next_cursor: info.cursor ?? null, has_more: !!info.hasNext };
  },

  // Same request the homepage search box sends: scoped to one category, matched on the project name.
  async worksSearch({ query, category_id, cursor = 0, count = 30, sort } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw Error('INVALID_QUERY: query must be a non-empty string');
    const ranker = sortValue(sort);
    const category = await this.worksCategory(category_id);
    const q = query.trim();
    const data = body(
      await this.mod(M.worksCategory).apiSearchTemplatesCategory({
        cursor,
        count,
        panelKey: PANEL_KEY,
        categoryId: category.id,
        ranker,
        getCollectStatus: true,
        searchWord: q,
        searchType: 0,
      }),
      'SEARCH_WORKS',
    );
    const info = data.dataInfos || {};
    return { query: q, category, items: this.rememberWorks(info.template || []), next_cursor: info.cursor ?? null, has_more: !!info.hasNext };
  },

  workItem(template_id) {
    const t = this.works.get(String(template_id));
    if (!t) throw Error(`UNKNOWN_WORK: ${template_id}; call works_list or works_search first`);
    return t;
  },

  worksCovers({ template_ids }) {
    if (!Array.isArray(template_ids) || !template_ids.length || template_ids.length > 8) throw Error('INVALID_TEMPLATE_IDS: pass 1-8 template ids');
    const transform = this.mod(M.worksUtil).transformTemplate;
    return template_ids.map((id) => {
      const s = slimWork(this.workItem(id), transform);
      return { template_id: s.template_id, title: s.title, cover_url: s.cover_url, gif_url: s.gif_url };
    });
  },

  // Downloads the project zip (into the editor's LokiDownload/TemplateResources cache) and unzips a
  // fresh copy into the instance's ProjectCreatedTmp/CreatedFromTemplate, exactly as opening a work
  // from the homepage does; the project itself is not opened.
  async worksDownload({ template_id }) {
    this.ensureCompatible('works');
    const t = this.workItem(template_id);
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
  works_covers: 'worksCovers',
  works_download: 'worksDownload',
};

module.exports = { methods, METHODS, SORT };
