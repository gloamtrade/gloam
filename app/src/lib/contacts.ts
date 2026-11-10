/**
 * Local address book for Gloam receive tags (private pay contacts).
 */

import { readDemo } from "./demoFlag";
import { DEMO_CONTACTS } from "./demo/chain";

const KEY = "gloam.contacts.v1";

export type GloamContact = {
  id: string;
  label: string;
  tag: string;
  createdAt: number;
};

/** Recording demo: edits stay in this tab's memory, never in the real address book. */
let demoList: GloamContact[] | null = null;

export function loadContacts(): GloamContact[] {
  if (typeof window === "undefined") return [];
  // Recording demo: the pretend wallet's own people to pay.
  if (readDemo()) return demoList ?? DEMO_CONTACTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as GloamContact[];
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

export function saveContacts(list: GloamContact[]) {
  if (typeof window === "undefined") return;
  if (readDemo()) {
    demoList = list.slice(0, 50);
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50)));
}

export function upsertContact(label: string, tag: string): GloamContact {
  const t = tag.trim();
  const list = loadContacts().filter(
    (c) => c.tag.toLowerCase() !== t.toLowerCase()
  );
  const row: GloamContact = {
    id: `c-${Date.now()}`,
    label: label.trim() || "Contact",
    tag: t,
    createdAt: Date.now(),
  };
  saveContacts([row, ...list]);
  return row;
}
