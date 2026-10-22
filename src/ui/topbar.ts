import { BLOCKS, addDays, parseDate, weekday, type Block } from "../core/calendar";
import type { Kept } from "./library";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "Wed 1 Oct · forenoon": the clock as the bar shows it. */
export function clockLabel(date: string, block: string): string {
  const d = parseDate(date);
  return `${DAYS[weekday(date)]} ${d.d} ${MONTHS[d.m - 1]} · ${block.replace("_", " ")}`;
}

/** One block forward or back, across midnight into the next or last day. */
export function stepClock(date: string, block: string, step: number): { date: string; block: Block } {
  let i = BLOCKS.indexOf(block as Block) + step;
  let d = date;
  if (i < 0) { i = BLOCKS.length - 1; d = addDays(d, -1); }
  if (i >= BLOCKS.length) { i = 0; d = addDays(d, 1); }
  return { date: d, block: BLOCKS[i] };
}

const BASES: Record<string, string> = { agricultural: "farming", fishing: "fishing", herding: "herding", mining: "mining", woodcutting: "woodcutting" };

/** The town menu: towns you kept, then the file and display actions. */
export function townMenuHtml(kept: Kept[], here: string, name: string, showSources: boolean): string {
  const h: string[] = [`<p class="menu-head">Your towns</p>`];
  if (kept.length) {
    for (const k of kept) {
      const on = k.key === here;
      h.push(`<button role="menuitem" data-open-town="${esc(k.key)}"${on ? ' aria-current="true" disabled' : ""}><span>${esc(k.name)}</span><span class="sub">${k.pop.toLocaleString()}, ${esc(BASES[k.base] ?? k.base)}${on ? " · open" : ""}</span></button>`);
    }
  } else h.push(`<p class="menu-note">Towns you edit, pin or star are kept here. Untouched towns come back from their seed.</p>`);
  h.push(`<hr />`);
  h.push(`<button role="menuitem" data-menu="download">Download file</button>`);
  h.push(`<button role="menuitem" data-menu="open">Open file…</button>`);
  h.push(`<button role="menuitemcheckbox" aria-checked="${showSources}" data-menu="sources"><span class="tick">${showSources ? "✓" : ""}</span>Show book sources</button>`);
  if (kept.some((k) => k.key === here)) h.push(`<hr /><button role="menuitem" data-menu="forget" class="danger">Forget my edits to ${esc(name)}…</button>`);
  return h.join("");
}
