// Renders the L1 map as an SVG string. Pure: no DOM, so tests and the
// command-line preview can use it too. Buildings carry data-address.

import { burntSince } from "../modules/lives";
import type { Town } from "../core/town";
import type { MapData } from "../modules/layout";
import type { Poly, Pt } from "../modules/layout/geom";

const f = (n: number) => (Math.round(n * 10) / 10).toString();
const pts = (p: Pt[]) => p.map((v) => `${f(v[0])},${f(v[1])}`).join(" ");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function smoothPath(p: Pt[], closed: boolean): string {
  if (p.length < 3) return `M${pts(p)}`;
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 1; i < p.length - (closed ? 0 : 1); i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    d += ` Q${f(a[0])},${f(a[1])} ${f((a[0] + b[0]) / 2)},${f((a[1] + b[1]) / 2)}`;
  }
  if (!closed) d += ` L${f(p[p.length - 1][0])},${f(p[p.length - 1][1])}`;
  return closed ? d + "Z" : d;
}

export const MAP_STYLE = `
.m-bg{fill:var(--map-waste,#d9d4b8)}
.m-bg-moor{fill:var(--map-moor,#c9c0a4)}
.m-bg-hills{fill:var(--map-hills,#d3ccb0)}
.m-bg-forest{fill:var(--map-forest-floor,#c8cba6)}
.m-sea{fill:var(--map-sea,#9fbccb)}
.m-beach{fill:none;stroke:var(--map-sand,#e6d9b0);stroke-width:9;stroke-linejoin:round}
.m-surf{fill:none;stroke:var(--map-surf,#c5d9e2);stroke-width:1.2;stroke-dasharray:6 4}
.m-contour{fill:none;stroke:var(--map-contour,#a8916a);stroke-width:1;stroke-opacity:.55}
.m-track{fill:none;stroke:var(--map-road-edge,#b49c74);stroke-dasharray:4 2;stroke-linecap:round}
.m-boat{fill:var(--map-boat,#7a5a3a);stroke:var(--map-ink,#4a3f30);stroke-width:.3}
.m-racks{fill:none;stroke:var(--map-ink,#4a3f30);stroke-width:.4;stroke-dasharray:.6 .6}
.m-fold{fill:none;stroke:var(--map-wall,#8c8775);stroke-width:1.2}
.m-adit{fill:var(--map-ink,#4a3f30)}
.m-spoil{fill:var(--map-spoil,#9a958a);stroke:var(--map-wall,#8c8775);stroke-width:.5}
.m-clamp{fill:var(--map-ink,#4a3f30);fill-opacity:.7}
.m-slipway{fill:var(--map-plank,#b79a6e)}
.m-demesne{fill:none;stroke:var(--map-demesne,#7d5a2f);stroke-width:1.6;stroke-dasharray:5 3}
.m-use-manor{fill:var(--map-manor,#b0a07c)}
.m-vats{fill:var(--map-vats,#8a7a5a)}
.m-wood{fill:var(--map-wood,#8a9a6a);stroke:var(--map-wood-edge,#6d7d52);stroke-width:1.5}
.m-field{stroke:var(--map-field-edge,#b5ab82);stroke-width:1}
.m-crop-wheat{fill:var(--map-wheat,#e3d39a)}
.m-crop-barley{fill:var(--map-barley,#d6d79d)}
.m-crop-fallow{fill:var(--map-fallow,#cfc6a0)}
.m-stripe{stroke:var(--map-stripe,rgba(110,90,50,.22));stroke-width:1.1}
.m-meadow{fill:none;stroke:var(--map-meadow,#bccf95);stroke-linecap:round;stroke-linejoin:round}
.m-toftland{fill:var(--map-toft,#e2dcc4)}
.m-hedge{fill:none;stroke:var(--map-hedge,#6f8a4f);stroke-width:3.2;stroke-dasharray:1.5 1.8;stroke-linecap:round}
.m-plot{fill:var(--map-plot,#d8d1b2);stroke:var(--map-fence,#a2906a);stroke-width:.5}
.m-plot-churchyard{fill:var(--map-churchyard,#cfd2b0);stroke:var(--map-wall,#8c8775);stroke-width:1}
.m-green{fill:var(--map-green,#b9cc8e);stroke:var(--map-green-edge,#93a86c);stroke-width:.6}
.m-stream{fill:none;stroke:var(--map-water,#7fa3b5);stroke-linecap:round;stroke-linejoin:round}
.m-road-edge{fill:none;stroke:var(--map-road-edge,#b49c74);stroke-linecap:round;stroke-linejoin:round}
.m-road{fill:none;stroke:var(--map-road,#e8dcbc);stroke-linecap:round;stroke-linejoin:round}
.m-bld{stroke:var(--map-ink,#4a3f30);stroke-width:.55;cursor:pointer}
.m-bld:hover,.m-bld.sel{stroke:var(--map-sel,#a3341f);stroke-width:1.4}
.m-use-dwelling{fill:var(--map-thatch,#c6a565)}
.m-use-worship{fill:var(--map-stone,#aaa596)}
.m-use-mill{fill:var(--map-mill,#99866a)}
.m-use-trade{fill:var(--map-trade,#b98a55)}
.m-use-ale{fill:var(--map-ale,#b4703f)}
.m-use-craft{fill:var(--map-craft,#a98e64)}
.m-use-empty{fill:var(--map-empty,#ddd5c0);stroke-dasharray:1.2 .8}
.m-part{fill-opacity:.85}
.m-wheel{fill:var(--map-ink,#4a3f30)}
.m-hi{stroke:var(--map-hi,#c0392b);stroke-width:2.2}
.m-label{font-family:var(--map-font,'IM Fell English',Georgia,serif);fill:var(--map-ink,#4a3f30);text-anchor:middle}
.m-title{font-size:26px;letter-spacing:2px;paint-order:stroke;stroke:var(--map-halo,#efe8d6);stroke-width:4px;stroke-opacity:.75}
.m-crop-label{font-size:12px;font-style:italic;fill-opacity:.75}
.m-small{font-size:6px;font-style:italic}
.m-feature{fill:var(--map-ink,#4a3f30)}
.m-townground{fill:var(--map-street,#ddd0ae)}
.m-garden{fill:var(--map-garden,#c3cc9c);stroke:var(--map-fence,#a2906a);stroke-width:.3}
.m-market{fill:var(--map-market,#e2d6b4);stroke:var(--map-road-edge,#b49c74);stroke-width:.6}
.m-wall{fill:none;stroke:var(--map-wallstone,#6f6a5c);stroke-width:3.6;stroke-linejoin:round}
.m-wall-palisade{fill:none;stroke:var(--map-palisade,#7a5a3a);stroke-width:2;stroke-dasharray:2 1;stroke-linejoin:round}
.m-ditch{fill:none;stroke:var(--map-ditch,#a9b79a);stroke-width:9;stroke-linejoin:round;stroke-opacity:.7}
.m-tower{fill:var(--map-wallstone,#6f6a5c)}
.m-bailey{fill:var(--map-bailey,#cfc9b4);stroke:var(--map-wallstone,#6f6a5c);stroke-width:3.4;stroke-linejoin:round}
.m-plot-precinct{fill:var(--map-churchyard,#cfd2b0);stroke:var(--map-wallstone,#6f6a5c);stroke-width:1.2}
.m-bridge{fill:var(--map-stone,#aaa596);stroke:var(--map-ink,#4a3f30);stroke-width:.5}
.m-bridge-deck{fill:var(--map-stone,#c9bfa3);stroke:var(--map-ink,#4a3f30);stroke-width:.6}
.m-high{fill:none;stroke:var(--map-ink,#4a3f30);stroke-opacity:.22;stroke-width:1;stroke-dasharray:1.5 3;pointer-events:none}
.m-quay{fill:none;stroke:var(--map-wallstone,#6f6a5c);stroke-width:2.4}
.m-ward{font-size:13px;font-style:italic;fill-opacity:.8;paint-order:stroke;stroke:var(--map-halo,#efe8d6);stroke-width:3px;stroke-opacity:.7;cursor:pointer}
.m-ward:hover{fill:var(--map-sel,#a3341f)}
.m-use-civic{fill:var(--map-civic,#9c8f78)}
.m-use-military{fill:var(--map-military,#8a8578)}
.m-use-noble{fill:var(--map-noble,#b49a6a)}
.m-person{fill:var(--map-person,#a3341f);stroke:#fff8;stroke-width:.3;pointer-events:none}
.m-count{font-size:7px;font-weight:bold;fill:var(--map-person,#a3341f);pointer-events:none}
`;

