import "../../../../shared/shell.css";
import "./styles.css";
import { Icon, STATES, type State } from "../../../../shared/Icon.tsx";

const PAGES = ["Present", "Compare", "Edit", "Workstreams", "Kanvas"];

type Project = { name: string; path: string; pinned?: boolean; states: Partial<Record<State, number>>; boards?: number };

const PROJECTS: Project[] = [
  { name: "acme-storefront", path: "~/code/acme-storefront", pinned: true, states: { running: 2, waiting: 1, done: 2 }, boards: 3 },
  { name: "garden-planner", path: "~/code/garden-planner", pinned: true, states: { running: 1, blocked: 1 }, boards: 1 },
  { name: "tidepool-api", path: "~/work/tidepool-api", states: { waiting: 2 } },
  { name: "recipe-box", path: "~/code/side/recipe-box", states: {}, boards: 1 },
  { name: "fuse examples", path: "bundled with Komposer", states: { done: 4 }, boards: 1 },
];
const HIDDEN = [
  { name: "old-blog", path: "~/code/side/old-blog" },
  { name: "scratch", path: "~/tmp/scratch" },
];

const GROUPS: { workflow: string; rows: { slug: string; state: State; step: string; when: string }[] }[] = [
  {
    workflow: "feature-development",
    rows: [
      { slug: "checkout-gift-cards", state: "waiting", step: "Review the design", when: "12 min ago" },
      { slug: "search-autocomplete", state: "running", step: "Implement", when: "3 min ago" },
      { slug: "wishlist-sharing", state: "done", step: "Merged", when: "3 days ago" },
    ],
  },
  { workflow: "bug-fix", rows: [{ slug: "cart-badge-overflow", state: "running", step: "Reproduce", when: "40 min ago" }] },
  { workflow: "design-exploration", rows: [{ slug: "product-page-layout", state: "done", step: "Round 2 chosen", when: "yesterday" }] },
];

function TopBar({ page }: { page: string }) {
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

function Initial({ name }: { name: string }) {
  return <span className="pr-initial">{name.slice(0, 1).toUpperCase()}</span>;
}

function Rail({ selected, menuOn, kanvas }: { selected: string; menuOn?: string; kanvas?: boolean }) {
  const row = (p: Project) => {
    const entries = Object.entries(p.states) as [State, number][];
    return (
      <li key={p.path} className="pr-item">
        <button type="button" className={`pr-row${p.name === selected ? " is-current" : ""}`} aria-current={p.name === selected ? "true" : undefined}>
          <Initial name={p.name} />
          <span className="pr-row-main">
            <span className="pr-row-name">{p.name}</span>
            <span className="pr-row-meta">
              {kanvas ? (
                <span className="pr-meta-text">{p.boards ? `${p.boards} board${p.boards === 1 ? "" : "s"}` : "no design folder"}</span>
              ) : entries.length ? (
                entries.map(([state, n]) => (
                  <span key={state} className="pr-count" aria-label={`${n} ${STATES[state].label}`}>
                    <span className={`kp-dot ${STATES[state].className}`} />
                    {n}
                  </span>
                ))
              ) : (
                <span className="pr-meta-text">no workstreams</span>
              )}
            </span>
          </span>
          <span className="pr-more" aria-label={`More for ${p.name}`}>
            <Icon name="more" size={15} />
          </span>
        </button>
        {menuOn === p.name && (
          <div className="pr-menu" role="menu">
            <button type="button" role="menuitem" className="pr-menu-item">
              <Icon name="pin" size={14} /> Pin to the top
            </button>
            <button type="button" role="menuitem" className="pr-menu-item">
              <Icon name="folder" size={14} /> Show the folder path
            </button>
            <button type="button" role="menuitem" className="pr-menu-item is-danger">
              <Icon name="ban" size={14} /> Not a project: hide it
            </button>
          </div>
        )}
      </li>
    );
  };
  return (
    <aside className="pr-rail" aria-label="Projects">
      <div className="pr-rail-head">
        <span className="pr-rail-title">Projects</span>
        <button type="button" className="pr-add" aria-label="Add a folder as a project">
          <Icon name="folderPlus" size={15} /> Add folder
        </button>
      </div>
      <div className="pr-filter">
        <Icon name="search" size={14} />
        <input className="pr-filter-input" placeholder="Filter projects" readOnly />
      </div>
      <p className="pr-group">Pinned</p>
      <ul className="pr-list">{PROJECTS.filter((p) => p.pinned).map(row)}</ul>
      <p className="pr-group">All projects</p>
      <ul className="pr-list">{PROJECTS.filter((p) => !p.pinned).map(row)}</ul>
      <details className="pr-hidden" open={!kanvas}>
        <summary className="pr-hidden-head">
          <Icon name="chevronRight" size={14} /> Hidden folders ({HIDDEN.length})
        </summary>
        <ul className="pr-list">
          {HIDDEN.map((h) => (
            <li key={h.path} className="pr-hidden-row">
              <span className="pr-row-main">
                <span className="pr-hidden-name">{h.name}</span>
                <span className="kp-mono">{h.path}</span>
              </span>
              <button type="button" className="pr-show">
                Show again
              </button>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}

export default function Option() {
  return (
    <div className="kp-app">
      <TopBar page="Workstreams" />
      <div className="pr-body">
        <Rail selected="acme-storefront" menuOn="tidepool-api" />
        <main className="pr-main" aria-label="Workstreams of acme-storefront">
          <div className="pr-head">
            <div>
              <h1 className="pr-title">acme-storefront</h1>
              <span className="kp-mono">~/code/acme-storefront</span>
            </div>
            <div className="pr-head-end">
              <span className="pr-summary">5 workstreams in 3 workflows</span>
              <button type="button" className="pr-link">
                <Icon name="palette" size={14} /> 3 boards on Kanvas
              </button>
            </div>
          </div>
          {GROUPS.map((g) => (
            <section key={g.workflow} className="pr-section" aria-label={g.workflow}>
              <h2 className="pr-section-head">
                <Icon name="chevronDown" size={14} />
                <span className="kp-mono pr-section-name">{g.workflow}</span>
                <span className="pr-section-n">{g.rows.length}</span>
              </h2>
              <ul className="pr-ws">
                {g.rows.map((r) => (
                  <li key={r.slug} className="pr-ws-row">
                    <span className={`kp-dot ${STATES[r.state].className}`} />
                    <span className="pr-ws-slug">{r.slug}</span>
                    <span className="pr-ws-step">{r.step}</span>
                    <span className={`kp-pill ${STATES[r.state].className}`}>{STATES[r.state].label}</span>
                    <span className="pr-ws-when">{r.when}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </main>
      </div>

      <p className="kp-caption">Kanvas shows the same rail, counting boards instead of workstreams</p>
      <TopBar page="Kanvas" />
      <div className="pr-body is-short">
        <Rail selected="acme-storefront" kanvas />
        <main className="pr-main">
          <div className="pr-boards">
            <span className="pr-board is-active">product-page-layout</span>
            <span className="pr-board">checkout-flow</span>
            <span className="pr-board">empty-cart</span>
          </div>
        </main>
      </div>
    </div>
  );
}
