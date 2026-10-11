import { useEffect, useId, useRef, useState } from "react";
import { Film } from "lucide-react";
import { useT } from "@/lib/i18n";
import { seasonPill } from "@/lib/season-name";
import { tvdbLangFromIso1 } from "@/lib/providers/tvdb";
import { tmdbLanguageIso } from "@/lib/providers/tmdb/tmdb-client";
import type { PickerItem } from "./series-episodes/season-arc-picker";
import { useSeasonExplorer } from "./use-season-explorer";
import { Synopsis } from "./synopsis";

function SeasonPoster({ src, name }: { src?: string; name: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return src && failedSrc !== src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className="h-full w-full object-cover"
    />
  ) : (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-raised p-2 text-ink-subtle">
      <Film size={22} aria-hidden />
      <span className="line-clamp-3 text-center text-[10px] font-medium">{name}</span>
    </div>
  );
}

export function SeasonExplorer({
  metaId,
  imdbId,
  tvdbKey,
  seasonType,
  items,
  activeKey,
  onSelect,
}: {
  metaId: string;
  imdbId?: string | null;
  tvdbKey: string;
  seasonType: string;
  items: PickerItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const panelId = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const active = items.find((item) => item.key === activeKey);
  const { seasons, details, loading } = useSeasonExplorer({
    metaId,
    imdbId,
    tvdbKey,
    seasonType,
    lang: tvdbLangFromIso1(tmdbLanguageIso()),
    activeSeason: active?.seasonNumber,
  });
  const detail = active?.seasonNumber == null ? undefined : details.get(active.seasonNumber);
  const posterFor = (item: PickerItem) =>
    item.seasonNumber == null
      ? undefined
      : (details.get(item.seasonNumber)?.poster ?? seasons.get(item.seasonNumber)?.image);
  const nameFor = (item: PickerItem) =>
    item.seasonNumber == null ? item.name : details.get(item.seasonNumber)?.name || item.name;
  const countFor = (item: PickerItem) =>
    item.count === 1 ? t("{n} episode", { n: item.count }) : t("{n} episodes", { n: item.count });

  const activePill = active
    ? seasonPill({ name: nameFor(active), seasonNumber: active.seasonNumber }, t)
    : null;

  useEffect(() => {
    // Scroll only the rail so selecting a late season does not move the overview page.
    const rail = railRef.current;
    const button = rail?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!rail || !button) return;
    const bounds = rail.getBoundingClientRect();
    const card = button.getBoundingClientRect();
    if (card.left < bounds.left) rail.scrollBy({ left: card.left - bounds.left });
    else if (card.right > bounds.right) rail.scrollBy({ left: card.right - bounds.right });
  }, [activeKey, items]);

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-4">
      <h3
        id={titleId}
        className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-subtle"
      >
        {t("Seasons")}
      </h3>
      <div
        ref={railRef}
        className="flex min-w-0 gap-3 overflow-x-auto pb-2 pt-1"
        role="group"
        aria-labelledby={titleId}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={item.key === activeKey}
            aria-controls={panelId}
            aria-label={`${nameFor(item)} · ${countFor(item)}`}
            title={nameFor(item)}
            onClick={() => onSelect(item.key)}
            className={`w-[88px] shrink-0 rounded-xl p-1 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:w-[100px] ${item.key === activeKey ? "bg-accent/10 text-ink ring-1 ring-accent" : "text-ink-muted hover:bg-ink/5 hover:text-ink"}`}
          >
            <div className="aspect-[2/3] overflow-hidden rounded-lg">
              <SeasonPoster src={posterFor(item)} name={nameFor(item)} />
            </div>
            <p className="mt-2 truncate text-[12px] font-medium">{nameFor(item)}</p>
            <p className="mt-0.5 truncate text-[10.5px] text-ink-subtle">{countFor(item)}</p>
          </button>
        ))}
      </div>
      {active && (
        <div
          id={panelId}
          aria-live="polite"
          aria-busy={loading}
          className="flex items-start gap-4 rounded-2xl border border-edge bg-ink/[0.025] p-3 sm:p-4"
        >
          <div className="aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg sm:w-[72px]">
            <SeasonPoster src={posterFor(active)} name={nameFor(active)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[14px] font-semibold text-ink">{nameFor(active)}</h4>
              {activePill && (
                <span className="rounded bg-ink/10 px-1.5 py-px text-[10.5px] font-semibold text-ink-muted">
                  {activePill}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11.5px] text-ink-subtle">
              {countFor(active)}
              {active.year && ` · ${active.year}`}
            </p>
            {detail?.overview ? (
              <div className="mt-2 [&_p]:whitespace-pre-line [&_p]:text-[13px]">
                <Synopsis key={activeKey} text={detail.overview} />
              </div>
            ) : loading ? (
              <div aria-hidden className="mt-3 flex animate-pulse flex-col gap-2">
                <div className="h-2.5 w-full rounded bg-ink/10" />
                <div className="h-2.5 w-3/4 rounded bg-ink/10" />
              </div>
            ) : (
              <p className="mt-2 text-[13px] leading-relaxed text-ink-subtle">
                {t("No season synopsis available.")}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
