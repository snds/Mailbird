import { FieldRow, FieldRowAction } from "@unicron/ui"
import { ZonePicker } from "@/components/zone-picker"
import { setSecondZone, useSecondZone, zoneLabel } from "@/features/calendar/zones"

/**
 * The calendar's second time zone (brief T4; ADR-0088): a second column of
 * hours beside the first in the day and the week. This device's choice. The
 * row shows the zone, and CHANGE opens the searchable list, "None" first.
 */
export function SecondZoneRow() {
  const zone = useSecondZone()
  return (
    <FieldRow
      label="Second time zone"
      description="A second column of hours in Day and Week."
      action={<ZonePicker title="Second time zone" value={zone} onPick={setSecondZone} none trigger={<FieldRowAction>Change</FieldRowAction>} />}
    >
      {zone ? zoneLabel(zone) : "None"}
    </FieldRow>
  )
}
