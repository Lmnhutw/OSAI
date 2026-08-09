"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const storageKey = "osai.recent-navigation.v1";
const limit = 5;

interface RecentItem {
  href: string;
  label: string;
}

function labelForPath(pathname: string) {
  if (pathname === "/") return "Overview";
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => (part.length > 18 ? "Detail" : part.replace(/-/g, " ")))
    .join(" / ");
}

function readItems(): RecentItem[] {
  try {
    const value = window.localStorage.getItem(storageKey);
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RecentItem => Boolean(item && typeof item === "object" && "href" in item && "label" in item))
      : [];
  } catch {
    return [];
  }
}

export function RecentItems() {
  const pathname = usePathname();
  const [items, setItems] = useState<RecentItem[]>([]);

  useEffect(() => {
    const next = [{ href: pathname, label: labelForPath(pathname) }, ...readItems().filter((item) => item.href !== pathname)].slice(0, limit);
    setItems(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage is optional; navigation still works in private/restricted browsers.
    }
  }, [pathname]);

  if (items.length < 2) return null;

  return (
    <section aria-labelledby="recent-items-title" className="hidden lg:block">
      <p id="recent-items-title" className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--ink-soft))]">Recent</p>
      <ul className="mt-3 space-y-1">
        {items.slice(1).map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="block truncate rounded-lg px-2 py-2 text-sm text-[rgb(var(--ink-soft))] transition hover:bg-white/70 hover:text-[rgb(var(--ink-strong))]">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
