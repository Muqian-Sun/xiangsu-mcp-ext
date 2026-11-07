import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { Library, M, PICK_KINDS, SUBJECT_KINDS } = require('../editor-plugin/library.cjs');

const ok = (data) => JSON.stringify({ code: 0, message: 'success', data });

// Fixtures trimmed from real responses; the 19-digit ids stay raw JSON text.
const INSPIRATION = {
  id: '7697075498307897370',
  title: '鎏花入镜',
  cover_img: { uri: 'u', urlList: ['https://cdn/i1.png'], width: 1728, height: 2304 },
  tag_desc: '激励',
  author_name: '唐糖',
  author_avatar: 'https://cdn/a.png',
  total_collection: 185,
  is_collect: false,
  author_uid: '2465527461847677',
  is_ai_ins: true,
};
const INSPIRATION_DETAIL = {
  base: {
    id: '7696975869251864618',
    title: '万元券锦鲤妆',
    detail_desc: 'AI 锦鲤妆造',
    imgs: [{ uri: 'x', urlList: ['https://cdn/d1.png'], width: 1728, height: 2304 }],
    effect_types: [{ id: 5841, name: 'AI 妆造扮演' }],
    bonus_text: '收藏灵感，即有机会获得激励',
    tag_desc: '',
  },
  designer: { uid: '103424810657', name: '早安玫瑰', avatar: 'https://cdn/av.png' },
  award: { id: '0', type: 0, amount: 0, text: '', desc: '' },
  ai_hotspot_info: { id: '12527', title: '双11开门红', score: '11681000' },
  project_info: { title: 'AI 女神节快乐', icon: 'i', desc: '可在像塑桌面端搜索使用' },
  effects: [{ name: '拆快递', total_pub_num: 169 }],
  videos: [{}, {}],
};
const ACTIVITY = { id: 'A1', title: '新人成长路线', tags: '新手,必做', ttl: 3 * 86400000 + 5 };
const EFFECT_TASKS = {
  cursor: 0,
  total: 2,
  effect_tasks: [
    {
      title: '冷空气网感美妆定向征集赛',
      process_status: 1,
      process_status_text: '领取',
      designer_task_id: '',
      item_id: 108116,
      tags: [{ type: 3, name: '特效' }],
      revenue: '0',
      icon_url: 'https://cdn/t.png',
      can_fin_times: -1,
      binding_templates: ['7408401210929053711', '7411422748410609714'],
      receive_id: 108117,
      task_id: 108117,
      offline_at: 1797350400000,
      release_at: 1793977780000,
    },
    { title: '冬日将至爆款玩法征集赛', process_status: 2, process_status_text: '去制作', designer_task_id: '555', item_id: 108200, tags: [], receive_id: 108201, task_id: 108201 },
  ],
};
const GROWTH_TASKS = {
  cursor: 2,
  total: 2,
  growth_tasks: [
    {
      task_id: 'headdress_decoration',
      name: '学会制作1款头饰装饰特效',
      icon: 'https://cdn/g.png',
      bonus_amount: 1000,
      tags: ['基础任务', '10元奖励'],
      project_data: [{ project_id: '7535420584646262830', project_desc: '投稿量80万' }],
      growth_task_type: 1,
    },
    { task_id: 'newbie_first', name: '完成第一个特效', bonus_amount: 500, tags: [], project_data: [], growth_task_type: 0 },
  ],
};
const RANK_TAGS = [
  { tagName: '基础头饰', level: 2, num: 45 },
  { tagName: '美妆', level: 2, num: 17 },
  { tagName: '人像美化', level: 1, num: 68 },
  { tagName: '游戏玩法', level: 1, num: 49 },
  { tagName: '怪奇', level: 4, num: 1 },
];
const RANK_EFFECT = {
  app_effect_id: 273663451,
  effect_name: '好友对你都有什么想法',
  effect_icon: 'https://cdn/r1.png',
  effect_lv: 3,
  peak_pub_val: '56.7万',
  male_pub_rate: '34.84',
  female_pub_rate: '65.16',
  effect_id: '88649924',
  young_like_score: 10,
  all_pub_val: '506.6万',
  is_new_inc: true,
  male_like_score: 9,
  hot_play_score: 8,
  follow_shoot_pub_val: 67206,
  follow_shoot_pub_val_30d: 2047071,
  effect_total_rev: '71291',
};
const HOTSPOTS = {
  rank_time: '2026-11-06 15',
  subtitle: '激发创作灵感 每周瓜分1万！',
  hotspots: [
    {
      id: '2728034',
      title: '原来深秋是咕嘟的',
      topic_id: '13439',
      cover: { urlList: ['https://cdn/h1.png'] },
      hot_core: 19727126,
      subtitle_text: '69条创作灵感',
      rank_num: 10,
      description: '深秋咕嘟暖感强',
      tags: ['1972.7万热度'],
    },
    { id: '2729772', title: '立冬', topic_id: '13444', cover: { urlList: [] }, hot_core: 19384492, rank_num: 21, tags: [] },
  ],
};
const HOTSPOT_INSPIRATIONS =
  '{"code":0,"message":"success","data":{"insp_tabs":[{"id":0,"title":"全部","insps":[{"tag":"AI 妆造扮演","id":7704552248298391592,"title":"宿舍小电锅咕嘟达人","cover":{"uri":"u","urlList":["https://cdn/hi.png"]},"detail":"AI 宿舍场景"}]}]}}';
