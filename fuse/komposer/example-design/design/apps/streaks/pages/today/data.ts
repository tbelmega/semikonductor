// The types of the Today page's data.

export interface Habit {
  id: string;
  name: string;
  when: "morning" | "afternoon" | "evening" | "night";
  done: boolean;
  streak: number;
}

export interface TodayData {
  firstName: string;
  date: string;
  habits: Habit[];
}
