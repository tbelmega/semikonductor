import "./styles.css";
import messages from "./messages/en.json";
import type { TodayData } from "./data.ts";

type Key = keyof typeof messages;

function t(key: Key, values: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

export default function Page({ data }: { data: TodayData }) {
  const done = data.habits.filter((h) => h.done).length;
  const date = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long" }).format(new Date(data.date));
  return (
    <main className="today">
      <header className="today-header">
        <p className="today-date">{date}</p>
        <h1 className="today-greeting">{t("today.greeting", { name: data.firstName })}</h1>
        {data.habits.length > 0 && <p className="today-progress">{t("today.progress", { done, total: data.habits.length })}</p>}
      </header>
      {data.habits.length === 0 ? (
        <section className="today-empty">
          <h2 className="today-empty-title">{t("today.empty.title")}</h2>
          <p className="today-empty-body">{t("today.empty.body")}</p>
          <button type="button" className="btn-primary">
            {t("today.empty.action")}
          </button>
        </section>
      ) : (
        <ul className="today-list">
          {data.habits.map((habit) => (
            <li key={habit.id} className={habit.done ? "today-habit is-done" : "today-habit"}>
              <span className="today-check" aria-hidden="true" />
              <span className="today-habit-text">
                <span className="today-habit-name">{habit.name}</span>
                <span className="today-habit-when">{t(`today.when.${habit.when}` as Key)}</span>
              </span>
              <span className="today-streak">{t("today.streak", { days: habit.streak })}</span>
            </li>
          ))}
        </ul>
      )}
      {data.habits.length > 0 && (
        <button type="button" className="btn-quiet today-add">
          {t("today.add")}
        </button>
      )}
    </main>
  );
}
