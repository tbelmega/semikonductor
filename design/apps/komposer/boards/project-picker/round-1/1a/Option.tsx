import "../../../../shared/shell.css";
import "./styles.css";
import { Icon, STATES, type State } from "../../../../shared/Icon.tsx";

const PAGES = ["Present", "Compare", "Edit", "Workstreams", "Kanvas"];

type Project = { name: string; path: string; states: Partial<Record<State, number>>; current?: boolean };

const PINNED: Project[] = [
  { name: "acme-storefront", path: "~/code/acme-storefront", states: { running: 2, waiting: 1, done: 2 }, current: true },
  { name: "garden-planner", path: "~/code/garden-planner", states: { running: 1, blocked: 1 } },
];
const RECENT: Project[] = [
  { name: "tidepool-api", path: "~/work/tidepool-api", states: { waiting: 2 } },
  { name: "recipe-box", path: "~/code/side/recipe-box", states: {} },
];

const WORKFLOWS = [
  { name: "All workflows", count: 5, active: true },
  { name: "feature-development", count: 3 },
  { name: "bug-fix", count: 1 },
  { name: "design-exploration", count: 1 },
];

const WORKSTREAMS: { slug: string; workflow: string; state: State; step: string; when: string }[] = [
  { slug: "checkout-gift-cards", workflow: "feature-development", state: "waiting", step: "Review the design", when: "12 min ago" },
  { slug: "search-autocomplete", workflow: "feature-development", state: "running", step: "Implement", when: "3 min ago" },
  { slug: "cart-badge-overflow", workflow: "bug-fix", state: "running", step: "Reproduce", when: "40 min ago" },
  { slug: "product-page-layout", workflow: "design-exploration", state: "done", step: "Round 2 chosen", when: "yesterday" },
  { slug: "wishlist-sharing", workflow: "feature-development", state: "done", step: "Merged", when: "3 days ago" },
];

const FOLDERS: { name: string; found: string; status: "project" | "hidden" | "none" }[] = [
  { name: "recipe-box", found: "1 design board", status: "project" },
  { name: "habit-notes", found: "2 workstreams", status: "none" },
  { name: "old-blog", found: "1 workstream", status: "hidden" },
  { name: "dotfiles", found: "nothing found", status: "none" },
];

