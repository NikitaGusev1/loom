// Figma extraction script — runs inside figma_execute plugin sandbox.
// Agents read this file, replace placeholders, and pass the entire string to figma_execute.
// Placeholders: __NODE_ID__ (required), __MAX_DEPTH__ (optional, defaults to 8)
// NOT a Node.js module — no require/import/export.

const NODE_ID = '__NODE_ID__';
const MAX_DEPTH = Math.max(2, '__MAX_DEPTH__' !== '' && !isNaN(Number('__MAX_DEPTH__')) ? Number('__MAX_DEPTH__') : 8);

const node = await figma.getNodeByIdAsync(NODE_ID);
if (!node) return { error: 'Node not found' };

const MIXED = figma.mixed;

function safe(v) { return (typeof v === 'symbol' || v === MIXED) ? 'MIXED' : v; }

function hex(c) {
  if (!c || typeof c.r !== 'number') return null;
  const rgb = [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  if (typeof c.a === 'number' && c.a < 1) {
    return '#' + rgb + Math.round(c.a * 255).toString(16).padStart(2, '0');
  }
  return '#' + rgb;
}

async function resolveVar(bv, prop) {
  try {
    if (!bv?.[prop]) return null;
    const varId = bv[prop].id;
    const v = await figma.variables.getVariableByIdAsync(varId);
    return v ? { name: v.name, id: varId } : null;
  } catch { return null; }
}

function extractSolids(arr, MIXED) {
  if (!arr || arr === MIXED || !Array.isArray(arr)) return null;
  const solid = arr.filter(f => f.type === 'SOLID' && f.visible !== false);
  return solid.length ? solid : null;
}

// Count non-solid fills (IMAGE, GRADIENT_*) so consumers know they were present but dropped
function countNonSolids(arr, MIXED) {
  if (!arr || arr === MIXED || !Array.isArray(arr)) return 0;
  return arr.filter(f => f.type !== 'SOLID' && f.visible !== false).length;
}

// Full property extraction at every depth — only tree recursion is limited by MAX_DEPTH.
async function ext(n, d) {
  const r = { nm: n.name, tp: n.type, nid: n.id };
  const varPromises = [];

  try { if (n.visible === false) r.vis = false; } catch {}

  try { r.w = Math.round(n.width); r.h = Math.round(n.height); } catch {}

  try {
    const bb = n.absoluteBoundingBox;
    if (bb) {
      r.abb = { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height) };
    } else if (n.visible !== false) {
      throw new Error(`absoluteBoundingBox missing on visible node "${n.name}" (${n.type}, ${n.id})`);
    }
  } catch (e) { if (e.message?.startsWith('absoluteBoundingBox missing')) throw e; }

  try {
    if (n.layoutMode && n.layoutMode !== 'NONE') {
      r.lay = { dir: n.layoutMode, gap: safe(n.itemSpacing),
        pad: [safe(n.paddingTop), safe(n.paddingRight), safe(n.paddingBottom), safe(n.paddingLeft)],
        hS: safe(n.layoutSizingHorizontal), vS: safe(n.layoutSizingVertical) };
    }
  } catch {}

  try {
    const solid = extractSolids(n.fills, MIXED);
    if (solid) {
      r.bg = solid.map(f => ({ hex: hex(f.color), a: f.opacity < 1 ? f.opacity : undefined, v: null, vid: null }));
      solid.forEach((f, i) => varPromises.push(
        resolveVar(f.boundVariables, 'color').then(rv => { if (rv) { r.bg[i].v = rv.name; r.bg[i].vid = rv.id; } })
      ));
    }
    const ns = countNonSolids(n.fills, MIXED);
    if (ns > 0) r.nonSolidFills = ns;
  } catch {}

  try {
    const solid = extractSolids(n.strokes, MIXED);
    if (solid) {
      r.border = solid.map(s => ({ hex: hex(s.color), sw: safe(n.strokeWeight), v: null, vid: null }));
      solid.forEach((s, i) => varPromises.push(
        resolveVar(s.boundVariables, 'color').then(rv => { if (rv) { r.border[i].v = rv.name; r.border[i].vid = rv.id; } })
      ));
    }
  } catch {}

  try {
    if (n.type === 'TEXT') {
      const fs = safe(n.fontSize);
      const fn = (n.fontName !== MIXED && typeof n.fontName === 'object') ? n.fontName.style : 'MIXED';
      const lh = (n.lineHeight !== MIXED && typeof n.lineHeight === 'object') ? n.lineHeight.value : null;
      r.txt = { ch: String(n.characters), sz: fs, st: fn, lh: safe(lh) };
      const fills = n.fills;
      if (fills && fills !== MIXED && fills[0]?.type === 'SOLID') {
        r.txt.clr = hex(fills[0].color);
        r.txt.cv = null;
        r.txt.cvid = null;
        varPromises.push(
          resolveVar(fills[0].boundVariables, 'color').then(rv => { if (rv) { r.txt.cv = rv.name; r.txt.cvid = rv.id; } })
        );
      }
    }
  } catch {}

  try { const cr = n.cornerRadius; if (cr && cr !== MIXED && cr > 0) r.rad = cr; } catch {}

  try {
    if (n.effects?.length) {
      r.fx = n.effects.filter(e => e.visible !== false).map(e => ({
        t: e.type, b: e.radius, c: e.color ? hex(e.color) : null, a: e.color?.a }));
    }
  } catch {}

  // Variant detection — INSTANCE variantProperties, COMPONENT_SET componentPropertyDefinitions
  try {
    if (n.type === 'INSTANCE' && n.variantProperties) {
      const vp = n.variantProperties;
      if (Object.keys(vp).length) r.variants = vp;
    } else if (n.type === 'COMPONENT_SET' && n.componentPropertyDefinitions) {
      const defs = n.componentPropertyDefinitions;
      const vd = {};
      for (const [k, v] of Object.entries(defs)) {
        if (v.type === 'VARIANT') vd[k] = { opts: v.variantOptions || [] };
      }
      if (Object.keys(vd).length) r.variants = vd;
    }
  } catch {}

  // Icon resolution — resolve mainComponent name for INSTANCE nodes
  try {
    if (n.type === 'INSTANCE') {
      const mc = await n.getMainComponentAsync();
      if (mc) {
        r.icon = { name: mc.name };
        if (mc.parent && mc.parent.type === 'COMPONENT_SET') {
          r.icon.setName = mc.parent.name;
        }
      }
    }
  } catch {}

  // Children — only recurse within depth limit; wrap each child so one failure doesn't lose siblings
  if (d <= MAX_DEPTH) {
    try {
      if ('children' in n && n.children.length) {
        r.kids = [];
        for (const c of n.children) {
          try {
            r.kids.push(await ext(c, d + 1));
          } catch (e) {
            if (e.message?.startsWith('absoluteBoundingBox missing')) throw e;
            r.kids.push({ nm: c.name || '?', tp: c.type || '?', nid: c.id || '?', error: String(e?.message || e) });
          }
        }
      }
    } catch {}
  }

  await Promise.all(varPromises);
  return r;
}

return await ext(node, 0);
