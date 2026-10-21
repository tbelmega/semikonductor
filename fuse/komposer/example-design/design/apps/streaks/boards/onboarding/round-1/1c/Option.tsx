import "./styles.css";

const ANSWERS = [
  { name: "I want more energy", habits: "Water, a short walk, bed by 11" },
  { name: "I want to focus", habits: "Reading, no phone in the morning" },
  { name: "I want to relax", habits: "Stretching, a quiet evening" },
  { name: "Not sure yet", habits: "We start with one easy habit" },
];

export default function Option() {
  return (
    <main className="one">
      <div className="one-hello">
        <span className="one-badge">Hi there</span>
        <h1 className="one-title">What brings you to Streaks?</h1>
        <p className="one-lead">Pick one. We suggest a few habits, and you can change them any time.</p>
      </div>
      <div className="one-answers">
        {ANSWERS.map((answer) => (
          <button key={answer.name} type="button" className="one-card">
            <span className="one-card-name">{answer.name}</span>
            <span className="one-card-habits">{answer.habits}</span>
          </button>
        ))}
      </div>
      <p className="one-later">You can set reminders later in Settings.</p>
    </main>
  );
}
