import "../../../../shared/shell.css";
import "./styles.css";
import { Icon, STATES, type State } from "../../../../shared/Icon.tsx";
import { TopBar } from "../../../../shared/TopBar.tsx";
import { BOARDS, count, PROJECTS, WORKFLOWS, WORKSTREAMS } from "../data.ts";

// The state shown: one cell, acme-storefront x feature-development. A row
// header picks the project across all workflows, a column header the
// workflow across all projects, the corner everything.
const PROJECT = "acme-storefront";
const WORKFLOW = "feature-development";
const rows = WORKSTREAMS.filter((w) => w.project === PROJECT && w.workflow === WORKFLOW);

// The states that need the owner, shown as dots in a cell.
const ATTENTION: State[] = ["waiting", "blocked"];

function Cell({ project, workflow }: { project: string | null; workflow: string | null }) {
  const inCell = WORKSTREAMS.filter((w) => (!project || w.project === project) && (!workflow || w.workflow === workflow));
  const selected = project === PROJECT && workflow === WORKFLOW;
  const inLine = (project === PROJECT && !workflow) || (workflow === WORKFLOW && !project);
  return (
    <td className={`mx-cell${selected ? " is-selected" : ""}${inLine ? " is-line" : ""}${inCell.length ? "" : " is-empty"}`}>
      {inCell.length > 0 ? (
        <button type="button" className="mx-cell-btn" aria-pressed={selected} aria-label={`${project ?? "All projects"}, ${workflow ?? "all workflows"}: ${inCell.length}`}>
          <span className="mx-cell-n">{inCell.length}</span>
          <span className="mx-cell-dots">
            {ATTENTION.flatMap((s) => inCell.filter((w) => w.state === s).map((w) => <span key={w.slug} className={`kp-dot ${STATES[s].className}`} />))}
          </span>
        </button>
      ) : (
        <span className="mx-dash">–</span>
      )}
    </td>
  );
}

export default function Option() {
  return (
    <div className="kp-app">
      <TopBar page="Workstreams" />
      <main className="mx-main" aria-label="Workstreams">
        <div className="mx-top">
          <table className="mx-table">
            <thead>
              <tr>
                <th className="mx-corner">
                  <button type="button" className="mx-head-btn">
                    Everything
                  </button>
                </th>
                {WORKFLOWS.map((f) => (
                  <th key={f} className={f === WORKFLOW ? "is-line" : ""}>
                    <button type="button" className="mx-head-btn kp-mono">
                      {f}
                    </button>
                  </th>
                ))}
                <th className="mx-all-col">All workflows</th>
              </tr>
            </thead>
            <tbody>
              {PROJECTS.map((p) => (
                <tr key={p}>
                  <th scope="row" className={p === PROJECT ? "is-line" : ""}>
                    <button type="button" className="mx-head-btn">
                      <Icon name="folder" size={14} /> {p}
                    </button>
                  </th>
                  {WORKFLOWS.map((f) => (
                    <Cell key={f} project={p} workflow={f} />
                  ))}
                  <Cell project={p} workflow={null} />
                </tr>
              ))}
              <tr className="mx-all-row">
                <th scope="row">All projects</th>
                {WORKFLOWS.map((f) => (
                  <Cell key={f} project={null} workflow={f} />
                ))}
                <Cell project={null} workflow={null} />
              </tr>
            </tbody>
          </table>
          <aside className="mx-legend">
            <p>Click a cell for one project and one workflow, a row or column for one of them across the other, or the totals.</p>
            <p className="mx-legend-row">
              <span className="kp-dot st-waiting" /> waiting for you
            </p>
            <p className="mx-legend-row">
              <span className="kp-dot st-blocked" /> blocked
            </p>
            <button type="button" className="mx-add">
              <Icon name="folderPlus" size={14} /> Add a project folder
            </button>
          </aside>
        </div>

        <h2 className="mx-sel">
          {PROJECT} <span className="mx-sel-x">×</span> <span className="kp-mono">{WORKFLOW}</span>
          <span className="mx-sel-n">{rows.length} workstreams</span>
        </h2>
        <ul className="mx-list">
          {rows.map((w) => (
            <li key={w.slug} className="mx-row">
              <span className={`kp-dot ${STATES[w.state].className}`} />
              <span className="mx-slug">{w.slug}</span>
              <span className="mx-step">{w.step}</span>
              <span className={`kp-pill ${STATES[w.state].className}`}>{STATES[w.state].label}</span>
              <span className="mx-when">{w.when}</span>
            </li>
          ))}
        </ul>
      </main>

      <p className="kp-caption">Kanvas: the same grid counts boards, with a column for boards made by hand</p>
      <TopBar page="Kanvas" />
      <main className="mx-main">
        <table className="mx-table is-kanvas">
          <thead>
            <tr>
              <th className="mx-corner">Made by</th>
              {WORKFLOWS.map((f) => (
                <th key={f} className="kp-mono">
                  {f}
                </th>
              ))}
              <th>by hand</th>
            </tr>
          </thead>
          <tbody>
            {PROJECTS.map((p) => (
              <tr key={p}>
                <th scope="row">
                  <Icon name="folder" size={14} /> {p}
                </th>
                {WORKFLOWS.map((f) => {
                  const n = count(BOARDS, p, f);
                  return <td key={f} className={`mx-cell${n ? "" : " is-empty"}`}>{n ? <span className="mx-cell-n">{n}</span> : <span className="mx-dash">–</span>}</td>;
                })}
                {(() => {
                  const n = BOARDS.filter((b) => b.project === p && !b.workflow).length;
                  return <td className={`mx-cell${n ? "" : " is-empty"}`}>{n ? <span className="mx-cell-n">{n}</span> : <span className="mx-dash">–</span>}</td>;
                })()}
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </div>
  );
}