const SUBJECT = {
  subject_id: '261',
  subject_name: '测一测玩法特效榜 - 11月 ',
  sub_title: '本月测一测爆款',
  page_view_cnt: 5120,
  subject_cover_pic: 'https://cdn/s.png',
  online_time: 1793772002000,
  effects: [{ app_effect_id: 278949852, effect_id: '90154479', effect_name: '11月你会发生什么', effect_icon: 'https://cdn/e.png', effect_desc: '' }],
};
// 23 effect boards and 2 template boards; the template board's app_effect_id overflowed like the real one.
const EFFECT_SUBJECTS = Array.from({ length: 23 }, (_, i) => ({ ...SUBJECT, subject_id: String(261 - i), subject_name: i === 21 ? '热爆美妆特效榜 - 3月' : `测一测玩法特效榜 - ${i}期` }));
const TEMPLATE_SUBJECTS = [
  {
    subject_id: '203',
    subject_name: '萌娃萌宠模板榜 - 9月',
    effects: [{ app_effect_id: -1388249034, app_effect_id_str: '7529884834588590134', effect_id: '40013082', effect_name: 'AI 高级感睡裙试穿' }],
  },
  { subject_id: '204', subject_name: '歌词玩法模板榜 - 10月', effects: [] },
];
// The 专题合集 endpoint: cursor is an offset it echoes back, and past the end it answers code 0 without data.
function subjectsRoute(call) {
  const list = call.query.type === '2' ? TEMPLATE_SUBJECTS : EFFECT_SUBJECTS;
  const at = Number(call.query.cursor);
  const page = list.slice(at, at + Number(call.query.count));
  if (!page.length) return JSON.stringify({ code: 0, message: 'success' });
  return ok({ cursor: at, count: Number(call.query.count), total: list.length, subjects: page });
}
const CREATOR_MONTH =
  '{"code":0,"message":"success","data":[{"rank_no":1,"uid":7495234997042594875,"username":"征蓬落日圆","avatar":"https://cdn/u.png","material_cnt":1,"award_num":300000,"display_val":"预计奖3000元","display_follow_pub":"1.2万","follow_pub_val":12972}]}';
const PICKS = {
  effect_list: [
    {
      effect_id_str: '91518554',
      app_effect_id_str: '7703570232371232802',
      name: '用这首歌官宣好朋友',
      icon: 'https://cdn/p.png',
      pub_val: '5741',
      total_rev: '67.54',
      cover_img: 'https://cdn/pc.jpeg',
      label: '音频配文',
      review_date: '2026-11-03',
      video_item_id: '7704341495155455739',
    },
  ],
  date: '2026-11-03',
  total: 249,
  has_more: true,
};

const BASE_ROUTES = {
  'GET /creator/v1/growth_route_online': ok({ activities: [ACTIVITY] }),
  'GET /creator_api/inspiration/v1/tabs': ok({ tab_names: ['全部', '热门音源', '头饰'] }),
  'GET /creator_api/inspiration/v1/list': ok({ total: 10000000, cursor: 23, count: 3, has_more: true, list: [INSPIRATION] }),
  'GET /creator/v2/inspiration_detail': ok(INSPIRATION_DETAIL),
  'GET /creator_api/inspiration/v1/is_collected': ok({ item_id: '7696975869251864618', is_collected: false }),
  'GET /creator_api/inspiration/v1/extra': ok({ id: '7696975869251864618', total_collection: 35 }),
  'GET /creator_api/task/v1/effect_task_list': ok(EFFECT_TASKS),
  'GET /cam_api/task/v1/growth_task_list': ok(GROWTH_TASKS),
  'GET /cam_api/rank/v1/tag': ok(RANK_TAGS),
  'GET /cam_api/rank/v1/detail': ok({ cursor: 7, count: 2, total: 200, update_time: '2026-11-06 16:32:12', date: '2026-11-06', effects: [RANK_EFFECT], title: '年轻排名' }),
  'GET /cam_api/hotspot/v1/rank': ok(HOTSPOTS),
  'GET /cam_api/hotspot/v1/insp_tabs': HOTSPOT_INSPIRATIONS,
  'GET /cam_api/discover/v1/subjects': subjectsRoute,
  'GET /cam_api/discover/v1/subject_detail': ok({ subject: SUBJECT, cursor: 10, count: 10, total: 1 }),
  'GET /cam_api/innovation_plan/v1/user_month_rank': CREATOR_MONTH,
  'GET /cam_api/innovation_plan/v1/rank_list': ok(PICKS),
};

// A fake editor exposing the modules the community feature reads, and a fetch answering by method and path.
function setup(routes = {}) {
  const table = { ...BASE_ROUTES, ...routes };
  const calls = [];
  const cookieUrls = [];
  const marked = [];
  const state = { project: true };
  const modules = {
    [M.urls]: {
      Domain: { kBackendApiURL: 'https://api.test' },
      DomainPath: { kActivityAPI: '/creator/v1/growth_route_online', kTaskListAPI: '/creator_api/task/v1/effect_task_list', kGrowthTaskList: '/cam_api/task/v1/growth_task_list' },
    },
    [M.orionui]: {
      CookieManager: class {
        async getCookie(url) {
          cookieUrls.push(url);
          return 'sessionid=abc';
        }
      },
    },
    [M.bizUtils]: { PlatformUtils: { genSignData: () => 'signed' }, UserAgentUtils: { userAgentGenerator: () => () => 'DouyinAR/9.7.2' } },
    [M.activityTypes]: {
      TaskStatus: { 1: 'WAIT_RECEIVE', 2: 'WAIT_SUBMIT', WAIT_RECEIVE: 1, WAIT_SUBMIT: 2 },
      growthTaskType: { 0: 'Newbie', 1: 'Other', Newbie: 0, Other: 1 },
      getTypeName: (m) => ({ 1: 'special', 2: 'special', 3: 'video' })[m.display_type] || 'normal',
    },
    [M.inspirationConst]: { IS_COLLECT_PARAMS_TYPE: { Default: 2, Music: 5 } },
    [M.inspirationBridge]: { markAgentInspirationUsed: ({ inspirationId }) => marked.push(inspirationId) },
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => state.project }) } },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const fetch = async (href, init) => {
    const url = new URL(href);
    const call = { origin: url.origin, path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method, headers: init.headers, body: init.body, signal: init.signal };
    calls.push(call);
    const route = table[`${init.method} ${url.pathname}`];
    if (route === undefined) throw Error(`unexpected ${init.method} ${url.pathname}`);
    const r = typeof route === 'function' ? route(call, calls) : route;
    return r instanceof Response ? r : new Response(r, { status: 200 });
  };
  const to = (path) => calls.filter((c) => c.path === path);
  return { lib: new Library(mod, fetch), calls, to, modules, cookieUrls, marked, state };
}

