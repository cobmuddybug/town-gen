import type { Address } from "../core/address";

/** Back and forward through what the inspector has shown, like a browser. */
export class History {
  private items: Address[] = [];
  private at = -1;
  constructor(private max = 100) {}

  push(a: Address): void {
    if (this.items[this.at] === a) return;
    this.items = this.items.slice(0, this.at + 1);
    this.items.push(a);
    if (this.items.length > this.max) this.items.shift();
    this.at = this.items.length - 1;
  }
  back(): Address | undefined {
    if (!this.canBack) return undefined;
    return this.items[--this.at];
  }
  forward(): Address | undefined {
    if (!this.canForward) return undefined;
    return this.items[++this.at];
  }
  get canBack(): boolean { return this.at > 0; }
  get canForward(): boolean { return this.at < this.items.length - 1; }

  /** Drop what a rebuilt town no longer has. */
  prune(exists: (a: Address) => boolean): void {
    const cur = this.items[this.at];
    const before = this.items.slice(0, this.at + 1).filter(exists).length;
    this.items = this.items.filter(exists);
    this.at = cur !== undefined && exists(cur) ? before - 1 : Math.min(before, this.items.length) - 1;
  }
}

/** Keys typed here are text, not shortcuts. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || (el as HTMLElement).isContentEditable === true;
}
