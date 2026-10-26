import { Icon } from "./Icon.tsx";

const PAGES = ["Present", "Compare", "Edit", "Workstreams", "Kanvas"];

// Komposer's top bar: brand, page tabs, theme button.
export function TopBar({ page }: { page: string }) {
  return (
    <header className="kp-top">
      <div className="kp-brand">
        <div className="kp-disc" />
        Komposer
      </div>
      <nav className="kp-pages" aria-label="Pages">
        {PAGES.map((p) => (
          <button key={p} type="button" className={`kp-page${p === page ? " is-active" : ""}`}>
            {p}
          </button>
        ))}
      </nav>
      <div className="kp-end">
        <Icon name="sun" />
      </div>
    </header>
  );
}
