// eval body for scripts/call.mjs: dumps the source of every function exported by modules
// whose name matches `params.pattern`, including class prototype and static methods.
const re = new RegExp(PATTERN);
const out = [];
for (const name of Object.keys(orion)) {
  if (!re.test(name)) continue;
  let m;
  try { m = orion[name]; } catch (e) { out.push(`// ${name}: throws ${e}`); continue; }
  out.push(`\n//////// MODULE ${name}`);
  for (const k of Object.keys(m || {})) {
    let v;
    try { v = m[k]; } catch (e) { continue; }
    if (typeof v === 'function') {
      out.push(`// export ${k}\n${v.toString()}`);
      if (v.prototype) for (const p of Object.getOwnPropertyNames(v.prototype)) {
        if (p === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(v.prototype, p);
        for (const f of [d.value, d.get, d.set]) if (typeof f === 'function') out.push(`// ${k}.prototype.${p}\n${f.toString()}`);
      }
    } else if (v && typeof v === 'object') {
      try { out.push(`// export ${k} = ${JSON.stringify(v).slice(0, 4000)}`); } catch (_) { out.push(`// export ${k} (object)`); }
    } else {
      out.push(`// export ${k} = ${String(v).slice(0, 500)}`);
    }
  }
}
return out.join('\n');
