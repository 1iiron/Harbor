import { useState } from "react";
import publicmetadbLogo from "@/assets/publicmetadb.svg";
import { usePublicMetaDb } from "@/lib/publicmetadb/provider";
import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import { openUrl } from "@/lib/window";
import { Section, ToggleRow } from "./shared";
import {
  ModalButton,
  ROW_ACTION_PRIMARY,
  ROW_DESC,
  SettingGroup,
  SettingRow,
  SettingsModal,
} from "./kit";
import { SButton } from "./ui";
import { TrackerIdentity } from "./tracker-identity";
import { ExternalLink, Eye, EyeOff, Key, LogOut } from "./icons";

export function PublicMetaDbPanel() {
  const t = useT();
  const { session, isConnected, connect, disconnect } = usePublicMetaDb();
  const { settings, update } = useSettings();

  const [inputKey, setInputKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);

  const handleConnect = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const key = inputKey.trim();
    if (!key) {
      setErrorMessage(t("Please enter your PublicMetaDB API key"));
      return;
    }

    setConnecting(true);
    setErrorMessage(null);

    try {
      const ok = await connect(key);
      if (ok) {
        setInputKey("");
      } else {
        setErrorMessage(t("Invalid API key or unable to reach PublicMetaDB"));
      }
    } catch {
      setErrorMessage(t("Connection failed. Check your network or API key"));
    } finally {
      setConnecting(false);
    }
  };

  const handleTestConnection = async () => {
    if (!session?.apiKey) return;
    setRefreshing(true);
    setRefreshStatus(null);
    try {
      const ok = await connect(session.apiKey);
      setRefreshStatus(ok ? t("Connection verified") : t("Connection failed"));
    } catch {
      setRefreshStatus(t("Connection failed"));
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshStatus(null), 3000);
    }
  };

  const maskedKey = session?.apiKey
    ? `${session.apiKey.slice(0, 5)}••••••••${session.apiKey.slice(-4)}`
    : "";

  return (
    <>
      {!isConnected ? (
        <Section title={t("Not connected")} bare>
          <div className="flex items-start gap-6 pb-5 pt-1">
            <div className="grid size-[72px] shrink-0 place-items-center rounded-[18px] bg-elevated">
              <img src={publicmetadbLogo} alt="" draggable={false} className="size-10 object-contain" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
              <h2 className="text-[24px] font-semibold leading-8 tracking-[-0.5px] text-ink">
                PublicMetaDB
              </h2>
              <p className="max-w-[56ch] text-[15.5px] leading-[23px] text-ink-muted">
                {t(
                  "Track your watch history and sync playback resume points with PublicMetaDB. Generate an API key from your PublicMetaDB profile settings to connect.",
                )}
              </p>

              <form onSubmit={handleConnect} className="mt-3 flex w-full max-w-md flex-col gap-3">
                <div className="relative flex items-center">
                  <span className="pointer-events-none absolute left-3.5 text-ink-subtle">
                    <Key size={16} />
                  </span>
                  <input
                    type={showKey ? "text" : "password"}
                    value={inputKey}
                    onChange={(e) => {
                      setInputKey(e.target.value);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="pm-..."
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    className="h-11 w-full rounded-[10px] border border-edge bg-elevated pl-10 pr-11 font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-ink/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 text-ink-subtle hover:text-ink"
                    title={showKey ? t("Hide key") : t("Show key")}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {errorMessage && (
                  <p className="text-[13.5px] text-danger">{errorMessage}</p>
                )}

                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button
                    type="submit"
                    disabled={connecting || !inputKey.trim()}
                    className={`${ROW_ACTION_PRIMARY} disabled:opacity-50`}
                  >
                    {connecting ? t("Verifying...") : t("Connect PublicMetaDB")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openUrl("https://publicmetadb.com")}
                    className="inline-flex min-h-11 items-center gap-2 text-[15px] text-ink-muted transition-colors hover:text-ink"
                  >
                    {t("Get an API key")}
                    <ExternalLink size={15} />
                  </button>
                </div>
              </form>
            </div>
          </div>
        </Section>
      ) : (
        <>
          <Section
            title={t("Connected")}
            subtitle={t("Harbor will scrobble your playback progress and sync watch history with PublicMetaDB.")}
          >
            <TrackerIdentity
              service="PublicMetaDB"
              logo={publicmetadbLogo}
              handle={maskedKey}
              profileUrl="https://publicmetadb.com"
              onDisconnect={() => setConfirmDisconnect(true)}
            />

            <SettingGroup label={t("Tracking & Scrobble")}>
              <ToggleRow
                label={t("Scrobble playback progress")}
                sub={t("Automatically save resume points and mark completed items in PublicMetaDB as you watch.")}
                value={settings.publicmetadbScrobbleEnabled}
                onChange={(on) => update({ publicmetadbScrobbleEnabled: on })}
              />
              <ToggleRow
                label={t("Show in Continue Watching")}
                sub={t("Include PublicMetaDB resume points on Harbor's Home Continue Watching rail.")}
                value={settings.cwSources.publicmetadb}
                onChange={(on) =>
                  update({ cwSources: { ...settings.cwSources, publicmetadb: on } })
                }
              />
            </SettingGroup>

            <SettingGroup label={t("Account & Connection")}>
              <SettingRow
                label={t("Verify connection")}
                desc={
                  refreshStatus
                    ? refreshStatus
                    : t("Test that your stored API key is still valid and reachable.")
                }
              >
                <SButton
                  onClick={handleTestConnection}
                  disabled={refreshing}
                >
                  {refreshing ? t("Testing...") : t("Test Connection")}
                </SButton>
              </SettingRow>
            </SettingGroup>
          </Section>
        </>
      )}

      {confirmDisconnect && (
        <SettingsModal
          open={confirmDisconnect}
          title={t("Disconnect PublicMetaDB?")}
          onClose={() => setConfirmDisconnect(false)}
          actions={
            <>
              <ModalButton ghost onClick={() => setConfirmDisconnect(false)}>
                {t("Cancel")}
              </ModalButton>
              <SButton
                variant="danger"
                onClick={() => {
                  disconnect();
                  setConfirmDisconnect(false);
                }}
              >
                <LogOut size={18} strokeWidth={2.2} />
                {t("Disconnect")}
              </SButton>
            </>
          }
        >
          <p className={`max-w-[66ch] ${ROW_DESC}`}>
            {t(
              "Playback scrobbling and resume point sync with PublicMetaDB will stop for this profile.",
            )}
          </p>
        </SettingsModal>
      )}
    </>
  );
}
