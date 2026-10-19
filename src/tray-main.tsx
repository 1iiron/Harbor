import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TrayMenu } from "./tray/tray-menu";
import { newerSnapshot, type TrayAction, type TraySnapshot } from "./tray/types";
import "./tray/tray-menu.css";

function TrayRoot() {
  const [snapshot, setSnapshot] = useState<TraySnapshot | null>(null);
  const presented = useRef(0);
  const accept = useCallback((incoming: TraySnapshot) => {
    setSnapshot((current) => newerSnapshot(current, incoming));
  }, []);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const stop = await listen<TraySnapshot>("harbor://tray-menu-state", (event) => {
        if (live) accept(event.payload);
      });
      if (!live) {
        stop();
        return;
      }
      unlisten = stop;
      const initial = await invoke<TraySnapshot>("tray_popup_snapshot");
      if (live) accept(initial);
    })().catch((error) => console.error("[harbor::tray] initialization failed", error));
    return () => {
      live = false;
      unlisten?.();
    };
  }, [accept]);

  useLayoutEffect(() => {
    if (!snapshot?.display) return;
    const { display } = snapshot;
    const element = document.documentElement;
    for (const [key, value] of Object.entries(display.tokens))
      element.style.setProperty(key, value);
    element.dir = display.direction;
    element.style.colorScheme = display.colorScheme;
    if (!snapshot.open || presented.current === snapshot.openId) return;
    presented.current = snapshot.openId;
    // Commit the themed panel's layout before asking native code to reveal it.
    // Hidden WebViews may suspend animation frames, so readiness uses the commit.
    document.getElementById("root")?.getBoundingClientRect();
    void invoke("tray_popup_present", { openId: snapshot.openId }).catch((error) => {
      console.error("[harbor::tray] presentation failed", error);
    });
  }, [snapshot]);

  const action = useCallback(
    async (value: TrayAction) => {
      accept(await invoke<TraySnapshot>("tray_popup_action", { action: value }));
    },
    [accept],
  );
  const dismiss = useCallback(() => {
    void invoke("tray_popup_dismiss").catch((error) =>
      console.error("[harbor::tray] dismissal failed", error),
    );
  }, []);
  const submenu = useCallback(async (open: boolean) => {
    await invoke("tray_popup_submenu", { open });
  }, []);

  return snapshot?.open && snapshot.display ? (
    <TrayMenu
      key={snapshot.openId}
      snapshot={snapshot}
      onAction={action}
      onDismiss={dismiss}
      onSubmenuChange={submenu}
    />
  ) : null;
}

createRoot(document.getElementById("root")!).render(<TrayRoot />);
