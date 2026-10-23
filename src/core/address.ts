// Addresses are paths from the settlement root:
//   town:7f3a/building:b017/household:0/person:2
// An address is enough to regenerate the entity: resolving it resolves its
// ancestors first, and they create it.

export type Address = string;

/** One step of an address: `building:b017` is type "building", id "b017". */
export interface Segment {
  type: string;
  id: string;
}

/** Split an address into its steps; throws on a malformed one. */
export function parse(address: Address): Segment[] {
  return address.split("/").map((part) => {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`bad address segment "${part}" in ${address}`);
    return { type: part.slice(0, i), id: part.slice(i + 1) };
  });
}

/** The address of a child: parent, then `type:id`. */
export function join(parent: Address, type: string, id: string): Address {
  if (id.includes("/") || id.includes(":")) throw new Error(`bad id "${id}"`);
  return `${parent}/${type}:${id}`;
}

/** The address one step up, or undefined at the root. */
export function parentOf(address: Address): Address | undefined {
  const i = address.lastIndexOf("/");
  return i < 0 ? undefined : address.slice(0, i);
}

/** Every address above this one, root first. */
export function ancestors(address: Address): Address[] {
  const out: Address[] = [];
  let a = parentOf(address);
  while (a) {
    out.unshift(a);
    a = parentOf(a);
  }
  return out;
}

/** What kind of thing an address names: "person", "building"… */
export function typeOf(address: Address): string {
  const segs = parse(address);
  return segs[segs.length - 1].type;
}

/** The last step's id: `…/person:2` -> "2". */
export function localId(address: Address): string {
  const segs = parse(address);
  return segs[segs.length - 1].id;
}
