import "../../../../shared/shell.css";
import "./styles.css";
import { Icon, STATES } from "../../../../shared/Icon.tsx";
import { TopBar } from "../../../../shared/TopBar.tsx";
import { BOARDS, count, PROJECTS, WORKFLOWS, WORKSTREAMS } from "../data.ts";

// The state shown: one workflow, across all projects, with the workflow
// menu open.
const WORKFLOW = "feature-development";
const rows = WORKSTREAMS.filter((w) => w.workflow === WORKFLOW);
const byProject = PROJECTS.map((p) => ({ project: p, rows: rows.filter((w) => w.project === p) })).filter((g) => g.rows.length);

function Filter({ icon, label, value, all, open, clearable }: { icon: "folder" | "workflow"; label: string; value: string | null; all: string; open?: boolean; clearable?: boolean }) {
  return (
    <span className={`fb-filter${value ? " is-set" : ""}${open ? " is-open" : ""}`}>
      <button type="button" className="fb-filter-btn" aria-haspopup="listbox" aria-expanded={!!open}>
        <Icon name={icon} size={15} />
        <span className="fb-filter-label">{label}</span>
        <span className="fb-filter-value">{value ?? all}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {value && clearable && (
        <button type="button" className="fb-clear" aria-label={`Show ${all.toLowerCase()}`}>
          <Icon name="x" size={13} />
        </button>
      )}
    </span>
  );
}

function WorkflowMenu() {
  return (
    <div className="fb-menu" role="listbox" aria-label="Workflow">
      <div className="fb-menu-search">
        <Icon name="search" size={14} />
        <input className="fb-menu-input" placeholder="Filter workflows" readOnly />
      </div>
      <button type="button" role="option" aria-selected={false} className="fb-opt">
        <span className="fb-opt-check" />
        All workflows
        <span className="fb-opt-n">{count(WORKSTREAMS, null, null)}</span>
      </button>
      <div className="fb-menu-sep" />
      {WORKFLOWS.map((w) => (
        <button key={w} type="button" role="option" aria-selected={w === WORKFLOW} className={`fb-opt${w === WORKFLOW ? " is-selected" : ""}`}>
          <span className="fb-opt-check">{w === WORKFLOW && <Icon name="check" size={14} />}</span>
          <span className="kp-mono fb-opt-name">{w}</span>
          <span className="fb-opt-n">{count(WORKSTREAMS, null, w)}</span>
        </button>
      ))}
      <p className="fb-menu-note">Counts are for all projects, the project filter's current choice.</p>
    </div>
  );
}

export default function Option() {
  return (
    <div className="kp-app">
      <TopBar page="Workstreams" />
      <div className="fb-bar" role="group" aria-label="Filter workstreams">
        <Filter icon="folder" label="Project" value={null} all="All projects" />
        <Filter icon="workflow" label="Workflow" value={WORKFLOW} all="All workflows" open clearable />
        <span className="fb-summary">
          {rows.length} workstreams of <strong>{WORKFLOW}</strong> in {byProject.length} projects, grouped by project
        </span>
        <WorkflowMenu />
      </div>
      <main className="fb-main" aria-label="Workstreams">
        {byProject.map((g) => (
          <section key={g.project} className="fb-group" aria-label={g.project}>
            <h2 className="fb-group-head">
              <Icon name="folder" size={14} /> {g.project}
              <span className="fb-group-n">{g.rows.length}</span>
              <button type="button" className="fb-only">
                Only this project
              </button>
            </h2>
            <ul className="fb-list">
              {g.rows.map((w) => (
                <li key={w.slug} className="fb-row">
                  <span className={`kp-dot ${STATES[w.state].className}`} />
                  <span className="fb-slug">{w.slug}</span>
                  <span className="fb-step">{w.step}</span>
                  <span className={`kp-pill ${STATES[w.state].className}`}>{STATES[w.state].label}</span>
                  <span className="fb-when">{w.when}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>

      <p className="kp-caption">Kanvas: the same two filters, the workflow being the one that produced the board</p>
      <TopBar page="Kanvas" />
      <div className="fb-bar" role="group" aria-label="Filter boards">
        <Filter icon="folder" label="Project" value="acme-storefront" all="All projects" clearable />
        <Filter icon="workflow" label="Made by" value={null} all="Any workflow" />
        <span className="fb-summary">3 boards in acme-storefront</span>
      </div>
      <div className="fb-boards">
        {BOARDS.filter((b) => b.project === "acme-storefront").map((b) => (
          <article key={b.feature} className="fb-board">
            <span className="fb-board-name">{b.feature}</span>
            <span className="fb-board-meta">
              {b.rounds} round{b.rounds === 1 ? "" : "s"}
              {b.open > 0 && ` · ${b.open} open comments`}
            </span>
            {b.workflow ? (
              <span className="fb-made">
                <Icon name="workflow" size={13} /> <span className="kp-mono">{b.workflow}</span>
              </span>
            ) : (
              <span className="fb-made is-none">made by hand</span>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
