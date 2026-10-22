/**
 * "Book in Square" opens the Square Dashboard calendar, where staff press Create to make the appointment
 * (Square Help: Appointments → Calendar → Create). Square doesn't publish a link that opens the new-appointment form
 * directly, so the calendar is the closest reliable page. The CRM itself never creates bookings — Square stays the
 * source of truth and the new appointment syncs back automatically.
 */
export const SQUARE_CALENDAR_URL = 'https://app.squareup.com/dashboard/appointments/calendar';

/** Always the salon's real Square Appointments calendar. */
export function squareCalendarUrl(_environment?: string) {
  return SQUARE_CALENDAR_URL;
}

/** Opens Square in a new tab and copies the client's name so it can be pasted into Square's client search. */
export function openSquareBooking(environment: string | undefined, clientName?: string | null, toast?: (m: string) => void) {
  window.open(squareCalendarUrl(environment), '_blank', 'noopener');
  if (clientName && navigator.clipboard) {
    navigator.clipboard.writeText(clientName).then(
      () => toast?.(`Square opened — press Create there. “${clientName}” is copied for the client search.`),
      () => toast?.('Square opened — press Create there to add the appointment.'),
    );
  } else toast?.('Square opened — press Create there to add the appointment.');
}
