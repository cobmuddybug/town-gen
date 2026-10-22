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

export type KeyAction = "search" | "back" | "forward" | "earlier" | "later" | "player";
interface Keyish { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** What a key press asks for. While typing, only Ctrl/Cmd+K is ours; everything else is the text's. */
export function keyAction(e: Keyish, typing: boolean): KeyAction | undefined {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") return "search";
  if (typing || e.ctrlKey || e.metaKey) return undefined;
  if (e.altKey) return e.key === "ArrowLeft" ? "back" : e.key === "ArrowRight" ? "forward" : undefined;
  if (e.key === "/") return "search";
  if (e.key === "[") return "earlier";
  if (e.key === "]") return "later";
  if (e.key === "P" && e.shiftKey) return "player";
  return undefined;
}