function TopBar({ page, open }: { page: string; open?: boolean }) {
  return (
    <header className="kp-top">
      <div className="kp-brand">
        <div className="kp-disc" />
        Komposer
      </div>
      <button type="button" className={`sw-trigger${open ? " is-open" : ""}`} aria-haspopup="dialog" aria-expanded={!!open}>
        <Icon name="folder" size={15} />
        <span className="sw-trigger-name">acme-storefront</span>
        <Icon name="chevronDown" size={14} />
        <span className="kp-kbd">Ctrl K</span>
      </button>
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

function StateCounts({ states }: { states: Project["states"] }) {
  const entries = Object.entries(states) as [State, number][];
  if (!entries.length) return <span className="sw-none">no workstreams</span>;
  return (
    <span className="sw-counts">
      {entries.map(([state, n]) => (
        <span key={state} className="sw-count" aria-label={`${n} ${STATES[state].label}`}>
          <span className={`kp-dot ${STATES[state].className}`} />
          {n}
        </span>
      ))}
    </span>
  );
}

function ProjectRow({ project, active }: { project: Project; active?: boolean }) {
  return (
    <li className={`sw-row${active ? " is-active" : ""}`}>
      <span className="sw-check">{project.current && <Icon name="check" size={14} />}</span>
      <span className="sw-row-main">
        <span className="sw-row-name">{project.name}</span>
        <span className="kp-mono">{project.path}</span>
      </span>
      <StateCounts states={project.states} />
    </li>
  );
}

function Palette() {
  return (
    <div className="sw-palette" role="dialog" aria-label="Switch project">
      <div className="sw-search">
        <Icon name="search" />
        <input className="sw-input" placeholder="Switch project, or type a folder path" readOnly />
      </div>
      <p className="sw-section">
        <Icon name="pin" size={12} /> Pinned
      </p>
      <ul className="sw-list">
        {PINNED.map((p, i) => (
          <ProjectRow key={p.path} project={p} active={i === 1} />
        ))}
      </ul>
      <p className="sw-section">
        <Icon name="clock" size={12} /> Recent
      </p>
      <ul className="sw-list">
        {RECENT.map((p) => (
          <ProjectRow key={p.path} project={p} />
        ))}
      </ul>
      <footer className="sw-foot">
        <span>
          <span className="kp-kbd">Enter</span> open
        </span>
        <span>
          <span className="kp-kbd">Ctrl P</span> pin
        </span>
        <span>
          <span className="kp-kbd">~/</span> browse folders
        </span>
        <span className="sw-foot-end">6 projects, 2 hidden</span>
      </footer>
    </div>
  );
}

function FolderPalette() {
  return (
    <div className="sw-palette is-static" role="dialog" aria-label="Browse folders">
      <div className="sw-search">
        <Icon name="folder" />
        <input className="sw-input is-path" value="~/code/side/" readOnly />
      </div>
      <ul className="sw-list">
        {FOLDERS.map((f) => (
          <li key={f.name} className="sw-row">
            <span className="sw-check">
              <Icon name="folder" size={14} />
            </span>
            <span className="sw-row-main">
              <span className="sw-row-name">{f.name}</span>
              <span className="kp-mono">{f.found}</span>
            </span>
            {f.status === "project" && <span className="sw-badge is-project">Project</span>}
            {f.status === "hidden" && <span className="sw-badge is-hidden">Hidden</span>}
            {f.status === "none" && (
              <button type="button" className="sw-add">
                <Icon name="plus" size={13} /> Add
              </button>
            )}
            <button type="button" className="sw-icon" aria-label={`More for ${f.name}`}>
              <Icon name="more" size={15} />
            </button>
          </li>
        ))}
      </ul>
      <footer className="sw-foot">
        <span>
          <span className="kp-kbd">Tab</span> into folder
        </span>
        <span>
          <span className="kp-kbd">Ctrl Enter</span> add as project
        </span>
        <span>
          <span className="kp-kbd">Ctrl H</span> hide
        </span>
      </footer>
    </div>
  );
}

export default function Option() {
  return (
    <div className="kp-app">
      <TopBar page="Workstreams" open />
      <div className="sw-stage">
        <Palette />
        <main className="sw-page" aria-label="Workstreams of acme-storefront">
          <div className="sw-page-head">
            <h1 className="sw-title">acme-storefront</h1>
            <span className="kp-mono">~/code/acme-storefront</span>
          </div>
          <div className="sw-chips" role="group" aria-label="Filter by workflow">
            {WORKFLOWS.map((w) => (
              <button key={w.name} type="button" className={`sw-chip${w.active ? " is-active" : ""}`} aria-pressed={!!w.active}>
                {w.name} <span className="sw-chip-n">{w.count}</span>
              </button>
            ))}
          </div>
          <table className="sw-table">
            <thead>
              <tr>
                <th>Workstream</th>
                <th>Workflow</th>
                <th>Step</th>
                <th>State</th>
                <th>Last change</th>
              </tr>
            </thead>
            <tbody>
              {WORKSTREAMS.map((w) => (
                <tr key={w.slug}>
                  <td className="sw-slug">{w.slug}</td>
                  <td className="kp-mono">{w.workflow}</td>
                  <td>{w.step}</td>
                  <td>
                    <span className={`kp-pill ${STATES[w.state].className}`}>{STATES[w.state].label}</span>
                  </td>
                  <td className="sw-when">{w.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </main>
      </div>

      <p className="kp-caption">Typing a path in the same palette browses folders</p>
      <div className="sw-second">
        <FolderPalette />
        <div className="sw-notes">
          <p>Any folder can be added, whether or not Komposer found workstreams or a design folder in it.</p>
          <p>Hiding a folder keeps Komposer from listing it again when fuse-flow writes a workstream there.</p>
        </div>
      </div>

      <p className="kp-caption">On Kanvas the same switcher picks whose boards are shown</p>
      <TopBar page="Kanvas" />
      <div className="sw-kanvas">
        <span className="sw-board is-active">product-page-layout</span>
        <span className="sw-board">checkout-flow</span>
        <span className="sw-board">empty-cart</span>
      </div>
    </div>
  );
}
