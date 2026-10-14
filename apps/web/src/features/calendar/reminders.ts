/** Reminder presets, in minutes before the start. */
export const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]

/** "At the start", "15 minutes before", "1 day before". */
export function reminderLabel(minutes: number, allDay = false) {
  if (minutes === 0) return allDay ? "At midnight" : "At the start"
  if (minutes < 0) return `${-minutes} minutes after`
  if (minutes % 10080 === 0) return `${minutes / 10080} week${minutes === 10080 ? "" : "s"} before`
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"} before`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"} before`
  return `${minutes} minutes before`
}
