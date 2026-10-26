import "../../../../shared/shell.css";
import "./styles.css";
import { Icon, STATES } from "../../../../shared/Icon.tsx";
import { TopBar } from "../../../../shared/TopBar.tsx";
import { BOARDS, count, PROJECTS, WORKFLOWS, WORKSTREAMS } from "../data.ts";

// The state shown: one project, across all workflows.
const PROJECT = "tidepool-api";
const rows = WORKSTREAMS.filter((w) => w.project === PROJECT);
const byWorkflow = WORKFLOWS.map((f) => ({ workflow: f, rows: rows.filter((w) => w.workflow === f) })).filter((g) => g.rows.length);

type Item = { name: string; n: number; selected: boolean; mono?: boolean };

function Facet({ icon, title, all, items, allSelected, allCount }: { icon: "folder" | "workflow"; title: string; all: string; items: Item[]; allSelected: boolean; allCount: number }) {
  return (
    <section className="fc-facet" aria-label={title}>
      <h2 className="fc-facet-head">
        <Icon name={icon} size={14} /> {title}
      </h2>
      <ul className="fc-list">
        <li>
          <button type="button" className={`fc-item is-all${allSelected ? " is-selected" : ""}`} aria-pressed={allSelected}>
            <span className="fc-radio" />
            {all}
            <span className="fc-n">{allCount}</span>
          </button>
        </li>
        {items.map((it) => (
          <li key={it.name}>
            <button
              type="button"
              className={`fc-item${it.selected ? " is-selected" : ""}${it.n === 0 ? " is-empty" : ""}`}
              aria-pressed={it.selected}
            >
              <span className="fc-radio" />
              <span className={it.mono ? "fc-name kp-mono" : "fc-name"}>{it.name}</span>
              <span className="fc-n">{it.n}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Option() {
  return (
    <div className="kp-app">
      <TopBar page="Workstreams" />
      <div className="fc-body">
        <aside className="fc-rail" aria-label="Filter workstreams">
          <Facet
            icon="folder"
            title="Project"
            all="All projects"
            allSelected={false}
            allCount={count(WORKSTREAMS, null, null)}
            items={PROJECTS.map((p) => ({ name: p, n: count(WORKSTREAMS, p, null), selected: p === PROJECT }))}
          />
          <Facet
            icon="workflow"
            title="Workflow"
            all="All workflows"
            allSelected
            allCount={rows.length}
            items={WORKFLOWS.map((f) => ({ name: f, n: count(WORKSTREAMS, PROJECT, f), selected: false, mono: true }))}
          />
          <p className="fc-hint">Workflow counts are for tidepool-api. A workflow with none there stays listed, greyed.</p>
          <button type="button" className="fc-add">
            <Icon name="folderPlus" size={14} /> Add a project folder
          </button>
        </aside>
        <main className="fc-main" aria-label="Workstreams">
          <div className="fc-crumbs">
            <span className="fc-crumb is-set">
              {PROJECT}
              <Icon name="x" size={12} />
            </span>
            <Icon name="chevronRight" size={14} />
            <span className="fc-crumb">All workflows</span>
            <span className="fc-total">{rows.length} workstreams</span>
          </div>
          {byWorkflow.map((g) => (
            <section key={g.workflow} className="fc-group" aria-label={g.workflow}>
              <h3 className="fc-group-head">
                <span className="kp-mono fc-group-name">{g.workflow}</span>
                <span className="fc-n">{g.rows.length}</span>
              </h3>
              <ul className="fc-ws">
                {g.rows.map((w) => (
                  <li key={w.slug} className="fc-ws-row">
                    <span className={`kp-dot ${STATES[w.state].className}`} />
                    <span className="fc-slug">{w.slug}</span>
                    <span className="fc-step">{w.step}</span>
                    <span className={`kp-pill ${STATES[w.state].className}`}>{STATES[w.state].label}</span>
                    <span className="fc-when">{w.when}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </main>
      </div>

      <p className="kp-caption">Kanvas: the same rail, with the producing workflow as the second facet</p>
      <TopBar page="Kanvas" />
      <div className="fc-body is-short">
        <aside className="fc-rail" aria-label="Filter boards">
          <Facet
            icon="folder"
            title="Project"
            all="All projects"
            allSelected
            allCount={BOARDS.length}
            items={PROJECTS.map((p) => ({ name: p, n: count(BOARDS, p, null), selected: false }))}
          />
          <Facet
            icon="workflow"
            title="Made by"
            all="Any workflow"
            allSelected={false}
            allCount={BOARDS.length}
            items={[
              ...WORKFLOWS.map((f) => ({ name: f, n: count(BOARDS, null, f), selected: f === "design-exploration", mono: true })),
              { name: "Made by hand", n: BOARDS.filter((b) => !b.workflow).length, selected: false },
            ]}
          />
        </aside>
        <main className="fc-main">
          <div className="fc-crumbs">
            <span className="fc-crumb">All projects</span>
            <Icon name="chevronRight" size={14} />
            <span className="fc-crumb is-set">
              design-exploration
              <Icon name="x" size={12} />
            </span>
            <span className="fc-total">2 boards</span>
          </div>
          <div className="fc-boards">
            {BOARDS.filter((b) => b.workflow === "design-exploration").map((b) => (
              <article key={b.feature} className="fc-board">
                <span className="fc-board-name">{b.feature}</span>
                <span className="fc-board-project">
                  <Icon name="folder" size={13} /> {b.project}
                </span>
                <span className="fc-board-meta">
                  {b.rounds} round{b.rounds === 1 ? "" : "s"}
                  {b.open > 0 && ` · ${b.open} open comments`}
                </span>
              </article>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
