import type { AppointmentDisplayStatus } from '@addendum/shared';

/** Colour coding for Square appointments on the calendar. */
export const APPT_STYLE: Record<AppointmentDisplayStatus, { label: string; chip: string; dot: string; block: string }> = {
  confirmed: { label: 'Confirmed', chip: 'bg-sage-tint text-sage', dot: 'bg-sage', block: 'border-l-sage bg-sage-tint' },
  completed: { label: 'Completed', chip: 'bg-mist text-stone', dot: 'bg-stone-light', block: 'border-l-stone-light bg-mist' },
  cancelled: { label: 'Cancelled', chip: 'bg-rose-tint text-rose', dot: 'bg-rose', block: 'border-l-rose bg-rose-tint line-through decoration-rose/40' },
  no_show: { label: 'No-show', chip: 'bg-amber-tint text-amber', dot: 'bg-amber', block: 'border-l-amber bg-amber-tint' },
  needs_attention: { label: 'Needs attention', chip: 'bg-plum-tint text-plum', dot: 'bg-plum', block: 'border-l-plum bg-plum-tint' },
};