function useClass(town: Town, use: string): string {
  const look = town.registry<{ id: string; look?: string }>("buildingUses").find(use)?.look;
  if (look) return look;
  switch (use) {
    case "farmhouse": case "cottage": case "carter": case "thatcher": case "weaver": case "fisher_house": case "herder_house":
    case "miner_house": case "logger_house": case "slater": case "carder": case "charcoal_burner": return "dwelling";
    case "chapel": case "shrine": return "worship";
    case "mill": return "mill";
    case "manor_house": return "manor";
    case "socman_house": return "dwelling";
    case "trader": case "wool_factor": case "assay_house": return "trade";
    case "alehouse": return "ale";
    case "empty": return "empty";
    default: return "craft";
  }
}

function cropClass(crop: string): string {
  return crop.startsWith("wheat") ? "wheat" : crop.startsWith("barley") || crop.startsWith("oats") ? "barley" : "fallow";
}

export interface MapOptions {
  selected?: string;
  highlight?: string[];
  width?: number;
  /** Crop to the hedge instead of the whole parish. */
  village?: boolean;
}

/** The map as an SVG string: fields, water, roads, wards, buildings (each a g with data-address), labels. */
export function renderMap(town: Town, opts: MapOptions = {}): string {
  const s = town.settlement();
  const m = s.get<MapData>("map");
  let [bx, by, bw, bh] = m.bounds;
  if (opts.village) {
    const xs = m.hedge.map((p) => p[0]), ys = m.hedge.map((p) => p[1]);
    const pad = 40;
    bx = Math.min(...xs) - pad; by = Math.min(...ys) - pad;
    bw = Math.max(...xs) - bx + pad; bh = Math.max(...ys) - by + pad;
    bw = bh = Math.max(bw, bh);
  }
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(bx)} ${f(by)} ${f(bw)} ${f(bh)}"${opts.width ? ` width="${opts.width}" height="${opts.width}"` : ""} class="town-map">`);
  out.push(`<style>${MAP_STYLE}</style>`);
  out.push("<defs>");
  m.fields.forEach((fp, i) => {
    out.push(`<pattern id="st${i}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(${fp.stripes})"><line class="m-stripe" x1="0" y1="0" x2="0" y2="5"/></pattern>`);
  });
  out.push("</defs>");
  const terrain = m.terrain ?? "farmland";
  out.push(`<rect class="m-bg m-bg-${terrain}" x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${f(bh)}"/>`);
  for (const c of m.contours ?? []) out.push(`<path class="m-contour" d="${smoothPath(c, true)}"/>`);
  for (const c of m.contourLines ?? []) out.push(`<path class="m-contour" d="${smoothPath(c, false)}"/>`);
  // A river town's high ground: soft lines of equal height.
  for (const c of m.high ?? []) out.push(`<path class="m-high" d="${smoothPath(c, false)}"><title>higher ground</title></path>`);

  for (const w of m.woods) out.push(`<path class="m-wood" d="${smoothPath(w, true)}"/>`);
  m.fields.forEach((fp, i) => {
    const crop = cropClass(m.greatFields[fp.field].crop);
    out.push(`<polygon class="m-field m-crop-${crop}" points="${pts(fp.poly)}"/>`);
    if (crop !== "fallow") out.push(`<polygon points="${pts(fp.poly)}" fill="url(#st${i})"/>`);
    if (fp.demesne) out.push(`<polygon class="m-demesne" points="${pts(fp.poly)}"><title>the lord's demesne</title></polygon>`);
  });
  const isTown = m.kind === "town";
  out.push(`<path class="m-meadow" stroke-width="${isTown ? 24 : 34}" d="${smoothPath(m.meadow, false)}"/>`);
  if (isTown) {
    if (m.enclosure !== "none") out.push(`<path class="m-ditch" d="${smoothPath(m.wall!.line, m.wall!.closed)}"/>`);
    out.push(`<polygon class="m-townground" points="${pts(m.hedge)}"/>`);
    for (const g of m.gardens ?? []) out.push(`<polygon class="m-garden" points="${pts(g)}"/>`);
    out.push(`<polygon class="m-market" points="${pts(m.market!)}"><title>the market place</title></polygon>`);
    if (m.farGreen) out.push(`<polygon class="m-green m-far-green" points="${pts(m.farGreen)}"><title>the village green</title></polygon>`);
    if (m.castle) out.push(`<polygon class="m-bailey" points="${pts(m.castle)}"><title>the castle bailey</title></polygon>`);
  } else out.push(`<path class="m-toftland" d="${smoothPath(m.hedge, true)}"/>`);

  const buildings = town.children(town.root, "building");
  for (const b of buildings) {
    const plot = b.get<Poly | undefined>("plot");
    if (!plot) continue;
    const kind = b.get<string>("plotKind");
    if (kind === "bailey") continue;
    out.push(`<polygon class="m-plot${kind === "churchyard" ? " m-plot-churchyard" : kind === "precinct" ? " m-plot-precinct" : ""}" points="${pts(plot)}"/>`);
  }
  if (!isTown) {
    out.push(`<polygon class="m-green" points="${pts(m.green)}"/>`);
    out.push(`<path class="m-hedge" d="${smoothPath(m.hedge, true)}"/>`);
  }
  out.push(`<path class="m-stream" stroke-width="${m.stream.width}" d="${smoothPath(m.stream.points, false)}"/>`);
  for (const r of m.roads) if (r.kind === "track") out.push(`<path class="m-track" stroke-width="${r.width}" d="${smoothPath(r.points, false)}"/>`);
  for (const r of m.roads) if (r.kind !== "track") out.push(`<path class="m-road-edge" stroke-width="${r.width + 1.2}" d="${smoothPath(r.points, false)}"/>`);
  for (const r of m.roads) if (r.kind !== "track") out.push(`<path class="m-road" stroke-width="${r.width}" d="${smoothPath(r.points, false)}"/>`);
  // A grown town's bridges: a stone deck across the water, along the road.
  const grown = !!m.plan && m.plan !== "radial";
  if (grown) for (const b of m.bridges ?? []) {
    const pts = m.stream.points;
    let bi = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
    const a = pts[Math.max(0, bi - 1)], c = pts[Math.min(pts.length - 1, bi + 1)];
    const tl = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    const t = [(c[0] - a[0]) / tl, (c[1] - a[1]) / tl], n = [-t[1], t[0]];
    const L = m.stream.width / 2 + 4, W = 4.5;
    const q = [[L, W], [L, -W], [-L, -W], [-L, W]].map(([u, v]) => `${f(b[0] + n[0] * u + t[0] * v)},${f(b[1] + n[1] * u + t[1] * v)}`).join(" ");
    out.push(`<polygon class="m-bridge-deck" points="${q}"><title>the bridge</title></polygon>`);
  }
  if (!grown) for (const b of m.bridges ?? []) {
    out.push(`<circle class="m-bridge" cx="${f(b[0])}" cy="${f(b[1])}" r="${f(m.stream.width * 0.75)}"><title>the bridge</title></circle>`);
  }
  if (m.coast && m.sea) {
    out.push(`<path class="m-beach" d="${smoothPath(m.coast, false)}"/>`);
    out.push(`<polygon class="m-sea" points="${pts(m.sea)}"/>`);
    out.push(`<path class="m-surf" d="${smoothPath(m.coast, false)}"/>`);
  }
  if (m.quay) out.push(`<path class="m-quay" d="M${pts(m.quay)}"><title>the quay</title></path>`);
  if (isTown && m.wall && m.enclosure !== "none") {
    const cls = m.enclosure === "wall" ? "m-wall" : m.enclosure === "palisade" ? "m-wall-palisade" : "m-hedge";
    out.push(`<path class="${cls}" d="${smoothPath(m.wall.line, m.wall.closed)}"><title>the town ${m.enclosure === "wall" ? "wall" : m.enclosure}</title></path>`);
    for (const t of m.wall.towers) out.push(`<circle class="m-tower" cx="${f(t[0])}" cy="${f(t[1])}" r="3.4"/>`);
  }
  for (const ft of m.features) {
    if (ft.kind === "spoil" && ft.poly) out.push(`<path class="m-spoil" d="${smoothPath(ft.poly, true)}"><title>spoil heap</title></path>`);
    if (ft.kind === "boat" && ft.poly) out.push(`<polygon class="m-boat" points="${pts(ft.poly)}"><title>a boat drawn up on the beach</title></polygon>`);
    if (ft.kind === "racks" && ft.poly) out.push(`<polygon class="m-racks" points="${pts(ft.poly)}"><title>fish-drying racks</title></polygon>`);
    if (ft.kind === "fold") out.push(`<circle class="m-fold" cx="${f(ft.p[0])}" cy="${f(ft.p[1])}" r="7"><title>a sheepfold</title></circle>`);
    if (ft.kind === "adit") out.push(`<path class="m-adit" d="M${f(ft.p[0] - 3)},${f(ft.p[1] + 1.5)} a3,3 0 0 1 6,0 Z"><title>a mine entrance</title></path>`);
    if (ft.kind === "clamp") out.push(`<circle class="m-clamp" cx="${f(ft.p[0])}" cy="${f(ft.p[1])}" r="3"><title>a charcoal clamp, smoking</title></circle>`);
  }

  const hi = new Set(opts.highlight ?? []);
  for (const b of buildings) {
    const use = b.get<string>("use");
    const burnt = burntSince(town, b.address, town.clock.date);
    const cls = `m-bld m-use-${useClass(town, use)}${burnt ? " m-burnt" : ""}${opts.selected === b.address ? " sel" : ""}${hi.has(b.address) ? " m-hi" : ""}`;
    const title = esc(town.label(b.address));
    out.push(`<g data-address="${esc(b.address)}"><title>${title}</title>`);
    for (const p of b.get<{ kind: string; poly: Poly }[]>("parts") ?? []) {
      if (p.kind === "wheel") out.push(`<polygon class="m-wheel" points="${pts(p.poly)}"/>`);
      else if (p.kind === "slipway" || p.kind === "vats") out.push(`<polygon class="m-${p.kind}" points="${pts(p.poly)}"/>`);
      else out.push(`<polygon class="${cls} m-part" points="${pts(p.poly)}"/>`);
    }
    out.push(`<polygon class="${cls}" points="${pts(b.get<Poly>("poly"))}"/></g>`);
  }

  for (const ft of m.features) {
    if (ft.kind === "cross") out.push(`<path class="m-feature" d="M${f(ft.p[0] - 2)},${f(ft.p[1])}h4M${f(ft.p[0])},${f(ft.p[1] - 2)}v4" stroke="currentColor" stroke-width=".9"><title>the market cross</title></path>`);
    if (ft.kind === "well") out.push(`<circle class="m-feature" cx="${f(ft.p[0])}" cy="${f(ft.p[1])}" r="1.2"><title>the well</title></circle>`);
    if (ft.kind === "stocks") out.push(`<rect class="m-feature" x="${f(ft.p[0] - 1.5)}" y="${f(ft.p[1] - 0.4)}" width="3" height="0.8"><title>the stocks</title></rect>`);
    if (ft.kind === "pillory") out.push(`<path class="m-feature" d="M${f(ft.p[0])},${f(ft.p[1] + 2)}v-4M${f(ft.p[0] - 1.5)},${f(ft.p[1] - 1.4)}h3" stroke="currentColor" stroke-width=".8"><title>the pillory</title></path>`);
    if (ft.kind === "conduit") out.push(`<rect class="m-feature m-conduit" x="${f(ft.p[0] - 1.6)}" y="${f(ft.p[1] - 1.6)}" width="3.2" height="3.2"><title>the conduit: the town's water, piped from a spring</title></rect>`);
    if (ft.kind === "gallows") out.push(`<g class="m-landmark"><path d="M${f(ft.p[0] - 2.5)},${f(ft.p[1] + 3)}v-6h5v1.6" stroke="currentColor" stroke-width="1" fill="none"/><text class="m-label m-small" x="${f(ft.p[0] + 4)}" y="${f(ft.p[1] + 1)}">gallows</text><title>the common gallows, outside the gate</title></g>`);
    if (ft.kind === "butts") out.push(`<g class="m-landmark"><rect x="${f(ft.p[0] - 4)}" y="${f(ft.p[1] - 1)}" width="2" height="2" fill="currentColor"/><rect x="${f(ft.p[0] + 3)}" y="${f(ft.p[1] - 1)}" width="2" height="2" fill="currentColor"/><title>the butts, where the men shoot on Sundays</title></g>`);
    if (ft.kind === "bridge_chapel") out.push(`<g class="m-landmark"><path d="M${f(ft.p[0] - 1.5)},${f(ft.p[1] - 3.5)}h3M${f(ft.p[0])},${f(ft.p[1] - 5)}v3" stroke="currentColor" stroke-width=".8"/><title>the bridge chapel, where travellers give thanks and pay a penny for the bridge</title></g>`);
  }

  for (const g of m.greatFields) {
    if (m.sea && pointInSea(m, g.label)) continue;
    out.push(`<text class="m-label m-crop-label" x="${f(g.label[0])}" y="${f(g.label[1])}">${esc(g.crop === "fallow" ? "the fallow field" : `${g.crop} field`)}</text>`);
  }
  if (isTown) for (const w of town.children(town.root, "ward")) {
    const c = w.get<Pt>("centre");
    const name = w.get<string>("name");
    if (c && name) out.push(`<g data-address="${esc(w.address)}"><title>${esc(name)}</title><text class="m-label m-ward" x="${f(c[0])}" y="${f(c[1])}">${esc(name)}</text></g>`);
  }
  const [tx, ty] = titleAt(m, buildings.map((b) => b.get<Poly>("poly")), town.label(town.root));
  out.push(`<text class="m-label m-title" x="${f(tx)}" y="${f(ty)}">${esc(town.label(town.root))}</text>`);
  out.push("</svg>");
  return out.join("");
}

