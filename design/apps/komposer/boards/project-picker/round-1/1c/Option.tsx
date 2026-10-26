import "../../../../shared/shell.css";
import "./styles.css";
import { Icon, STATES, type State } from "../../../../shared/Icon.tsx";

const PAGES = ["Present", "Compare", "Edit", "Workstreams", "Kanvas"];

const TABS = [
  { name: "acme-storefront", attention: 1, active: true },
  { name: "garden-planner", attention: 1 },
  { name: "tidepool-api", attention: 2 },
];

const COLUMNS: { state: State; cards: { slug: string; workflow: string; step: string }[] }[] = [
  { state: "waiting", cards: [{ slug: "checkout-gift-cards", workflow: "feature-development", step: "Review the design" }] },
  {
    state: "running",
    cards: [
      { slug: "search-autocomplete", workflow: "feature-development", step: "Implement" },
      { slug: "cart-badge-overflow", workflow: "bug-fix", step: "Reproduce" },
    ],
  },
  { state: "blocked", cards: [] },
  {
    state: "done",
    cards: [
      { slug: "product-page-layout", workflow: "design-exploration", step: "Round 2 chosen" },
      { slug: "wishlist-sharing", workflow: "feature-development", step: "Merged" },
    ],
  },
];

type Folder = { name: string; depth: number; found?: string; on?: boolean; auto?: boolean; off?: boolean; open?: boolean; root?: boolean };

const TREE: Folder[] = [
  { name: "~/code", depth: 0, root: true, open: true },
  { name: "acme-storefront", depth: 1, found: "5 workstreams, 3 boards", on: true, auto: true },
  { name: "garden-planner", depth: 1, found: "2 workstreams, 1 board", on: true, auto: true },
  { name: "side", depth: 1, open: true },
  { name: "recipe-box", depth: 2, found: "1 board", on: true },
  { name: "old-blog", depth: 2, found: "1 workstream", off: true },
  { name: "habit-notes", depth: 2, found: "nothing found" },
  { name: "~/work", depth: 0, root: true, open: true },
  { name: "tidepool-api", depth: 1, found: "2 workstreams", on: true, auto: true },
  { name: "tidepool-web", depth: 1, found: "nothing found" },
];

function Switch({ on, label }: { on: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pt-switch${on ? " is-on" : ""}`}>
      <span className="pt-knob" />
    </button>
  );
}

function Tabs() {
  return (
    <div className="pt-tabs" role="tablist" aria-label="Open projects">
      {TABS.map((t, i) => (
        <button key={t.name} type="button" role="tab" aria-selected={!!t.active} className={`pt-tab${t.active ? " is-active" : ""}`}>
          <span className="pt-tab-key">{i + 1}</span>
          {t.name}
          {t.attention > 0 && (
            <span className="pt-tab-badge" aria-label={`${t.attention} waiting for you or blocked`}>
              {t.attention}
            </span>
          )}
          <span className="pt-tab-close" aria-label={`Close ${t.name}`}>
            <Icon name="x" size={12} />
          </span>
        </button>
      ))}
      <button type="button" className="pt-tab-add is-open" aria-label="Open a project or manage projects">
        <Icon name="plus" size={14} />
      </button>
      <span className="pt-tabs-hint">
        <span className="kp-kbd">Ctrl 1</span> to <span className="kp-kbd">Ctrl 9</span> switch
      </span>
    </div>
  );
}

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

function Drawer() {
  return (
    <aside className="pt-drawer" aria-label="Projects on this computer">
      <div className="pt-drawer-head">
        <div>
          <h2 className="pt-drawer-title">Projects on this computer</h2>
          <p className="pt-drawer-lead">Switch a folder on to make it a project. Komposer switches on folders where fuse-flow writes workstreams.</p>
        </div>
        <button type="button" className="pt-close" aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="pt-legend">
        <span className="pt-legend-item">
          <span className="pt-auto">found</span> Komposer found work here
        </span>
        <span className="pt-legend-item">
          <span className="pt-off-tag">off</span> you switched it off
        </span>
      </div>
      <ul className="pt-tree">
        {TREE.map((f) => (
          <li key={`${f.depth}-${f.name}`} className={`pt-node${f.root ? " is-root" : ""}${f.off ? " is-off" : ""}`} style={{ paddingLeft: `${12 + f.depth * 20}px` }}>
            {f.open !== undefined ? <Icon name={f.open ? "chevronDown" : "chevronRight"} size={14} /> : <span className="pt-spacer" />}
            <Icon name="folder" size={15} />
            <span className="pt-node-main">
              <span className="pt-node-name">{f.name}</span>
              {f.found && <span className="kp-mono">{f.found}</span>}
            </span>
            {f.auto && <span className="pt-auto">found</span>}
            {f.off && <span className="pt-off-tag">off</span>}
            {!f.root && <Switch on={!!f.on} label={`${f.name} is a project`} />}
            {f.root && (
              <button type="button" className="pt-root-remove">
                Stop looking here
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="pt-add-root">
        <Icon name="folderPlus" size={15} /> Look in another folder
      </button>
    </aside>
  );
}

export default function Option() {
  return (
    <div className="kp-app">
      <TopBar page="Workstreams" />
      <Tabs />
      <div className="pt-stage">
        <main className="pt-main" aria-label="Workstreams of acme-storefront">
          <div className="pt-head">
            <h1 className="pt-title">acme-storefront</h1>
            <button type="button" className="pt-filter">
              All workflows <Icon name="chevronDown" size={14} />
            </button>
          </div>
          <div className="pt-columns">
            {COLUMNS.map((c) => (
              <section key={c.state} className="pt-col" aria-label={STATES[c.state].label}>
                <h2 className="pt-col-head">
                  <span className={`kp-dot ${STATES[c.state].className}`} />
                  {STATES[c.state].label}
                  <span className="pt-col-n">{c.cards.length}</span>
                </h2>
                {c.cards.map((card) => (
                  <article key={card.slug} className="pt-card">
                    <span className="pt-card-slug">{card.slug}</span>
                    <span className="kp-mono">{card.workflow}</span>
                    <span className="pt-card-step">{card.step}</span>
                  </article>
                ))}
                {!c.cards.length && <p className="pt-col-empty">Nothing blocked</p>}
              </section>
            ))}
          </div>
        </main>
        <Drawer />
      </div>

      <p className="kp-caption">Kanvas keeps the same tabs; each tab remembers its board</p>
      <TopBar page="Kanvas" />
      <div className="pt-tabs is-plain" role="tablist" aria-label="Open projects">
        {TABS.map((t) => (
          <button key={t.name} type="button" role="tab" aria-selected={!!t.active} className={`pt-tab${t.active ? " is-active" : ""}`}>
            {t.name}
          </button>
        ))}
      </div>
      <div className="pt-kanvas">
        <span className="pt-board is-active">product-page-layout</span>
        <span className="pt-board">checkout-flow</span>
        <span className="pt-board">empty-cart</span>
      </div>
    </div>
  );
}
