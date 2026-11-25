/**
 * Resolves a "date" column value (e.g. "2026-10-17") to the end of that
 * calendar day in UTC (23:59:59.999Z), since Postgres `date` columns carry
 * no time component and TypeORM returns them as bare YYYY-MM-DD strings.
 * A value that already carries a time component is returned unchanged.
 */
export function endOfDayUTC(dueDate: Date | string): Date {
  if (typeof dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return new Date(`${dueDate}T23:59:59.999Z`);
  }

  const date = new Date(dueDate);
  const isMidnightUTC =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;

  if (isMidnightUTC) {
    date.setUTCHours(23, 59, 59, 999);
  }

  return date;
}

/**
 * Checks whether a due date has passed, treating a date-only value as
 * expiring at the end of that day (UTC) rather than at its start.
 */
export function isPastDueDate(dueDate: Date | string, referenceDate: Date = new Date()): boolean {
  return endOfDayUTC(dueDate).getTime() < referenceDate.getTime();
}

/**
 * Resolves a date-only due date (e.g. "2026-10-17", or a Date) to the start
 * of that calendar day in UTC (00:00:00.000Z). Only the UTC calendar date of
 * a Date value is used.
 */
export function startOfDayUTC(dueDate: Date | string): Date {
  if (typeof dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return new Date(`${dueDate}T00:00:00.000Z`);
  }
  const date = new Date(dueDate);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Secondary market trading cutoff for an invoice (issue #747): trading stops
 * when the maturity day begins, 00:00:00.000Z on the due date. Fractions are
 * tradable while `now < cutoff`; at the cutoff itself they are not.
 *
 * This is the rule listing creation, purchase, relisting and the depth book
 * all apply, and the latest instant a listing may expire. It is earlier than
 * primary investment eligibility (`isPastDueDate`, end of the due day)
 * because a secondary trade must settle before the invoice does.
 */
export function secondaryTradingCutoff(dueDate: Date | string): Date {
  return startOfDayUTC(dueDate);
}

/** Whether secondary trading in an invoice with this due date has closed. */
export function isPastSecondaryTradingCutoff(
  dueDate: Date | string | null | undefined,
  now: Date
): boolean {
  if (!dueDate) return false;
  return now.getTime() >= secondaryTradingCutoff(dueDate).getTime();
}
