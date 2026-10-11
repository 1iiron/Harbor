import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Film } from "lucide-react";
import { useT } from "@/lib/i18n";
import { isGenericSeasonName } from "@/lib/season-name";
import type { PickerItem } from "./series-episodes/season-arc-picker";
import type { useSeasonExplorerView } from "./use-season-explorer";
import { Synopsis } from "./synopsis";
import { horizontalScrollState } from "@/lib/horizontal-scroll";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { marqueeDurationMs } from "@/components/player/subtitle-menu/marquee-motion";
import "./season-explorer.css";

const SEASON_LABEL_CLASS =
  "shrink-0 rounded bg-ink/10 px-1.5 py-px text-[10.5px] font-semibold text-ink-muted";

function SeasonCardTitle({ text }: { text: string }) {
  const viewportRef = useRef<HTMLParagraphElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const line = textRef.current;
    if (!viewport || !line) return;
    const measure = () => {
      const overflow = Math.max(0, line.scrollWidth - viewport.clientWidth);
      const rtl = getComputedStyle(line).direction === "rtl";
      setDistance(overflow > 1 ? (rtl ? overflow : -overflow) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(line);
    return () => observer.disconnect();
  }, [text]);

  return (
    <p
      ref={viewportRef}
      className="season-explorer-title mt-3 h-6 min-w-0 overflow-hidden text-[15px] font-semibold leading-6 text-ink"
      title={text}
    >
      <span
        ref={textRef}
        dir="auto"
        className="season-explorer-title-line"
        data-overflow={distance !== 0 || undefined}
        style={
          {
            "--harbor-marquee": `${distance}px`,
            "--season-title-duration": `${Math.round(marqueeDurationMs(Math.abs(distance)) / 0.52)}ms`,
          } as React.CSSProperties
        }
      >
        {text}
      </span>
    </p>
  );
}

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

function SeasonBackdrop({ sources }: { sources: (string | undefined)[] }) {
  const [failed, setFailed] = useState<string[]>([]);
  const src = sources.find((source) => source && !failed.includes(source));
  return src ? (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed((previous) => [...previous, src])}
        className="absolute inset-y-0 right-0 h-full w-3/4 object-cover opacity-60"
      />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--color-canvas)_10%,color-mix(in_srgb,var(--color-canvas)_95%,transparent)_40%,color-mix(in_srgb,var(--color-canvas)_30%,transparent)_100%)]" />
      <div className="absolute inset-0 bg-gradient-to-t from-canvas/60 to-transparent" />
    </div>
  ) : null;
}

