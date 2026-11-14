/**
 * A `google.type.Date` in its JSON form: a whole calendar day, such as the
 * day a version takes effect, with no time of day or time zone. A month
 * runs from 1 to 12 and a day from 1 to 31.
 */
export interface CalendarDate {
  year?: number;
  month?: number;
  day?: number;
}
