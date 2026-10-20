import { ancestors, join, parentOf, type Address } from "./address";
import { loadOrder, major } from "./loader";
import { Registry, type OverrideRecord, type Row } from "./registry";
import { Rng, hashHex } from "./rng";
import type {
  Ctx, Edge, EntityLike, EntityType, Field, Hooks, Module, SaveFile, Settings,
} from "./types";

const HOOK_FOR: Record<EntityType, keyof Hooks | undefined> = {
  settlement: "onSettlementGenerated",
  ward: "onWardResolved",
  building: "onBuildingResolved",
  household: "onHouseholdResolved",
  person: "onPersonResolved",
  business: undefined,
  institution: "onInstitutionResolved",
};

export const REROLL_KEY = "~reroll";

export class Entity implements EntityLike {
  readonly fields = new Map<string, Field>();
  readonly children: Address[] = [];
  resolved = false;

  constructor(readonly address: Address, readonly type: EntityType, private town: Town) {}

  get<T = unknown>(key: string): T {
    return this.town.read(this.address, key) as T;
  }

  /** The generated value, ignoring the overlay and pins. */
  generated<T = unknown>(key: string): T {
    return this.fields.get(key)?.value as T;
  }

  owner(key: string): string | undefined {
    return this.fields.get(key)?.module;
  }
}

export interface TownInit {
  seed: string;
  settings: Settings;
  modules: Module[];
  overlay?: SaveFile["overlay"];
  pinned?: SaveFile["pinned"];
  events?: SaveFile["events"];
  clock?: SaveFile["clock"];
}

export class Town {
  readonly seed: string;
  readonly settings: Settings;
  readonly modules: Module[];
  readonly root: Address;
  readonly overlay: SaveFile["overlay"];
  readonly pinned: SaveFile["pinned"];
  readonly events: SaveFile["events"];
  clock: SaveFile["clock"];
  readonly overrides: OverrideRecord[] = [];
  readonly warnings: string[] = [];

  private entities = new Map<Address, Entity>();
  private edgeMap = new Map<string, Edge>();
  private registries = new Map<string, Registry<Row>>();
  private ctxs = new Map<string, Ctx>();

  constructor(init: TownInit) {
    this.seed = init.seed;
    this.settings = { ...init.settings };
    this.modules = loadOrder(init.modules);
    this.overlay = structuredClone(init.overlay ?? {});
    this.pinned = structuredClone(init.pinned ?? {});
    this.events = structuredClone(init.events ?? []);
    this.clock = { ...(init.clock ?? { date: "1203-09-29", block: "forenoon" }) };
    this.root = `town:${hashHex(this.seed, 4)}`;

    for (const m of this.modules) for (const name of m.provides ?? []) {
      if (this.registries.has(name)) throw new Error(`registry ${name} provided twice`);
      this.registries.set(name, new Registry(name, this.overrides));
    }
    for (const m of this.modules) {
      m.register?.(
        (name, rows) => { for (const r of rows) this.registry(name).add(r, m.id); },
        (name, id, patch) => this.registry(name).override(id, patch as Partial<Row> | null, m.id),
      );
    }
    for (const m of this.modules) this.ctxs.set(m.id, this.makeCtx(m));

    const root = new Entity(this.root, "settlement", this);
    this.entities.set(this.root, root);
    this.resolveEntity(root);
  }

  // ---- reading ----------------------------------------------------------

  read(address: Address, key: string): unknown {
    const e = this.entities.get(address);
    // Reading a field is "looking at" the entity: generate it now if needed.
    if (e && !e.resolved) this.resolveEntity(e);
    const o = this.overlay[address];
    if (o && key in o) return o[key];
    const p = this.pinned[address];
    if (p && key in p) return p[key];
    return e?.fields.get(key)?.value;
  }