export function SeasonExplorer({
  data,
  activeKey,
  onSelect,
  background,
}: {
  data: ReturnType<typeof useSeasonExplorerView>;
  activeKey: string;
  onSelect: (key: string) => void;
  background?: string;
}) {
  const t = useT();
  const titleId = useId();
  const panelId = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [edges, setEdges] = useState({ left: false, right: false });
  const { items: pickerItems, seasons, details, loading } = data;
  const items = useMemo(
    () => pickerItems.filter((item) => item.seasonNumber != null && item.seasonNumber >= 0),
    [pickerItems],
  );
  const activeIndex = items.findIndex((item) => item.key === activeKey);
  const [transition, setTransition] = useState({
    key: activeKey,
    index: activeIndex,
    direction: 1,
  });
  if (transition.key !== activeKey) {
    setTransition({
      key: activeKey,
      index: activeIndex,
      direction: activeIndex < transition.index ? -1 : 1,
    });
  }
  const syncEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const { rtl, max, position } = horizontalScrollState(rail);
    const start = position > 4;
    const end = position < max - 4;
    const left = rtl ? end : start;
    const right = rtl ? start : end;
    setEdges((previous) =>
      previous.left === left && previous.right === right ? previous : { left, right },
    );
  }, []);
  const pageSeasons = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (rail)
      rail.scrollBy({
        left: direction * rail.clientWidth * 0.8,
        behavior: reducedMotion ? "auto" : "smooth",
      });
  };
  const active = items.find((item) => item.key === activeKey);
  const detail = active?.seasonNumber == null ? undefined : details.get(active.seasonNumber);
  const posterFor = (item: PickerItem) =>
    item.seasonNumber == null
      ? undefined
      : (details.get(item.seasonNumber)?.poster ?? seasons.get(item.seasonNumber)?.image);
  const titleFor = (item: PickerItem) =>
    item.seasonNumber != null &&
    (item.seasonNumber === 0
      ? item.name === "Specials"
      : isGenericSeasonName(item.name, item.seasonNumber))
      ? undefined
      : item.name;
  const labelFor = (item: PickerItem) =>
    item.seasonNumber == null
      ? undefined
      : item.seasonNumber === 0
        ? "Specials"
        : `Season ${item.seasonNumber}`;
  const countFor = (item: PickerItem) =>
    item.count === 1 ? t("{n} episode", { n: item.count }) : t("{n} episodes", { n: item.count });
  const accessibleName = (item: PickerItem) =>
    [labelFor(item), titleFor(item), countFor(item)].filter(Boolean).join(" · ");
  const formatDate = (value?: string) => {
    if (!value) return undefined;
    const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
    return Number.isNaN(date.getTime())
      ? undefined
      : date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };
  const from = formatDate(active?.from);
  const to = formatDate(active?.to);
  const dates = from && to ? (from === to ? from : `${from} – ${to}`) : from || to || active?.year;

  useEffect(() => {
    // Keep selection visible without scrolling the overview itself.
    const rail = railRef.current;
    const button = rail?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!rail) return;
    const revealSelected = (animate: boolean) => {
      if (!button) return;
      const bounds = rail.getBoundingClientRect();
      const card = button.getBoundingClientRect();
      const left =
        card.left < bounds.left
          ? card.left - bounds.left - 4
          : card.right > bounds.right
            ? card.right - bounds.right + 4
            : 0;
      if (left) rail.scrollBy({ left, behavior: animate && !reducedMotion ? "smooth" : "auto" });
    };
    revealSelected(true);
    syncEdges();
    const observer = new ResizeObserver(() => {
      revealSelected(false);
      syncEdges();
    });
    observer.observe(rail);
    return () => observer.disconnect();
  }, [activeKey, items, reducedMotion, syncEdges]);

  if (items.length === 0) return null;

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <h3 id={titleId} className="text-[22px] font-medium tracking-tight text-ink">
        {t("Seasons")}
      </h3>
      <div
        className={`grid min-w-0 grid-cols-1 items-start gap-5 ${active ? "xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" : ""}`}
      >
        <div className="relative min-w-0" data-tauri-drag-region="false">
          <div
            id={titleId + "-rail"}
            ref={railRef}
            onScroll={syncEdges}
            className="season-explorer-rail flex min-w-0 items-start snap-x snap-proximity gap-4 overflow-x-auto px-1 pb-3 pt-1"
            role="group"
            aria-labelledby={titleId}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.key === activeKey}
                aria-controls={panelId}
                aria-label={accessibleName(item)}
                title={accessibleName(item)}
                onClick={() => onSelect(item.key)}
                className={`season-explorer-card flex w-[136px] shrink-0 snap-start flex-col items-stretch rounded-xl p-1 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:w-[164px] ${item.key === activeKey ? "bg-accent/10 text-ink ring-1 ring-accent" : "text-ink-muted hover:bg-ink/5 hover:text-ink"}`}
              >
                <div className="aspect-[2/3] w-full shrink-0 overflow-hidden rounded-lg">
                  <SeasonPoster src={posterFor(item)} name={item.name} />
                </div>
                <SeasonCardTitle text={titleFor(item) || labelFor(item) || item.name} />
                {titleFor(item) && labelFor(item) && (
                  <div className="mt-1 flex h-4 items-center justify-center">
                    <span className={SEASON_LABEL_CLASS}>{labelFor(item)}</span>
                  </div>
                )}
                <p className="mt-1.5 truncate text-center text-[11.5px] leading-4 text-ink-subtle">
                  {countFor(item)}
                </p>
              </button>
            ))}
          </div>
          {edges.left && (
            <div className="season-explorer-edge season-explorer-edge-left">
              <button
                type="button"
                onClick={() => pageSeasons(-1)}
                aria-label={t("Previous seasons")}
                aria-controls={titleId + "-rail"}
                className="season-explorer-arrow"
              >
                <ChevronLeft size={22} aria-hidden />
              </button>
            </div>
          )}
          {edges.right && (
            <div className="season-explorer-edge season-explorer-edge-right">
              <button
                type="button"
                onClick={() => pageSeasons(1)}
                aria-label={t("More seasons")}
                aria-controls={titleId + "-rail"}
                className="season-explorer-arrow"
              >
                <ChevronRight size={22} aria-hidden />
              </button>
            </div>
          )}
        </div>
        {active && (
          <div
            id={panelId}
            aria-live="polite"
            aria-busy={loading}
            className="relative min-w-0 overflow-hidden rounded-2xl border border-edge bg-canvas shadow-[0_12px_40px_-24px_rgba(0,0,0,0.5)]"
          >
            <div
              key={activeKey}
              className="season-explorer-transition"
              data-direction={transition.direction}
            >
              <SeasonBackdrop sources={[detail?.background, background]} />
              <div className="relative flex min-h-[260px] items-start gap-4 p-5 sm:min-h-[316px] sm:gap-5 sm:p-6">
                <div className="aspect-[2/3] w-[104px] shrink-0 overflow-hidden rounded-xl shadow-lg sm:w-[164px]">
                  <SeasonPoster src={posterFor(active)} name={active.name} />
                </div>
                <div className="min-w-0 flex-1 py-1">
                  <div className="flex items-center gap-2.5">
                    <h4 className="min-w-0 text-[20px] font-semibold leading-tight tracking-tight text-ink sm:text-[24px]">
                      {titleFor(active) || labelFor(active)}
                    </h4>
                    {titleFor(active) && labelFor(active) && (
                      <span className={SEASON_LABEL_CLASS}>{labelFor(active)}</span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <Film size={14} aria-hidden />
                      {countFor(active)}
                    </span>
                    {dates && (
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays size={14} aria-hidden />
                        {dates}
                      </span>
                    )}
                  </div>
                  {detail?.overview ? (
                    <div className="mt-4 [&_p]:whitespace-pre-line [&_p]:text-[14px]">
                      <Synopsis key={activeKey} text={detail.overview} />
                    </div>
                  ) : loading ? (
                    <div aria-hidden className="mt-4 flex animate-pulse flex-col gap-2">
                      <div className="h-2.5 w-full rounded bg-ink/10" />
                      <div className="h-2.5 w-3/4 rounded bg-ink/10" />
                    </div>
                  ) : (
                    <p className="mt-3 text-[13px] leading-relaxed text-ink-subtle">
                      {t("No season synopsis available.")}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
