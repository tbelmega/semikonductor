// SPDX-License-Identifier: Apache-2.0
// The bar above every page: the brand and the project Komposer was started
// on, the page switcher, and the theme button.

import { ThemeToggle } from "./ThemeToggle.tsx";

export type Page = "edit" | "compare" | "present" | "workstreams";

export const PAGES: { id: Page; label: string; built: boolean }[] = [
  { id: "edit", label: "Edit", built: true },
  { id: "compare", label: "Compare", built: true },
  { id: "present", label: "Present", built: true },
  { id: "workstreams", label: "Workstreams", built: true },
];

export function TopBar({ project, page, onPage }: { project: string; page: Page; onPage: (page: Page) => void }) {
  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <div className="brand-disc" />
        <div className="brand-name">Komposer</div>
        <span className="project-pill" data-tip="The project Komposer was started on">
          {project}
        </span>
      </div>
      <nav className="page-switcher" aria-label="Pages">
        {PAGES.map(({ id, label, built }, i) => (
          <button
            key={id}
            type="button"
            className={`page-btn${page === id ? " is-active" : ""}`}
            aria-current={page === id ? "page" : undefined}
            aria-disabled={!built}
            data-tip={built ? `${label} (${i + 1})` : `${label}: not built yet`}
            onClick={() => built && onPage(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="top-bar-end">
        <ThemeToggle />
      </div>
    </header>
  );
}
