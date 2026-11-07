// Reads a project's makeup layers (FaceMask, EyeColorV2) from its scene file and tells, for each one,
// which part of the face it paints and in what colour: layer names in published works are often
// generic (面具1, 脸部妆容 (2)), so the part comes from the layer's region and its texture's pixels.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { sniffImage } from './images.mjs';
import { loadScene } from './scenefile.mjs';

// FaceMask (type, regionType) → the face area its texture is laid out for. These five pairs cover
// all 109 FaceMask layers of 13 projects (our own and homepage best sellers, 2026-11-07); any other
// pair is reported as it is, without a part.
const REGIONS = {
  'FACEU_MASK/0': '全脸',
  'FACEU_EYEPART/1': '眼部',
  'FACEU_JIEMAO/2': '睫毛',
  'FACEU_LIPS_KEYPOINT/3': '唇部',
  'FACEU_LIPS_KEYPOINT/4': '牙齿',
};

// Checked in order on the layer name; the first match wins (唇面高光 is a highlight, not a lipstick).
const NAME_PARTS = [
  [/睫毛/, '睫毛'],
  [/眼线/, '眼线'],
  [/卧蚕/, '卧蚕'],
  [/眉/, '眉毛'],
  [/腮红/, '腮红'],
  [/修容|鼻影/, '修容'],
  [/高光|提亮|亮片|闪/, '高光'],
  [/痣/, '痣'],
  [/雀斑/, '雀斑'],
  [/口红|唇/, '口红'],
  [/眼影|眼妆/, '眼影'],
];
// A name only decides the part when it fits the region the texture is laid out for.
const NAME_FITS = {
  眼部: ['睫毛', '眼线', '卧蚕', '高光', '眼影', '修容'],
  唇部: ['口红', '高光'],
};

// Pixel rules, from the textures of the same 109 layers (positions are fractions of the texture):
// neutral-grey full-face maps (rgb 125–128, 73–100 % covered) are light/shadow maps blended over the
// skin; brows sit at y 0.39–0.40 and are under 0.07 tall; nose highlights are about 0.12 wide;
// freckles, moles and sparkles cover under 0.1 % of the texture; blush and cheek contour sit at
// y 0.51–0.64. In the eye layout liners are bands 0.09–0.20 tall, lower-lid lines sit at y 0.70 and
// below, highlights are near white.
function partFromPixels(region, s) {
  if (region === '唇部') return s.hsl[2] >= 80 ? '唇部高光' : '口红';
  if (region === '眼部') {
    if (s.hsl[2] >= 80) return '高光';
    if (s.cy >= 0.68) return '卧蚕';
    if (s.height <= 0.2) return '眼线';
    return '眼影';
  }
  if (s.coverage > 0.5 && s.hsl[1] < 8 && Math.abs(s.hsl[2] - 50) < 6) return '明暗';
  if (s.cy < 0.45 && s.height < 0.1) return '眉毛';
  if (s.width <= 0.15 && Math.abs(s.cx - 0.5) < 0.05) return '鼻部';
  if (s.coverage < 0.001) return '点缀';
  if (s.cy >= 0.45 && s.cy <= 0.75) return '腮红/修容';
  return '全脸其他';
}

// The look's coverage, by the groups a makeup artist checks.
const GROUPS = ['眉', '眼妆', '美瞳', '颊', '轮廓', '唇', '点缀', '其他'];
// Groups every full look is expected to decide on; 点缀 and 其他 are optional.
const CORE_GROUPS = ['眉', '眼妆', '美瞳', '颊', '轮廓', '唇'];
const EYE_PARTS = ['眼影', '眼线', '睫毛', '卧蚕'];
// The runtime classes of FaceMask and EyeColorV2: seen under these names only when the editor's side
// (main.scene.extra) is missing, which also loses their region and texture.
const RUNTIME_ONLY = ['EffectFaceMakeupFaceU', 'EyeColor'];

function groupOf(region, part) {
  if (region === '眼部' || region === '睫毛') return '眼妆';
  if (region === '唇部') return '唇';
  if (region === '美瞳') return '美瞳';
  if (region === '牙齿') return null;
  if (part === '眉毛') return '眉';
  if (EYE_PARTS.includes(part)) return '眼妆';
  if (part === '腮红' || part === '腮红/修容') return '颊';
  if (['修容', '明暗', '鼻部', '高光'].includes(part)) return '轮廓';
  if (['痣', '雀斑', '点缀'].includes(part)) return '点缀';
  if (part === '口红') return '唇';
  return '其他';
}

