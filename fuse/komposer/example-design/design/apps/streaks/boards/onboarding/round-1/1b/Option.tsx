import "./styles.css";

const STEPS = ["Your goal", "Your habits", "Reminder"];

const GOALS = [
  { name: "Sleep better", hint: "Wind down and wake up rested" },
  { name: "Move more", hint: "Small bits of activity every day" },
  { name: "Feel calmer", hint: "A few quiet minutes for yourself" },
];

export default function Option() {
  return (
    <main className="guided">
      <nav className="guided-progress" aria-label="Progress">
        {STEPS.map((step, i) => (
          <div key={step} className={i === 0 ? "guided-step is-current" : "guided-step"}>
            <span className="guided-step-number">{i + 1}</span>
            <span className="guided-step-label">{step}</span>
          </div>
        ))}
      </nav>
      <section className="guided-body">
        <p className="guided-kicker">Step 1 of 3</p>
        <h1 className="guided-title">What would you like to change?</h1>
        <div className="guided-goals">
          {GOALS.map((goal, i) => (
            <button key={goal.name} type="button" className={i === 1 ? "guided-goal is-chosen" : "guided-goal"}>
              <span className="guided-goal-name">{goal.name}</span>
              <span className="guided-goal-hint">{goal.hint}</span>
            </button>
          ))}
        </div>
      </section>
      <footer className="guided-footer">
        <button type="button" className="btn-quiet">
          Skip for now
        </button>
        <button type="button" className="btn-primary">
          Next
        </button>
      </footer>
    </main>
  );
}
