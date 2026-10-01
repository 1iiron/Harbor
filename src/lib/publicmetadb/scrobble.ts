import { PMDB_BASE_URL, pmdbRequest } from "./client";
import { markPmdbWatched } from "./history";
import { getSession, isAuthenticated } from "./session";
import type { PmdbSaveResumeResponse, PmdbTarget } from "./types";

export async function pmdbSaveResume(
  target: PmdbTarget,
  positionMs: number,
  runtimeMs: number,
): Promise<PmdbSaveResumeResponse | null> {
  if (!isAuthenticated()) return null;

  try {
    const res = await pmdbRequest<PmdbSaveResumeResponse>("/api/external/resume", {
      method: "POST",
      body: {
        tmdb_id: target.tmdb_id,
        media_type: target.media_type,
        season: target.season,
        episode: target.episode,
        position_ms: Math.round(positionMs),
        runtime_ms: Math.round(runtimeMs),
        id_type: target.id_type,
        id_value: target.id_value,
      },
    });

    if (res?.action === "completed") {
      void markPmdbWatched(target);
    }

    return res;
  } catch (err) {
    console.error("PublicMetaDB resume save failed:", err);
    return null;
  }
}

export async function pmdbDeleteResume(resumeId: string): Promise<boolean> {
  if (!isAuthenticated() || !resumeId) return false;

  try {
    await pmdbRequest(`/api/external/resume/${encodeURIComponent(resumeId)}`, {
      method: "DELETE",
    });
    return true;
  } catch (err) {
    console.error("PublicMetaDB resume delete failed:", err);
    return false;
  }
}

export function pmdbBeaconResume(
  target: PmdbTarget,
  positionMs: number,
  runtimeMs: number,
): void {
  const session = getSession();
  if (!session?.apiKey) return;

  const url = `${PMDB_BASE_URL}/api/external/resume`;
  const body = JSON.stringify({
    tmdb_id: target.tmdb_id,
    media_type: target.media_type,
    season: target.season,
    episode: target.episode,
    position_ms: Math.round(positionMs),
    runtime_ms: Math.round(runtimeMs),
    id_type: target.id_type,
    id_value: target.id_value,
  });

  try {
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${session.apiKey}`,
      },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
