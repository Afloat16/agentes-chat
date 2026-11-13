import {
  type LodiPrefs,
  type LodiPrefsPatch,
  type TeamWeekPeriod,
  teamWeekOn,
} from "@agenteschat/client/lib/right-hand-prefs";
import { dayText, hourText } from "@agenteschat/client/lib/team-week";
import { Button, Select } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/**
 * When one of Lodi's cards comes, and "Parar de receber": the weekly card's day and hour, or the daily card's hour
 * (the card's footer and Lodi's page).
 */
export function TeamWeekSchedule({
  period,
  prefs,
  admin,
  locale,
  onChange,
  busy = false,
  plated = false,
}: {
  period: TeamWeekPeriod;
  prefs: Pick<LodiPrefs, "weekOff" | "dayOff" | "day" | "weekHour" | "dayHour">;
  /** The weekly card is an administrator's. */
  admin: boolean;
  locale: string;
  onChange: (patch: LodiPrefsPatch) => void;
  /** A change is being saved: nothing here takes another until it lands. */
  busy?: boolean;
  /**
   * The button on a plate like the selects: where it can wrap under them (a settings row on a phone), a plate starts
   * on their edge, while bare words would start a padding further in.
   */
  plated?: boolean;
}) {
  const { t } = useTranslation();
  const on = teamWeekOn(prefs, period, admin);
  const week = period === "week";
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: dayText(locale, d) }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourText(locale, h) }));
  return (
    <>
      {week && (
        <Select
          size="sm"
          aria-label={t("teamWeek.schedule.day")}
          value={String(prefs.day)}
          options={days}
          disabled={!on || busy}
          onValueChange={(v) => onChange({ day: Number(v) })}
        />
      )}
      <Select
        size="sm"
        aria-label={t("teamWeek.schedule.hour")}
        value={String(week ? prefs.weekHour : prefs.dayHour)}
        options={hours}
        disabled={!on || busy}
        onValueChange={(v) => onChange(week ? { weekHour: Number(v) } : { dayHour: Number(v) })}
      />
      <Button
        size="sm"
        {...(plated ? {} : { variant: "ghost" as const })}
        disabled={busy}
        onClick={() => onChange(week ? { weekOff: on } : { dayOff: on })}
      >
        {t(on ? "teamWeek.schedule.stop" : "teamWeek.schedule.start")}
      </Button>
    </>
  );
}
