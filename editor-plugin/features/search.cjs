'use strict';
// Asset library search. The server search matches titles only, and many assets are named without the
// word people look for (美妆 › 腮红 holds 「雾堇胭」「红玫瑰」…; nothing is titled 滤镜). So a term that
// names a panel or a sub-category also brings in that panel's or category's assets, and results are
// ranked by how well the title matches.
const { M, body } = require('./common.cjs');
const { SQUARE_PANEL, COLLECTION_PANEL } = require('./square.cjs');

const MAX_TERMS = 8;
// Picked, not measured: categories measured live hold 17-125 assets, so this rarely cuts anything; a
// whole panel is cut at the same size.
const SOURCE_CAP = 300;
// The list API answers up to 100 a page (library_list's limit).
const LIST_PAGE = 100;
// Picked, not measured: long enough to page through one search, short enough that new assets show up.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 20;

// Lower is better. A title match outranks a category match; what the server returned without the
// term in the title (it matches loosely now and then) comes last.
const TIER = { exact: 0, prefix: 1, contains: 2, category: 3, server: 4 };

const NO_MATCH_HINT = '没有标题、面板名或子分类名对得上的素材：换更短或更具体的词（如「复古」而不是「复古风格滤镜」），用 queries 一次试几个近义词，或用 library_nav / library_list 按面板和子分类浏览';

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

function titleTier(title, term) {
  const t = norm(title);
  if (t === term) return TIER.exact;
  if (t.startsWith(term)) return TIER.prefix;
  if (t.includes(term)) return TIER.contains;
  return null;
}

// A hit from a narrowed title search ("韩系滤镜": 韩系 within 滤镜) ranks with category matches.
function rank(record, term, how) {
  const title = titleTier(record.title, term);
  if (title !== null) return title;
  if (how.by !== 'title') return TIER.category;
  if (how.word && titleTier(record.title, how.word) !== null) return TIER.category;
  return TIER.server;
}

function cached(lib, key, ttl = CACHE_MS) {
  lib.searchCache = lib.searchCache || new Map();
  const hit = lib.searchCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  return undefined;
}

function remember(lib, key, value) {
  lib.searchCache.set(key, { at: Date.now(), value });
  while (lib.searchCache.size > CACHE_ENTRIES) lib.searchCache.delete(lib.searchCache.keys().next().value);
  return value;
}

