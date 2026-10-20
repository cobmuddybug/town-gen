// Addresses are paths from the settlement root:
//   town:7f3a/building:b017/household:0/person:2
// An address is enough to regenerate the entity: resolving it resolves its
// ancestors first, and they create it.

export type Address = string;

export interface Segment {
  type: string;
  id: string;
}

export function parse(address: Address): Segment[] {
  return address.split("/").map((part) => {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`bad address segment "${part}" in ${address}`);
    return { type: part.slice(0, i), id: part.slice(i + 1) };
  });
}

export function join(parent: Address, type: string, id: string): Address {
  if (id.includes("/") || id.includes(":")) throw new Error(`bad id "${id}"`);
  return `${parent}/${type}:${id}`;
}

export function parentOf(address: Address): Address | undefined {
  const i = address.lastIndexOf("/");
  return i < 0 ? undefined : address.slice(0, i);
}

export function ancestors(address: Address): Address[] {
  const out: Address[] = [];
  let a = parentOf(address);
  while (a) {
    out.unshift(a);
    a = parentOf(a);
  }
  return out;
}

export function typeOf(address: Address): string {
  const segs = parse(address);
  return segs[segs.length - 1].type;
}

export function localId(address: Address): string {
  const segs = parse(address);
  return segs[segs.length - 1].id;
}