test('community requests carry the editor login cookie and signing headers and keep 19-digit ids exact', async () => {
  const { lib, calls, cookieUrls } = setup();
  const out = await lib.rankHotspots({ topic_id: '13439' });
  assert.equal(out.tabs[0].inspirations[0].inspiration_id, '7704552248298391592');
  assert.equal(out.tabs[0].inspirations[0].cover_url, 'https://cdn/hi.png');
  const month = await lib.rankCreatorsMonth();
  assert.equal(month.items[0].uid, '7495234997042594875');
  assert.equal(calls[0].origin, 'https://api.test');
  assert.deepEqual(calls[0].query, { topic_id: '13439' });
  assert.deepEqual(calls[0].headers, { cookie: 'sessionid=abc', 'x-api-sign-data': 'signed', 'user-agent': 'DouyinAR/9.7.2' });
  assert.deepEqual(cookieUrls[0], 'https://api.test');
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal), 'every request has a timeout');
});

test('community requests fail on server codes, HTTP errors and non-JSON bodies', async () => {
  const bad = setup({ 'GET /cam_api/rank/v1/detail': JSON.stringify({ code: 400, message: '参数错误' }) });
  await assert.rejects(bad.lib.rankList({}), /GET_RANK_FAILED: code=400 message=参数错误/);
  const http = setup({ 'GET /cam_api/hotspot/v1/rank': () => new Response('busy', { status: 502 }) });
  await assert.rejects(http.lib.rankHotspots({}), /GET_HOTSPOTS_FAILED: HTTP 502/);
  const html = setup({ 'GET /cam_api/discover/v1/subjects': '<html>' });
  await assert.rejects(html.lib.rankSubjects({}), /GET_SUBJECTS_FAILED: response is not JSON/);
});

test('reads retry once on the busy code 1; writes and other codes are not retried', async () => {
  const busy = JSON.stringify({ code: 1, message: '网络开小差了' });
  const flaky = setup({ 'GET /cam_api/task/v1/growth_task_detail': (call, calls) => (calls.length === 1 ? busy : ok(GROWTH_TASKS.growth_tasks[0])) });
  assert.equal((await flaky.lib.taskDetail({ kind: 'growth', id: 'headdress_decoration' })).title, '学会制作1款头饰装饰特效');
  assert.equal(flaky.to('/cam_api/task/v1/growth_task_detail').length, 2);
  const down = setup({ 'GET /cam_api/task/v1/growth_task_detail': busy });
  await assert.rejects(down.lib.taskDetail({ kind: 'growth', id: 'headdress_decoration' }), /GET_GROWTH_TASK_FAILED: code=1 message=网络开小差了/);
  assert.equal(down.to('/cam_api/task/v1/growth_task_detail').length, 2);
  const bad = setup({ 'GET /cam_api/rank/v1/detail': JSON.stringify({ code: 400, message: '参数错误' }) });
  await assert.rejects(bad.lib.rankList({}), /code=400/);
  assert.equal(bad.to('/cam_api/rank/v1/detail').length, 1);
  const write = setup({ 'POST /creator/v1/receive_task': busy });
  await assert.rejects(write.lib.taskReceive({ item_id: '108116' }), /RECEIVE_TASK_FAILED: code=1/);
  assert.equal(write.to('/creator/v1/receive_task').length, 1);
});

test('inspiration_list checks the tab, sends flag 1 for the first page and 2 after, and slims items', async () => {
  const { lib, to } = setup();
  const out = await lib.inspirationList({});
  assert.deepEqual(to('/creator_api/inspiration/v1/list')[0].query, { flag: '1', cursor: '0', count: '20', tab_name: '全部' });
  assert.deepEqual(out, {
    tab: '全部',
    items: [
      {
        inspiration_id: '7697075498307897370',
        title: '鎏花入镜',
        tag: '激励',
        author: '唐糖',
        author_uid: '2465527461847677',
        collect_count: 185,
        collected: false,
        ai: true,
        cover_url: 'https://cdn/i1.png',
      },
    ],
    next_cursor: 23,
    has_more: true,
  });
  await lib.inspirationList({ tab: '头饰', cursor: 23, count: 5 });
  assert.deepEqual(to('/creator_api/inspiration/v1/list')[1].query, { flag: '2', cursor: '23', count: '5', tab_name: '头饰' });
  await assert.rejects(lib.inspirationList({ tab: '宠物' }), /INVALID_TAB: 宠物; valid: 全部, 热门音源, 头饰/);
  assert.equal(to('/creator_api/inspiration/v1/list').length, 2);
});