const methods = {
  // Sub-categories of every panel a search can expand into (the account's 收藏 directories are not
  // asset categories, so collection is left out).
  async searchIndex() {
    const hit = cached(this, 'index');
    if (hit) return hit;
    const panels = this.nav().panels.filter((p) => p.panel_key !== COLLECTION_PANEL);
    const index = await Promise.all(
      panels.map(async (p) => {
        const res =
          p.panel_key === SQUARE_PANEL
            ? { body: await this.mod(M.aiCategory).getAIAssetCategory({ cursor: 0, count: 50, panelKey: SQUARE_PANEL }) }
            : await this.mod(M.category).getAssetCategory({ cursor: 0, count: 50, panelKey: p.panel_key });
        const categories = (body(res, 'GET_CATEGORY').categories || []).map((c) => ({ id: String(c.id), name: c.name }));
        return { ...p, categories };
      }),
    );
    return remember(this, 'index', index);
  },

  // Raw records of one category, up to SOURCE_CAP.
  async categoryRecords(panel_key, category_id) {
    const out = [];
    let cursor = 0;
    for (;;) {
      const page = await this.list({ panel_key, category_id, cursor, count: LIST_PAGE });
      out.push(...page.raw);
      if (!page.has_more || out.length >= SOURCE_CAP || page.next_cursor == null) return out.slice(0, SOURCE_CAP);
      cursor = page.next_cursor;
    }
  },

  // The server's title matches for `word`, asked panel by panel: combining panels in one request
  // returns only ~5 items and ignores paging, while one panel returns its full match list (素材广场
  // caps it at 1000).
  async titleRecords(word, panelKeys) {
    const pages = await Promise.all(
      panelKeys.map(async (k) => {
        const data = body(await this.mod(M.search).searchAsset({ searchWord: word, panelList: k, getCategoryInfo: true, getAuthorInfo: true }), 'SEARCH');
        return ((data.dataInfos && data.dataInfos.template) || []).map((t) => ({ ...t, panelKey: t.panelKey || k }));
      }),
    );
    return pages.flat();
  },

  // What one term brings in: the server's title matches, plus the assets of panels and categories the
  // term names ("滤镜", "腮红"), names together ("复古滤镜" = 复古 + 滤镜), or narrows by a title word
  // ("韩系滤镜" = titles with 韩系 in 滤镜). Categories whose name only contains the term are listed as
  // related, not expanded.
  async searchTerm(term, panels, searchable) {
    const t = norm(term);
    const hits = [];
    const expanded = [];
    const related = [];
    const add = (records, how) => records.forEach((r) => hits.push({ r, how }));
    add(await this.titleRecords(term, searchable), { by: 'title' });
    for (const p of panels) {
      const pn = norm(p.name);
      if (pn === t || (p.group && norm(p.group) === t)) {
        const records = (await Promise.all(p.categories.map((c) => this.categoryRecords(p.panel_key, c.id)))).flat();
        add(records.slice(0, SOURCE_CAP), { by: 'panel', where: p.name });
        expanded.push({ panel_key: p.panel_key, panel: p.name, category_id: null, category: null });
        continue;
      }
      const rest = t.startsWith(pn) ? t.slice(pn.length) : t.endsWith(pn) ? t.slice(0, -pn.length) : null;
      for (const c of p.categories) {
        const cn = norm(c.name);
        if (cn === t || (rest && cn === rest)) {
          add(await this.categoryRecords(p.panel_key, c.id), { by: 'category', where: `${p.name}/${c.name}` });
          expanded.push({ panel_key: p.panel_key, panel: p.name, category_id: c.id, category: c.name });
        } else if (cn.length >= 2 && (cn.includes(t) || t.includes(cn))) {
          related.push({ panel_key: p.panel_key, panel: p.name, category_id: c.id, category: c.name });
        }
      }
      if (rest && !p.categories.some((c) => norm(c.name) === rest) && searchable.includes(p.panel_key)) {
        add(await this.titleRecords(rest, [p.panel_key]), { by: 'title', where: p.name, word: rest });
      }
    }
    return { hits, expanded, related };
  },

  async search({ query, queries, panel_key, offset = 0, count = 50 }) {
    this.ensureCompatible();
    const list = queries !== undefined ? queries : query !== undefined ? [query] : [];
    if (query !== undefined && queries !== undefined) throw Error('INVALID_QUERY: pass query or queries, not both');
    if (!Array.isArray(list) || !list.length || list.length > MAX_TERMS) throw Error(`INVALID_QUERY: pass query, or 1-${MAX_TERMS} queries`);
    const terms = list.map((q) => (typeof q === 'string' ? q.trim() : ''));
    if (terms.some((q) => !q)) throw Error('INVALID_QUERY: every query must be a non-empty string');
    const unique = [...new Set(terms)];
    const all = this.nav().panels;
    const searchableKeys = new Set(this.mod(M.navConst).SearchNavItemKeys.flat());
    if (panel_key !== undefined && !all.some((p) => p.panel_key === panel_key && searchableKeys.has(p.panel_key))) {
      throw Error(`NOT_SEARCHABLE: ${panel_key}; searchable panels: ${all.filter((p) => searchableKeys.has(p.panel_key)).map((p) => p.panel_key).join(', ')}`);
    }
    const key = JSON.stringify({ unique, panel_key });
    const ranked = cached(this, key) || remember(this, key, await this.rankedSearch(unique, panel_key, all, searchableKeys));
    const end = offset + count;
    return {
      ...(queries !== undefined ? { queries: unique } : { query: unique[0] }),
      total: ranked.items.length,
      items: ranked.items.slice(offset, end),
      raw: ranked.raw.slice(offset, end),
      next_offset: end < ranked.items.length ? end : null,
      has_more: end < ranked.items.length,
      by_panel: ranked.by_panel,
      matched_categories: ranked.matched_categories,
      related_categories: ranked.related_categories,
      ...(ranked.unsupported ? { unsupported: ranked.unsupported } : {}),
      ...(ranked.items.length ? {} : { hint: NO_MATCH_HINT }),
    };
  },

  async rankedSearch(terms, panel_key, all, searchableKeys) {
    const applicable = new Set(all.map((p) => p.panel_key));
    const index = (await this.searchIndex()).filter((p) => panel_key === undefined || p.panel_key === panel_key);
    const searchable = all.map((p) => p.panel_key).filter((k) => searchableKeys.has(k) && (panel_key === undefined || k === panel_key));
    const rows = new Map();
    const matched = [];
    const related = new Map();
    for (const [order, term] of terms.entries()) {
      const t = norm(term);
      const { hits, expanded, related: rel } = await this.searchTerm(term, index, searchable);
      matched.push(...expanded.map((e) => ({ query: term, ...e })));
      for (const r of rel) related.set(`${r.panel_key}/${r.category_id}`, r);
      for (const [seq, { r, how }] of hits.entries()) {
        if (!r || !r.templateId || !applicable.has(r.panelKey)) continue;
        const id = String(r.templateId);
        const tier = rank(r, t, how);
        const row = rows.get(id) || { r, tier, terms: new Set(), first: [order, seq], via: [] };
        row.tier = Math.min(row.tier, tier);
        row.terms.add(term);
        const via = how.by === 'title' ? (how.word ? `title:${how.word}@${how.where}` : 'title') : `${how.by}:${how.where}`;
        if (!row.via.some((v) => v.query === term && v.by === via)) row.via.push({ query: term, by: via });
        rows.set(id, row);
      }
    }
    const sorted = [...rows.values()].sort((a, b) => a.tier - b.tier || b.terms.size - a.terms.size || a.first[0] - b.first[0] || a.first[1] - b.first[1]);
    const { items, raw, unsupported } = this.page(sorted.map((x) => x.r));
    const byId = new Map(sorted.map((x) => [String(x.r.templateId), x]));
    const names = new Map(all.map((p) => [p.panel_key, p.name]));
    const counts = new Map();
    for (const it of items) counts.set(it.panel_key, (counts.get(it.panel_key) || 0) + 1);
    const matchedKeys = new Set(matched.map((m) => `${m.panel_key}/${m.category_id}`));
    return {
      items: items.map((it) => ({ ...it, matched: byId.get(it.template_id).via })),
      raw,
      unsupported,
      by_panel: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ panel_key: k, name: names.get(k) || k, count: n })),
      matched_categories: matched,
      related_categories: [...related.entries()].filter(([k]) => !matchedKeys.has(k)).map(([, v]) => v),
    };
  },
};

const METHODS = { library_search: 'search' };

module.exports = { methods, METHODS, MAX_TERMS, SOURCE_CAP };
