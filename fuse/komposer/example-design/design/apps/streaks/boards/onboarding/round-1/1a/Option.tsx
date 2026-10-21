import "./styles.css";

const SUGGESTED = [
  { name: "Drink a glass of water", when: "Morning", picked: true },
  { name: "Walk for 10 minutes", when: "Afternoon", picked: true },
  { name: "Read 5 pages", when: "Evening", picked: false },
  { name: "Stretch", when: "Morning", picked: false },
  { name: "No phone after 10 pm", when: "Night", picked: false },
];

export default function Option() {
  return (
    <main className="checklist">
      <header className="checklist-header">
        <p className="checklist-brand">Streaks</p>
        <h1 className="checklist-title">Pick your first habits</h1>
        <p className="checklist-lead">Start small. Two or three habits are plenty for the first week.</p>
      </header>
      <ul className="checklist-list">
        {SUGGESTED.map((habit) => (
          <li key={habit.name} className={habit.picked ? "checklist-item is-picked" : "checklist-item"}>
            <span className="checklist-box" aria-hidden="true">
              {habit.picked ? "✓" : ""}
            </span>
            <span className="checklist-name">{habit.name}</span>
            <span className="checklist-when">{habit.when}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="checklist-add">
        + Add your own habit
      </button>
      <footer className="checklist-footer">
        <span className="checklist-count">2 habits picked</span>
        <button type="button" className="btn-primary">
          Start my streak
        </button>
      </footer>
    </main>
  );
}