test('inspiration_detail merges the detail with its collection state and count', async () => {
  const { lib, to } = setup();
  const out = await lib.inspirationDetail({ inspiration_id: '7696975869251864618' });
  assert.deepEqual(out, {
    inspiration_id: '7696975869251864618',
    title: '万元券锦鲤妆',
    description: 'AI 锦鲤妆造',
    tag: null,
    effect_types: ['AI 妆造扮演'],
    bonus_text: '收藏灵感，即有机会获得激励',
    images: ['https://cdn/d1.png'],
    author: { uid: '103424810657', name: '早安玫瑰' },
    award: null,
    hotspot: { title: '双11开门红', score: '11681000' },
    project: { title: 'AI 女神节快乐', desc: '可在像塑桌面端搜索使用' },
    effects: [{ name: '拆快递', published: 169 }],
    videos: 2,
    collected: false,
    collect_count: 35,
  });
  assert.deepEqual(to('/creator/v2/inspiration_detail')[0].query, { id: '7696975869251864618' });
  assert.deepEqual(to('/creator_api/inspiration/v1/is_collected')[0].query, { item_id: '7696975869251864618', item_type: '2' });
  assert.deepEqual(to('/creator_api/inspiration/v1/extra')[0].query, { id: '7696975869251864618' });
  await assert.rejects(lib.inspirationDetail({ inspiration_id: ' ' }), /INVALID_INSPIRATION_ID/);
  const gone = setup({ 'GET /creator/v2/inspiration_detail': ok({ base: { imgs: [] }, videos: [] }) });
  await assert.rejects(gone.lib.inspirationDetail({ inspiration_id: '1' }), /INSPIRATION_NOT_FOUND: 1/);
});

test('inspiration_bind records the inspiration on the open project through the editor hook', () => {
  const { lib, marked, state } = setup();
  assert.deepEqual(lib.inspirationBind({ inspiration_id: ' 77 ' }), { bound: '77', next: 'save_project to keep it' });
  assert.deepEqual(marked, ['77']);
  assert.throws(() => lib.inspirationBind({ inspiration_id: ' ' }), /INVALID_INSPIRATION_ID/);
  state.project = false;
  assert.throws(() => lib.inspirationBind({ inspiration_id: '77' }), /NO_ACTIVE_PROJECT/);
  assert.deepEqual(marked, ['77']);
});

test('inspiration_collect posts the inspiration card with the action and confirms the new state', async () => {
  let collected = false;
  const routes = {
    'POST /creator_api/inspiration/v1/collect': (call) => {
      collected = JSON.parse(call.body).action === 1;
      return ok({});
    },
    'GET /creator_api/inspiration/v1/is_collected': () => ok({ is_collected: collected }),
  };
  const { lib, to } = setup(routes);
  assert.deepEqual(await lib.inspirationCollect({ inspiration_id: '7696975869251864618' }), {
    inspiration_id: '7696975869251864618',
    title: '万元券锦鲤妆',
    collected: true,
  });
  const post = to('/creator_api/inspiration/v1/collect')[0];
  assert.equal(post.headers['content-type'], 'application/json');
  const body = JSON.parse(post.body);
  assert.deepEqual({ ...body, extra: JSON.parse(body.extra) }, {
    item_id: '7696975869251864618',
    item_name: '万元券锦鲤妆',
    item_type: 2,
    action: 1,
    extra: { img_url: 'https://cdn/d1.png', img_width: '1728.0', img_height: '2304.0', tag_desc: '', author: '早安玫瑰', avatar: 'https://cdn/av.png', collect_num: 35 },
  });
  assert.equal((await lib.inspirationCollect({ inspiration_id: '7696975869251864618', collect: false })).collected, false);
  assert.equal(JSON.parse(to('/creator_api/inspiration/v1/collect')[1].body).action, 0);
});

test('inspiration_collect reports a collection the server did not apply', async () => {
  const { lib } = setup({ 'POST /creator_api/inspiration/v1/collect': ok({}) });
  await assert.rejects(lib.inspirationCollect({ inspiration_id: '7696975869251864618' }), /COLLECT_NOT_APPLIED: inspiration 7696975869251864618 is not collected/);
});