function hsl(r, g, b) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [Math.round(((h * 60) + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

// Alpha-weighted colour and placement of a texture's painted pixels. Pixels under 5 % alpha (texture
// noise) do not count.
export function textureStats(file) {
  const buf = fs.readFileSync(file);
  if (sniffImage(buf) !== 'image/png') throw Error('不是 PNG，没有分析像素');
  const { width: w, height: h, data } = PNG.sync.read(buf);
  let sum = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      if (a < 0.05) continue;
      sum += a;
      sx += x * a;
      sy += y * a;
      r += data[i] * a;
      g += data[i + 1] * a;
      b += data[i + 2] * a;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!sum) throw Error('贴图全透明');
  const round = (v) => Number(v.toFixed(3));
  return {
    color: hex(r / sum, g / sum, b / sum),
    hsl: hsl(r / sum, g / sum, b / sum),
    coverage: round(sum / (w * h)),
    cx: round(sx / sum / w),
    cy: round(sy / sum / h),
    width: round((x1 - x0 + 1) / w),
    height: round((y1 - y0 + 1) / h),
  };
}

function textureFile(projectDir, tex) {
  if (tex && typeof tex === 'object' && tex.file) return { file: path.join(projectDir, 'Assets', tex.file), rel: tex.file };
  if (tex && typeof tex === 'object' && tex.builtin) return { note: '内置贴图，没有分析像素' };
  return { note: `贴图不在工程里（${typeof tex === 'string' ? tex : JSON.stringify(tex)}）` };
}

export function makeupLayers(projectDir) {
  const scene = loadScene(projectDir);
  const notes = [...scene.unreadable.map((u) => `资源描述文件读不了：${u}`)];
  const stats = new Map();
  const statsOf = (file) => {
    if (!stats.has(file)) {
      try {
        stats.set(file, textureStats(file));
      } catch (e) {
        stats.set(file, { error: e.message });
      }
    }
    return stats.get(file);
  };

  const layers = [];
  const blind = [];
  const visit = (nodes, parents, shown) => {
    for (const n of nodes) {
      const names = [...parents, n.name];
      const visible = shown && n.visible;
      for (const c of scene.inspect(n.guid).components) {
        if (RUNTIME_ONLY.includes(c.type)) blind.push(`${n.guid} ${n.name}`);
        if (c.type !== 'FaceMask' && c.type !== 'EyeColorV2') continue;
        const p = c.properties;
        const eye = c.type === 'EyeColorV2';
        const region = eye ? '美瞳' : REGIONS[`${p.type}/${p.regionType}`] ?? `${p.type}/${p.regionType}`;
        const female = eye ? p.intensity : p.femaleIntensity;
        const male = eye ? p.intensity : p.maleIntensity;
        const off = !visible ? '隐藏' : p.enabled === false ? '组件停用' : !female && !male ? '强度为 0' : null;
        const layer = { object: n.guid, name: n.name, path: names.join('/'), active: !off, ...(off ? { off } : {}), region, part: null, part_from: null, female, male };
        const tex = textureFile(projectDir, p.makeupTexture);
        let s = null;
        if (tex.file) {
          layer.texture = tex.rel;
          s = statsOf(tex.file);
          if (s.error) {
            layer.texture_note = s.error;
            s = null;
          } else Object.assign(layer, { color: s.color, hsl: s.hsl });
        } else layer.texture_note = tex.note;
        if (eye && p.color) layer.tint = hex(p.color.r * 255, p.color.g * 255, p.color.b * 255);

        const named = NAME_PARTS.find(([re]) => re.test(n.name))?.[1];
        if (eye) [layer.part, layer.part_from] = ['美瞳', '组件'];
        else if (region === '睫毛') [layer.part, layer.part_from] = ['睫毛', '区域'];
        else if (region === '牙齿') [layer.part, layer.part_from] = ['牙齿美白', '区域'];
        else if (!REGIONS[`${p.type}/${p.regionType}`]) notes.push(`${n.guid} ${n.name}：没见过的妆容区域 ${region}，没有判断部位`);
        else if (named && (!NAME_FITS[region] || NAME_FITS[region].includes(named))) {
          layer.part = region === '唇部' && named === '高光' ? '唇部高光' : named;
          layer.part_from = '层名';
        } else if (s) [layer.part, layer.part_from] = [partFromPixels(region, s), '贴图'];
        layers.push(layer);
      }
      visit(n.children, names, visible);
    }
  };
  visit(scene.tree({ depth: Infinity }), [], true);
  if (blind.length) throw Error(`MAKEUP_EDITOR_DATA_MISSING: ${blind.length} 个妆容组件在 main.scene.extra 里没有编辑器数据，读不出区域和贴图（${blind.join('、')}）`);

  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const l of layers) {
    const g = l.active && groupOf(l.region, l.part);
    if (g) groups[g].push(`${l.object} ${l.name}（${l.part ?? l.region}，女 ${l.female} / 男 ${l.male}）`);
  }
  return { layers, groups, absent: CORE_GROUPS.filter((g) => !groups[g].length), notes };
}
