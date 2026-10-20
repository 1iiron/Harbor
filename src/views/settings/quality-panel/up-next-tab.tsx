import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import { SettingRow } from "../kit";
import { Section, Segmented, ToggleRow } from "../shared";
import { UpNextPreview } from "./up-next-preview";

const NEXT_EP_LEADS = [
  { value: "auto", label: "Auto", sec: -1 },
  { value: "off", label: "Off", sec: 0 },
  { value: "30", label: "30s", sec: 30 },
  { value: "45", label: "45s", sec: 45 },
  { value: "60", label: "1 min", sec: 60 },
  { value: "90", label: "1.5 min", sec: 90 },
  { value: "120", label: "2 min", sec: 120 },
] as const;

function nextEpLeadKey(sec: number): string {
  return NEXT_EP_LEADS.find((o) => o.sec === sec)?.value ?? "auto";
}

const END_SCREEN_LEADS = [
  { value: "end", label: "At the end", sec: -1 },
  { value: "off", label: "Off", sec: 0 },
  { value: "30", label: "30s", sec: 30 },
  { value: "60", label: "1 min", sec: 60 },
  { value: "90", label: "1.5 min", sec: 90 },
  { value: "120", label: "2 min", sec: 120 },
  { value: "150", label: "2.5 min", sec: 150 },
  { value: "180", label: "3 min", sec: 180 },
] as const;

function endScreenLeadKey(sec: number): string {
  return END_SCREEN_LEADS.find((o) => o.sec === sec)?.value ?? "end";
}

const END_SCREEN_COUNTDOWNS = [5, 10, 15, 20, 30] as const;

export function UpNextTab() {
  const t = useT();
  const { settings, update } = useSettings();
  return (
    <>
      <Section
        title={t("Next episode prompt")}
        subtitle={t(
          "When the Up Next pill appears before an episode ends. Auto scales to the episode length, so short episodes stop prompting so early. Off hides it.",
        )}
      >
        <Segmented
          value={nextEpLeadKey(settings.nextEpisodeLeadSec)}
          options={NEXT_EP_LEADS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) =>
            update({ nextEpisodeLeadSec: NEXT_EP_LEADS.find((o) => o.value === v)?.sec ?? -1 })
          }
        />
        <UpNextPreview leadSec={settings.nextEpisodeLeadSec} />
        <ToggleRow
          label={t("Auto-play next episode")}
          sub={t(
            "When an episode ends, automatically start the next one. Off lets the episode finish and stop.",
          )}
          value={settings.autoPlayNextEpisode}
          onChange={(v) => update({ autoPlayNextEpisode: v })}
        />
        {settings.autoPlayNextEpisode && (
          <ToggleRow
            label={t("Ask if you're still watching")}
            sub={t(
              "After several episodes auto-play in a row with no input, pause and check you're still there before continuing. Off by default.",
            )}
            value={settings.stillWatching}
            onChange={(v) => update({ stillWatching: v })}
          />
        )}
        {settings.autoPlayNextEpisode && settings.stillWatching && (
          <SettingRow
            wide
            label={t("Still watching check-in")}
            desc={t("How many episodes auto-play back to back before Harbor pauses to ask.")}
          >
            <Segmented
              value={String(settings.stillWatchingAfter)}
              options={[
                { value: "2", label: t("After 2") },
                { value: "3", label: t("After 3") },
                { value: "4", label: t("After 4") },
                { value: "5", label: t("After 5") },
              ]}
              onChange={(v) => update({ stillWatchingAfter: Number(v) })}
            />
          </SettingRow>
        )}
        <ToggleRow
          label={t("Queue drives Next/Previous")}
          sub={t(
            "After the current show's episodes, Next flows into your queue. Off keeps Next/Previous within the current show only.",
          )}
          value={settings.queueDrivesNav}
          onChange={(v) => update({ queueDrivesNav: v })}
        />
      </Section>

      <Section
        title={t("More like this at the end")}
        subtitle={t(
          "Show recommendations when a movie, series finale or anime film finishes. At the end the card fills the screen; before the end the film shrinks to a corner and keeps playing behind it.",
        )}
      >
        <Segmented
          value={endScreenLeadKey(settings.endScreenLeadSec)}
          options={END_SCREEN_LEADS.map((o) => ({ value: o.value, label: t(o.label) }))}
          onChange={(v) =>
            update({ endScreenLeadSec: END_SCREEN_LEADS.find((o) => o.value === v)?.sec ?? -1 })
          }
        />
        {settings.endScreenLeadSec !== 0 && (
          <>
            <ToggleRow
              label={t("Countdown")}
              sub={t("Act automatically if nothing is chosen before time runs out.")}
              value={settings.endScreenCountdownSec > 0}
              onChange={(v) => update({ endScreenCountdownSec: v ? 15 : 0 })}
            />
            {settings.endScreenCountdownSec > 0 && (
              <>
                <SettingRow
                  wide
                  label={t("Countdown length")}
                  desc={t("How long Harbor waits before acting on the countdown.")}
                >
                  <Segmented
                    value={String(settings.endScreenCountdownSec)}
                    options={END_SCREEN_COUNTDOWNS.map((s) => ({
                      value: String(s),
                      label: t("{n}s", { n: s }),
                    }))}
                    onChange={(v) => update({ endScreenCountdownSec: Number(v) })}
                  />
                </SettingRow>
                <SettingRow
                  wide
                  label={t("When the countdown ends")}
                  desc={t("Close the player, or start whichever recommendation is focused.")}
                >
                  <Segmented
                    value={settings.endScreenOnZero}
                    options={[
                      { value: "close", label: t("Close player") },
                      { value: "play", label: t("Play focused") },
                    ]}
                    onChange={(v) =>
                      update({ endScreenOnZero: v === "play" ? "play" : "close" })
                    }
                  />
                </SettingRow>
              </>
            )}
          </>
        )}
      </Section>
    </>
  );
}