  /** Resolve an entity (and its ancestors) and return it. */
  get(address: Address): Entity {
    let e = this.entities.get(address);
    if (!e) {
      for (const a of ancestors(address)) {
        const anc = this.entities.get(a);
        if (!anc) throw new Error(`no entity at ${a}`);
        this.resolveEntity(anc);
      }
      e = this.entities.get(address);
      if (!e) throw new Error(`no entity at ${address}`);
    }
    this.resolveEntity(e);
    return e;
  }

  /** Like get, but returns undefined for addresses that don't exist. */
  find(address: Address): Entity | undefined {
    try {
      return this.get(address);
    } catch {
      return undefined;
    }
  }

  /** The entity as it stands, without resolving it. */
  peek(address: Address): Entity | undefined {
    return this.entities.get(address);
  }

  children(address: Address, type?: EntityType): Entity[] {
    const e = this.get(address);
    return e.children.map((c) => this.entities.get(c)!).filter((c) => !type || c.type === type);
  }

  settlement(): Entity {
    return this.get(this.root);
  }

  /** Resolve everything reachable from the root. Sifters need the whole graph. */
  resolveAll(): void {
    const queue = [this.root];
    while (queue.length) {
      const e = this.get(queue.shift()!);
      queue.push(...e.children);
    }
  }

  allEntities(): Entity[] {
    return [...this.entities.values()];
  }

  private societyState: "no" | "running" | "done" = "no";

  /** Run the settlement-wide phase (once). See Hooks.onSocietyResolved. */
  society(): void {
    if (this.societyState !== "no") return;
    this.societyState = "running";
    this.resolveAll();
    const root = this.entities.get(this.root)!;
    for (const m of this.modules) m.hooks?.onSocietyResolved?.(this.ctxs.get(m.id)!, root);
    this.societyState = "done";
  }