test('tasks_list merges activities and effect tasks, and prepares launch extras only for received ones', async () => {
  const { lib } = setup();
  const effect = await lib.tasksList({});
  assert.deepEqual(effect.items.map((i) => [i.task_id, i.kind]), [['A1', 'activity'], ['108117', 'task'], ['108201', 'task']]);
  assert.deepEqual(effect.items[1], {
    task_id: '108117',
    kind: 'task',
    title: '冷空气网感美妆定向征集赛',
    status: 'WAIT_RECEIVE',
    status_text: '领取',
    received: false,
    bindable: false,
    tags: ['特效'],
    days_left: null,
    revenue: '0',
    can_finish_times: -1,
    released_at: new Date(1793977780000).toISOString(),
    offline_at: new Date(1797350400000).toISOString(),
    icon_url: 'https://cdn/t.png',
  });
  assert.deepEqual({ received: effect.items[2].received, bindable: effect.items[2].bindable, status: effect.items[2].status }, { received: true, bindable: true, status: 'WAIT_SUBMIT' });
  assert.deepEqual({ status: effect.items[0].status, tags: effect.items[0].tags, days: effect.items[0].days_left }, { status: null, tags: ['新手', '必做'], days: 3 });
  assert.deepEqual(effect.raw, [
    { kind: 'activity', item_id: null, extra: { activity_id: 'A1', activity_name: '新人成长路线', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Growup' } },
    { kind: 'task', item_id: '108116', extra: null },
    { kind: 'task', item_id: '108200', extra: { activity_id: '555', activity_name: '冬日将至爆款玩法征集赛', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Normal' } },
  ]);
  const growth = await lib.tasksList({ kind: 'growth' });
  assert.deepEqual(growth.items[0], {
    task_id: 'headdress_decoration',
    kind: 'growth',
    title: '学会制作1款头饰装饰特效',
    bonus_yuan: 10,
    tags: ['基础任务', '10元奖励'],
    newbie: false,
    bindable: false,
    projects: [{ project_id: '7535420584646262830', desc: '投稿量80万' }],
    icon_url: 'https://cdn/g.png',
  });
  assert.equal(growth.items[1].newbie, true);
  assert.deepEqual(growth.raw[0], { kind: 'growth', item_id: null, extra: null });
  await assert.rejects(lib.tasksList({ kind: 'daily' }), /INVALID_KIND: daily/);
});

test('task_detail reads an effect task like the task window and a growth task with its inspirations', async () => {
  const { lib, to } = setup({
    'GET /effectcam/v2/effect_task_detail': ok({
      process_status: 1,
      s_desc: '未领取',
      title: '冷空气网感美妆定向征集赛',
      tags: [{ name: '特效', type: 3 }],
      reward_begin: '12月21日',
      reward_end: '12月31日',
      template_id_list: '["7408401210929053711","7411422748410609714"]',
      can_fin_times: -1,
      offline_at_unix: 1797350400000,
    }),
    'GET /effectcam/v2/effect_task_content': ok({
      modules: [{ name: '', type: 3, seq: 0, render_content: '{"type":3,"contentBlockName":"参与要求","demandList":[{"tit":"主题要求","desc":"年轻美妆"}]}' }],
    }),
    'GET /cam_api/task/v1/growth_task_detail': ok({
      ...GROWTH_TASKS.growth_tasks[0],
      inspiration_list: [INSPIRATION],
      tutorial_title: '像素胡子小蓝兔教程',
      tutorial_desc: '静态贴纸替换',
      tutorial_video_url: 'https://cdn/v.mp4',
    }),
  });
  const effect = await lib.taskDetail({ kind: 'task', id: '108116' });
  for (const path of ['/effectcam/v2/effect_task_detail', '/effectcam/v2/effect_task_content']) {
    assert.deepEqual(to(path)[0].query, { item_id: '108116', app_version: '11.3.0' });
  }
  assert.deepEqual(effect, {
    kind: 'task',
    title: '冷空气网感美妆定向征集赛',
    status: 'WAIT_RECEIVE',
    status_text: '未领取',
    tags: ['特效'],
    reward_begin: '12月21日',
    reward_end: '12月31日',
    offline_at: new Date(1797350400000).toISOString(),
    can_finish_times: -1,
    content: [{ type: 3, contentBlockName: '参与要求', demandList: [{ tit: '主题要求', desc: '年轻美妆' }] }],
  });
  const growth = await lib.taskDetail({ kind: 'growth', id: 'headdress_decoration' });
  assert.deepEqual(to('/cam_api/task/v1/growth_task_detail')[0].query, { task_id: 'headdress_decoration' });
  assert.equal(growth.bonus_yuan, 10);
  assert.deepEqual(growth.inspirations.map((i) => i.inspiration_id), ['7697075498307897370']);
  assert.deepEqual(growth.tutorial, { title: '像素胡子小蓝兔教程', desc: '静态贴纸替换', video_url: 'https://cdn/v.mp4' });
  assert.equal(growth.title, '学会制作1款头饰装饰特效');
  await assert.rejects(lib.taskDetail({ kind: 'growth' }), /INVALID_TASK_ID/);
  await assert.rejects(lib.taskDetail({ kind: 'activity', id: 'A1' }), /INVALID_KIND: activity; valid: task, growth/);
});

test('task_receive posts the receive id as a form field, only for a task waiting to be received', async () => {
  const { lib, to } = setup({ 'POST /creator/v1/receive_task': ok({ designer_task_id: 9001, process_status: 2 }) });
  assert.deepEqual(await lib.taskReceive({ item_id: '108116' }), {
    title: '冷空气网感美妆定向征集赛',
    designer_task_id: '9001',
    status: 'WAIT_SUBMIT',
  });
  const post = to('/creator/v1/receive_task')[0];
  assert.ok(post.body instanceof FormData);
  assert.deepEqual([...post.body.entries()], [['id', '108117']]);
  await assert.rejects(lib.taskReceive({ item_id: '108200' }), /TASK_NOT_RECEIVABLE: 108200 status=WAIT_SUBMIT/);
  await assert.rejects(lib.taskReceive({ item_id: '1' }), /UNKNOWN_TASK: 1/);
  assert.equal(to('/creator/v1/receive_task').length, 1);
});

test('task_receive fails when the server hands back no designer task', async () => {
  const { lib } = setup({ 'POST /creator/v1/receive_task': ok({}) });
  await assert.rejects(lib.taskReceive({ item_id: '108116' }), /RECEIVE_TASK_FAILED: task 108116/);
});

test('rank_nav lists the boards, filter options and the board categories for a date', async () => {
  const { lib, to } = setup();
  const out = await lib.rankNav({ rank_type: 2, date: '2026-11-01' });
  assert.deepEqual(out.rank_types.map((r) => r.rank_type), [1, 2, 3, 4, 7, 9, 10]);
  assert.equal(out.rank_types.find((r) => r.rank_type === 10).name, '特效跟拍榜');
  assert.deepEqual(out.filters.preferences, ['友友', '潮酷']);
  assert.deepEqual(out.filters.young_like_scores, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(out.categories[0], { name: '基础头饰', level: 2, count: 45 });
  assert.deepEqual(to('/cam_api/rank/v1/tag')[0].query, { rank_type: '2', date: '2026-11-01' });
  await assert.rejects(lib.rankNav({ rank_type: 8 }), /INVALID_RANK_TYPE: 8; valid: 1\(年轻喜爱榜\)/);
});

test('rank_list maps filters and one category per level to the rank page query and numbers items from the cursor', async () => {
  const { lib, to } = setup();
  const out = await lib.rankList({
    rank_type: 1,
    date: '2026-11-05',
    categories: ['人像美化', '美妆'],
    levels: ['S', 'A+'],
    panels: ['头饰', '美妆'],
    preferences: ['友友'],
    tools: ['像塑桌面端'],
    young_like_scores: [9, 10],
    cursor: 5,
    count: 2,
  });
  assert.deepEqual(to('/cam_api/rank/v1/detail')[0].query, {
    rank_type: '1',
    date: '2026-11-05',
    cursor: '5',
    count: '2',
    effect_lv: '3,5',
    panel_type: '1,8',
    perf_type: '5',
    tool_type: '1',
    young_like_score: '9,10',
    material_labels3_first: '人像美化',
    material_labels3_second: '美妆',
  });
  assert.deepEqual(to('/cam_api/rank/v1/tag')[0].query, { rank_type: '1', date: '2026-11-05' });
  assert.equal(out.name, '年轻喜爱榜');
  assert.equal(out.updated_at, '2026-11-06 16:32:12');
  assert.deepEqual(out.items[0], {
    rank: 6,
    effect_id: '88649924',
    app_effect_id: '273663451',
    name: '好友对你都有什么想法',
    icon_url: 'https://cdn/r1.png',
    level: 'S',
    is_new: true,
    pub_peak: '56.7万',
    pub_total: '506.6万',
    follow_shoot: 67206,
    follow_shoot_30d: 2047071,
    follow_shoot_60d: null,
    male_rate: '34.84',
    female_rate: '65.16',
    young_like_score: 10,
    male_like_score: 9,
    hot_play_score: 8,
    revenue_total: '71291',
  });
  assert.equal(out.next_cursor, 7);
  assert.equal(out.has_more, true);
});

test('rank_list reads the template board from its templates list', async () => {
  const { lib } = setup({
    'GET /cam_api/rank/v1/detail': ok({
      cursor: 1,
      total: 1,
      date: '2026-11-06',
      templates: [{ app_effect_id: '7700473516407210024', effect_name: 'AI 复古氛围', all_pub_val: '9.5万', total_rev: '3526', effect_id: '90489844' }],
    }),
  });
  const out = await lib.rankList({ rank_type: 9 });
  assert.equal(out.name, '模板每日投稿榜');
  assert.deepEqual(
    { id: out.items[0].app_effect_id, name: out.items[0].name, rev: out.items[0].revenue_total, more: out.has_more },
    { id: '7700473516407210024', name: 'AI 复古氛围', rev: '3526', more: false },
  );
});

test('rank_list rejects unknown boards, filter labels, categories and dates before asking for the board', async () => {
  const { lib, to } = setup();
  await assert.rejects(lib.rankList({ rank_type: 5 }), /INVALID_RANK_TYPE: 5/);
  await assert.rejects(lib.rankList({ levels: ['S+'] }), /INVALID_FILTER\(levels\): S\+; valid: SSS, SS, S/);
  await assert.rejects(lib.rankList({ tools: ['剪映'] }), /INVALID_FILTER\(tools\): 剪映/);
  await assert.rejects(lib.rankList({ young_like_scores: [11] }), /INVALID_FILTER\(young_like_scores\): 11/);
  await assert.rejects(lib.rankList({ date: '2026/11/05' }), /INVALID_DATE/);
  await assert.rejects(lib.rankList({ categories: ['宠物'] }), /INVALID_CATEGORY: 宠物; valid: 基础头饰, 美妆, 人像美化, 游戏玩法, 怪奇/);
  await assert.rejects(lib.rankList({ categories: ['怪奇'] }), /UNSUPPORTED_CATEGORY_LEVEL: 怪奇 has level 4/);
  await assert.rejects(lib.rankList({ categories: ['人像美化', '游戏玩法'] }), /ONE_CATEGORY_PER_LEVEL: 人像美化 and 游戏玩法 are both level 1/);
  assert.equal(to('/cam_api/rank/v1/detail').length, 0);
});

test('rank_hotspots ranks hotspots by position, not rank_num, and passes the count', async () => {
  const { lib, to } = setup();
  const out = await lib.rankHotspots({ count: 2 });
  assert.deepEqual(to('/cam_api/hotspot/v1/rank')[0].query, { count: '2' });
  assert.equal(out.rank_time, '2026-11-06 15');
  assert.deepEqual(out.items[0], {
    rank: 1,
    topic_id: '13439',
    title: '原来深秋是咕嘟的',
    description: '深秋咕嘟暖感强',
    heat: 19727126,
    heat_text: '1972.7万热度',
    inspirations_text: '69条创作灵感',
    cover_url: 'https://cdn/h1.png',
  });
  assert.deepEqual(
    out.items.map((i) => [i.rank, i.cover_url]),
    [
      [1, 'https://cdn/h1.png'],
      [2, null],
    ],
  );
  await lib.rankHotspots({});
  assert.deepEqual(to('/cam_api/hotspot/v1/rank')[1].query, {});
});

test('rank_subjects pages the effect and template boards by offset and reads one board in full', async () => {
  const { lib, to } = setup();
  const first = await lib.rankSubjects({});
  assert.deepEqual(to('/cam_api/discover/v1/subjects')[0].query, { cursor: '0', count: '20', type: '1' });
  assert.deepEqual(first.subjects[0], {
    subject_id: '261',
    name: '测一测玩法特效榜 - 0期',
    subtitle: '本月测一测爆款',
    online_at: new Date(1793772002000).toISOString(),
    views: 5120,
    cover_url: 'https://cdn/s.png',
    effects: [{ effect_id: '90154479', app_effect_id: '278949852', name: '11月你会发生什么', icon_url: 'https://cdn/e.png', description: '' }],
  });
  assert.deepEqual({ n: first.subjects.length, total: first.total, next: first.next_cursor, more: first.has_more }, { n: 20, total: 23, next: 20, more: true });
  const last = await lib.rankSubjects({ cursor: 20 });
  assert.deepEqual({ n: last.subjects.length, next: last.next_cursor, more: last.has_more }, { n: 3, next: 23, more: false });
  const past = await lib.rankSubjects({ cursor: 40 });
  assert.deepEqual({ n: past.subjects.length, total: past.total, more: past.has_more }, { n: 0, total: null, more: false });
  const templates = await lib.rankSubjects({ kind: 'template' });
  assert.equal(to('/cam_api/discover/v1/subjects').at(-1).query.type, '2');
  assert.equal(templates.subjects[0].effects[0].app_effect_id, '7529884834588590134');
  const one = await lib.rankSubjects({ subject_id: '261' });
  assert.deepEqual(to('/cam_api/discover/v1/subject_detail')[0].query, { subject_id: '261', cursor: '0', count: '20' });
  assert.equal(one.name, '测一测玩法特效榜 - 11月');
  await assert.rejects(lib.rankSubjects({ kind: 'emoji' }), /INVALID_KIND: emoji; valid: effect, template/);
});

test('rank_subjects keyword searches every page of a kind', async () => {
  const { lib, to } = setup();
  const out = await lib.rankSubjects({ keyword: ' 美妆 ' });
  assert.deepEqual(to('/cam_api/discover/v1/subjects').map((c) => c.query.cursor), ['0', '20']);
  assert.deepEqual({ kw: out.keyword, total: out.total, names: out.subjects.map((s) => s.name) }, { kw: '美妆', total: 1, names: ['热爆美妆特效榜 - 3月'] });
  const tpl = await lib.rankSubjects({ kind: 'template', keyword: '歌词' });
  assert.deepEqual(tpl.subjects.map((s) => s.subject_id), ['204']);
  await assert.rejects(lib.rankSubjects({ keyword: '  ' }), /INVALID_KEYWORD/);
});

test('rank_creators_month converts the award to yuan', async () => {
  const { lib } = setup();
  assert.deepEqual((await lib.rankCreatorsMonth()).items[0], {
    rank: 1,
    uid: '7495234997042594875',
    name: '征蓬落日圆',
    avatar_url: 'https://cdn/u.png',
    material_count: 1,
    follow_pub: '1.2万',
    follow_pub_count: 12972,
    award_text: '预计奖3000元',
    award_yuan: 3000,
  });
});

test('rank_innovation_picks asks for the artwork type and pages by the requested size', async () => {
  const { lib, to } = setup();
  const out = await lib.rankInnovationPicks({ offset: 20, count: 20 });
  assert.deepEqual(to('/cam_api/innovation_plan/v1/rank_list')[0].query, { page_size: '20', offset: '20', tab_id: 'all', artwork_type: '2' });
  assert.deepEqual(out.items[0], {
    effect_id: '91518554',
    app_effect_id: '7703570232371232802',
    name: '用这首歌官宣好朋友',
    icon_url: 'https://cdn/p.png',
    label: '音频配文',
    pub_count: '5741',
    revenue_total: '67.54',
    reviewed_on: '2026-11-03',
    cover_url: 'https://cdn/pc.jpeg',
    video_item_id: '7704341495155455739',
  });
  assert.deepEqual({ next: out.next_offset, more: out.has_more, total: out.total }, { next: 40, more: true, total: 249 });
  await lib.rankInnovationPicks({ kind: 'effect' });
  assert.equal(to('/cam_api/innovation_plan/v1/rank_list')[1].query.artwork_type, '0');
  await assert.rejects(lib.rankInnovationPicks({ kind: 'emoji' }), /INVALID_KIND: emoji; valid: template, effect/);
});

test('community calls refuse without sending anything when the editor modules are missing', async () => {
  const { lib, calls, modules } = setup();
  delete modules[M.bizUtils].PlatformUtils;
  assert.deepEqual(lib.selfCheck('community').missing, [`${M.bizUtils} :: PlatformUtils.genSignData`]);
  await assert.rejects(lib.inspirationNav(), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.rankList({}), /INCOMPATIBLE_EDITOR/);
  assert.equal(calls.length, 0);
});

async function connect(deps) {
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ official, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('community tools use the lowest-pid window and previews show inspirations seen in this session', async () => {
  const seen = [];
  const fetched = [];
  const answers = {
    inspiration_list: { items: [{ inspiration_id: '1', title: '鎏花入镜', cover_url: 'https://c/1.png' }] },
    inspiration_detail: { inspiration_id: '2', title: '锦鲤妆', images: ['https://c/2.png', 'https://c/2b.png'] },
    rank_hotspots: { topic_id: '13439', tabs: [{ tab: '全部', inspirations: [{ inspiration_id: '3', title: '咕嘟', cover_url: null }] }] },
    tasks_list: { kind: 'growth', items: [{ task_id: 'g', kind: 'growth' }], raw: [{ kind: 'growth', item_id: null, extra: null }] },
    task_detail: { kind: 'growth', inspirations: [{ inspiration_id: '4', title: '重返2018', cover_url: 'https://c/4.png' }] },
    rank_list: { items: [] },
  };
  const client = await connect({
    listInstances: () => [{ pid: 300 }, { pid: 200 }],
    callPlugin: async (method, params, opts) => (seen.push({ method, params, opts }), answers[method]),
    fetchImage: async (url) => (fetched.push(url), { data: 'AAAA', mimeType: 'image/png' }),
  });
  const unknown = await client.callTool({ name: 'inspiration_preview', arguments: { inspiration_ids: ['1'] } });
  assert.match(unknown.content[0].text, /UNKNOWN_INSPIRATION: 1/);
  await client.callTool({ name: 'rank_list', arguments: { rank_type: 2, levels: ['S'], count: 5 } });
  assert.deepEqual(seen[0], { method: 'rank_list', params: { rank_type: 2, levels: ['S'], count: 5 }, opts: { pid: 200 } });
  await client.callTool({ name: 'inspiration_list', arguments: { project_path: '/proj/X' } });
  assert.deepEqual(seen[1].opts, { projectPath: '/proj/X' });
  await client.callTool({ name: 'inspiration_detail', arguments: { inspiration_id: '2' } });
  await client.callTool({ name: 'rank_hotspots', arguments: { topic_id: '13439' } });
  await client.callTool({ name: 'tasks_list', arguments: { kind: 'growth' } });
  await client.callTool({ name: 'task_detail', arguments: { task_id: 'g' } });
  const res = await client.callTool({ name: 'inspiration_preview', arguments: { inspiration_ids: ['1', '2', '3', '4'] } });
  assert.deepEqual(fetched, ['https://c/1.png', 'https://c/2.png', 'https://c/4.png']);
  assert.deepEqual(
    res.content.filter((c) => c.type === 'text').map((c) => c.text),
    ['鎏花入镜（inspiration_id 1）', '锦鲤妆（inspiration_id 2）', '咕嘟（inspiration_id 3）', '无封面图', '重返2018（inspiration_id 4）'],
  );
  for (const name of ['rank_list', 'rank_subjects']) {
    const tooMany = await client.callTool({ name, arguments: { count: 21 } });
    assert.equal(tooMany.isError, true, name);
  }
});

test('task tools take the tasks_list task_id and hand the plugin the id each task kind needs', async () => {
  const seen = [];
  const lists = {
    effect: {
      kind: 'effect',
      items: [
        { task_id: 'A1', kind: 'activity' },
        { task_id: '108117', kind: 'task' },
      ],
      raw: [
        { kind: 'activity', item_id: null, extra: { activity_id: 'A1' } },
        { kind: 'task', item_id: '108116', extra: null },
      ],
    },
    growth: { kind: 'growth', items: [{ task_id: 'headdress_decoration', kind: 'growth' }], raw: [{ kind: 'growth', item_id: null, extra: null }] },
  };
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (method === 'tasks_list') return lists[params.kind || 'effect'];
      if (method === 'task_detail') return { kind: params.kind, title: 't' };
      if (method === 'task_receive') return { title: 't', designer_task_id: '9001', status: 'WAIT_SUBMIT' };
      throw Error(`unexpected ${method}`);
    },
  });
  const call = async (name, args) => client.callTool({ name, arguments: args });
  assert.match((await call('task_detail', { task_id: '108117' })).content[0].text, /UNKNOWN_TASK: 108117/);
  const list = JSON.parse((await call('tasks_list', {})).content[0].text);
  assert.equal(list.raw, undefined);
  await call('tasks_list', { kind: 'growth' });
  assert.deepEqual(seen.map((s) => s.params), [{}, { kind: 'growth' }]);
  const detail = JSON.parse((await call('task_detail', { task_id: '108117' })).content[0].text);
  assert.deepEqual(seen.at(-1).params, { kind: 'task', id: '108116' });
  assert.equal(detail.task_id, '108117');
  await call('task_detail', { task_id: 'headdress_decoration' });
  assert.deepEqual(seen.at(-1).params, { kind: 'growth', id: 'headdress_decoration' });
  assert.match((await call('task_detail', { task_id: 'A1' })).content[0].text, /NO_TASK_DETAIL: A1 is an activity/);
  const got = JSON.parse((await call('task_receive', { task_id: '108117' })).content[0].text);
  assert.deepEqual(seen.at(-1).params, { item_id: '108116' });
  assert.deepEqual(got, { task_id: '108117', title: 't', designer_task_id: '9001', status: 'WAIT_SUBMIT' });
  assert.match((await call('task_receive', { task_id: 'headdress_decoration' })).content[0].text, /TASK_NOT_RECEIVABLE: headdress_decoration is not an effect task \(kind=growth\)/);
  assert.match((await call('task_receive', { task_id: 'A1' })).content[0].text, /TASK_NOT_RECEIVABLE: A1 is not an effect task \(kind=activity\)/);
  assert.match((await call('task_bind', { path: '/proj/X', task_id: 'headdress_decoration' })).content[0].text, /TASK_NOT_BINDABLE: headdress_decoration is a growth task/);
  assert.equal(seen.filter((s) => s.method === 'task_receive').length, 1);
});

test('server kind enums match the plugin tables', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const { tools } = await client.listTools();
  const props = (name) => tools.find((t) => t.name === name).inputSchema.properties;
  assert.deepEqual(props('rank_innovation_picks').kind.enum, Object.keys(PICK_KINDS));
  assert.deepEqual(props('rank_subjects').kind.enum, Object.keys(SUBJECT_KINDS));
});