/** Where the settlement's name goes: above it, centred if that's clear, else
 *  slid sideways or put below, wherever the fewest roads and roofs are under it.
 *  Never out at sea. */
function titleAt(m: MapData, roofs: Poly[], name: string): Pt {
  const xs = m.hedge.map((p) => p[0]);
  const top = Math.min(...m.hedge.map((p) => p[1]));
  const bottom = Math.max(...m.hedge.map((p) => p[1]));
  const cx = m.hedge.reduce((a, p) => a + p[0], 0) / m.hedge.length;
  const span = Math.max(...xs) - Math.min(...xs);
  const w = name.length * 16 + 10, h = 28;
  const marks: Pt[] = [];
  for (const r of m.roads) for (let i = 0; i + 1 < r.points.length; i++) {
    const [a, b] = [r.points[i], r.points[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let k = 0; k < n; k++) marks.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  for (const p of roofs) if (p) marks.push(...p);
  const under = ([x, y]: Pt) => marks.filter(([px, py]) => Math.abs(px - x) < w / 2 && py > y - h + 4 && py < y + 8).length;
  const cands: Pt[] = [];
  for (const dy of [16, 46]) for (const dx of [0, -0.22, 0.22, -0.4, 0.4]) cands.push([cx + dx * span, top - dy]);
  for (const dx of [0, -0.25, 0.25]) cands.push([cx + dx * span, bottom + 40]);
  let best = cands[0], bestN = Infinity;
  for (const c of cands) {
    if (m.sea && pointInSea(m, c)) continue;
    const n = under(c);
    if (n < bestN) { best = c; bestN = n; }
    if (n === 0) break;
  }
  return best;
}

/** Dots for people, by where they are this block. Drawn over the map. */
export function renderPeople(town: Town, occ: Map<string, string[]>): string {
  const m = town.settlement().get<MapData>("map");
  const out: string[] = ['<g class="m-people">'];
  const dots = (c: Pt, n: number, spread: number, label?: string) => {
    for (let i = 0; i < n; i++) {
      // A sunflower spiral keeps dots apart without randomness.
      const a = i * 2.39996, rr = spread * Math.sqrt((i + 0.5) / Math.max(n, 1));
      out.push(`<circle class="m-person" cx="${f(c[0] + rr * Math.cos(a))}" cy="${f(c[1] + rr * Math.sin(a))}" r="1.1"/>`);
    }
    if (label) out.push(`<text class="m-label m-count" x="${f(c[0])}" y="${f(c[1] - spread - 3)}">${esc(label)}</text>`);
  };
  for (const b of town.children(town.root, "building")) {
    const n = occ.get(b.address)?.length ?? 0;
    if (!n) continue;
    const poly = b.get<Poly>("poly");
    const c: Pt = [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
    dots(c, n, 1.4 + Math.sqrt(n) * 1.1, n >= 6 ? String(n) : undefined);
  }
  const gn = occ.get("place:green")?.length ?? 0;
  if (gn) {
    const gc: Pt = [m.green.reduce((s, p) => s + p[0], 0) / m.green.length, m.green.reduce((s, p) => s + p[1], 0) / m.green.length];
    dots(gc, gn, 2 + Math.sqrt(gn) * 1.4, gn >= 6 ? String(gn) : undefined);
  }
  const centre = (ps: Pt[]): Pt => [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  const hc = centre(m.hedge);
  const say = (key: string, at: Pt | undefined, text: (n: number) => string) => {
    const n = occ.get(key)?.length ?? 0;
    if (n && at) out.push(`<text class="m-label m-count" x="${f(at[0])}" y="${f(at[1])}">${esc(text(n))}</text>`);
  };
  if (m.coast && m.sea) {
    const near = m.coast.reduce((a, b) => (Math.hypot(b[0] - hc[0], b[1] - hc[1]) < Math.hypot(a[0] - hc[0], a[1] - hc[1]) ? b : a));
    const away = [near[0] - hc[0], near[1] - hc[1]], l = Math.hypot(away[0], away[1]) || 1;
    // Off to one side of the village along the shore, so the labels don't sit on the name.
    const along = m.coast[Math.min(m.coast.length - 1, m.coast.indexOf(near) + 9)];
    say("place:sea", [along[0] + (away[0] / l) * 70, along[1] + (away[1] / l) * 70], (n) => `${n} at sea`);
    say("place:shore", [along[0] + (away[0] / l) * 10, along[1] + (away[1] / l) * 10], (n) => `${n} on the beach`);
  }
  say("place:mine", m.features.find((x) => x.kind === "adit")?.p, (n) => `${n} down the mine`);
  const dem = m.fields.find((x) => x.demesne);
  say("place:demesne", dem ? centre(dem.poly) : undefined, (n) => `${n} on the lord's demesne`);
  say("place:woods", m.woods[0] ? centre(m.woods[0]) : undefined, (n) => `${n} in the woods`);
  say("place:pasture", m.features.find((x) => x.kind === "fold")?.p, (n) => `${n} on the pasture`);
  for (const g of m.greatFields) {
    const n = occ.get("place:fields")?.length ?? 0;
    if (n) { out.push(`<text class="m-label m-count" x="${f(g.label[0])}" y="${f(g.label[1] + 16)}">${n} at work in the fields</text>`); break; }
  }
  out.push("</g>");
  return out.join("");
}

function pointInSea(m: MapData, p: Pt): boolean {
  const poly = m.sea!;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