  edges(filter: { from?: Address; to?: Address; kind?: string; touching?: Address } = {}): Edge[] {
    this.society();
    let pool: Iterable<Edge> = this.edgeMap.values();
    // Towns have tens of thousands of edges; look up by endpoint when we can.
    const end = filter.from ?? filter.to ?? filter.touching;
    if (end) pool = this.edgeIndex().get(end) ?? [];
    const out: Edge[] = [];
    for (const e of pool) {
      if (filter.from && e.from !== filter.from) continue;
      if (filter.to && e.to !== filter.to) continue;
      if (filter.kind && e.kind !== filter.kind) continue;
      if (filter.touching && e.from !== filter.touching && e.to !== filter.touching) continue;
      out.push(e);
    }
    // Insertion order depends on what was looked at first; never let it leak.
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private index?: Map<Address, Edge[]>;

  private edgeIndex(): Map<Address, Edge[]> {
    if (this.index) return this.index;
    const ix = new Map<Address, Edge[]>();
    const put = (a: Address, e: Edge) => { const l = ix.get(a); if (l) l.push(e); else ix.set(a, [e]); };
    for (const e of this.edgeMap.values()) { put(e.from, e); if (e.to !== e.from) put(e.to, e); }
    this.index = ix;
    return ix;
  }

  registry<T extends Row>(name: string): Registry<T> {
    const r = this.registries.get(name);
    if (!r) throw new Error(`no registry "${name}"`);
    return r as unknown as Registry<T>;
  }

  hasModule(id: string): boolean {
    return this.modules.some((m) => m.id === id);
  }

  label(address: Address): string {
    const e = this.find(address);
    if (!e) return address;
    for (let i = this.modules.length - 1; i >= 0; i--) {
      const l = this.modules[i].label?.(this, e);
      if (l) return l;
    }
    return address.slice(address.lastIndexOf("/") + 1);
  }

  // ---- generation -------------------------------------------------------

  private resolveEntity(e: Entity): void {
    if (e.resolved) return;
    e.resolved = true;
    const hook = HOOK_FOR[e.type];
    if (!hook) return;
    for (const m of this.modules) {
      const fn = m.hooks?.[hook];
      if (fn) fn(this.ctxs.get(m.id)!, e);
    }
  }

  rngFor(address: Address, module: Module, purpose: string): Rng {
    return new Rng(`${this.seed}|${address}|${module.id}@${major(module.version)}|${purpose}`);
  }

  rerollCount(address: Address, key: string): number {
    const r = this.overlay[address]?.[REROLL_KEY] as Record<string, number> | undefined;
    return r?.[key] ?? 0;
  }

  private makeCtx(m: Module): Ctx {
    const town = this;
    const addr = (e: Address | { address: Address }) => (typeof e === "string" ? e : e.address);
    const setField = (e: Entity, key: string, value: unknown) => {
      const prev = e.fields.get(key);
      if (prev && prev.module !== m.id) {
        throw new Error(`${m.id} tried to write ${key} on ${e.address}, owned by ${prev.module}`);
      }
      e.fields.set(key, { module: m.id, value });
    };
    return {
      town,
      moduleId: m.id,
      era: town.settings.era,
      rng: (e, purpose = "") => town.rngFor(addr(e), m, purpose),
      gen(e, key, make) {
        const n = town.rerollCount(e.address, key);
        const value = make(town.rngFor(e.address, m, n ? `${key}#${n}` : key));
        setField(town.entities.get(e.address)!, key, value);
        return e.get(key);
      },
      set(e, key, value) {
        setField(town.entities.get(e.address)!, key, value);
      },
      create(type, parent, id, facts = {}) {
        const address = join(parent, type, id);
        let child = town.entities.get(address);
        if (!child) {
          const p = town.entities.get(parent);
          if (!p) throw new Error(`create under missing parent ${parent}`);
          child = new Entity(address, type, town);
          town.entities.set(address, child);
          p.children.push(address);
        }
        for (const [k, v] of Object.entries(facts)) setField(child, k, v);
        return child;
      },
      edge(spec) {
        const id = `${m.id}/${spec.kind}/${spec.from}>${spec.to}`;
        const edge: Edge = { knownBy: "public", ...spec, id, module: m.id };
        town.edgeMap.set(id, edge);
        town.index = undefined;
        return edge;
      },
      registry: (name) => town.registry(name),
    };
  }

  // ---- edits and saves --------------------------------------------------

  toSave(): SaveFile {
    const modules: Record<string, string> = {};
    for (const m of this.modules) modules[m.id] = m.version;
    return {
      format: 1,
      town: {
        seed: this.seed,
        era: this.settings.era,
        config: { base: this.settings.base, pop: this.settings.pop, ...(this.settings.lordship === "manorial" ? { lordship: "manorial" as const } : {}) },
      },
      modules,
      overlay: structuredClone(this.overlay),
      pinned: structuredClone(this.pinned),
      events: structuredClone(this.events),
      clock: { ...this.clock },
    };
  }

  /** Snapshot the generated state of an entity so generator upgrades leave it alone. */
  pinSnapshot(address: Address): Record<string, unknown> {
    const e = this.get(address);
    const snap: Record<string, unknown> = {};
    for (const [k, f] of e.fields) snap[k] = structuredClone(f.value);
    return snap;
  }

  /** Every field of every entity and every edge, keys sorted. For tests and diffing. */
  snapshot(): Record<string, unknown> {
    this.society();
    const entities: Record<string, unknown> = {};
    for (const a of [...this.entities.keys()].sort()) {
      const e = this.entities.get(a)!;
      const fields: Record<string, unknown> = {};
      for (const k of [...e.fields.keys()].sort()) {
        fields[k] = { module: e.fields.get(k)!.module, value: e.get(k) };
      }
      entities[a] = { type: e.type, fields };
    }
    const edges = [...this.edgeMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return { root: this.root, entities, edges };
  }

  parentOf(address: Address): Address | undefined {
    return parentOf(address);
  }
}

export function stableStringify(v: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(v), null, indent);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
