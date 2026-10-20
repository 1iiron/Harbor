import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useProfiles, type Profile } from "@/lib/profiles";
import { currentAuthor, logoutAuthor, subscribeAuthor, type Author } from "@/lib/theme-auth";
import {
  currentStatus,
  setStatus,
  subscribeStatus,
  type PresenceStatus,
} from "@/lib/social/presence";
import { openMyProfile } from "@/lib/social/open-my-profile";
import { openNotificationCenter } from "@/lib/social/notification-open";

export function useAccountMenu() {
  const { user } = useAuth();
  const { profiles, activeProfile, openPicker, selectProfile } = useProfiles();
  const [author, setAuthor] = useState<Author | null>(currentAuthor);
  useEffect(() => subscribeAuthor(() => setAuthor(currentAuthor())), []);
  const [status, setStatusState] = useState<PresenceStatus>(currentStatus);
  useEffect(() => subscribeStatus(() => setStatusState(currentStatus())), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<Profile | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const authReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => setAuthOpen(false), [activeProfile?.id]);

  useEffect(() => {
    if (!menuOpen) setManageOpen(false);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen && !statusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, statusOpen]);

  const doSwitch = (p: Profile) => {
    if (p.passwordHash) openPicker({ kind: "unlock", profileId: p.id });
    else selectProfile(p.id);
  };

  const requestSwitch = (p: Profile) => {
    setMenuOpen(false);
    if (activeProfile?.kid?.parentPinHash) {
      setPendingSwitch(p);
      return;
    }
    doSwitch(p);
  };

  const viewMyProfile = async () => {
    setMenuOpen(false);
    if (!(await openMyProfile(author?.handle))) openHarborAuth();
  };

  const toggleStatus = () => {
    setMenuOpen(false);
    setStatusOpen((o) => !o);
  };

  const pickStatus = (s: PresenceStatus) => {
    setStatus(s);
    setStatusOpen(false);
  };

  const openNotifications = () => {
    setMenuOpen(false);
    openNotificationCenter();
  };

  const openHarborAuth = () => {
    if (activeProfile?.kid) return;
    const focused = document.activeElement;
    const trigger = ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");
    if (trigger) {
      authReturnFocus.current = trigger;
    } else if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !focused.closest(".harbor-profile-dropdown")
    ) {
      authReturnFocus.current = focused;
    }
    setMenuOpen(false);
    setStatusOpen(false);
    setAuthOpen(true);
  };

  const signOutHarbor = () => {
    setMenuOpen(false);
    setStatusOpen(false);
    void logoutAuthor();
  };

  return {
    ref,
    authReturnFocus,
    user,
    profiles,
    activeProfile,
    openPicker,
    author,
    status,
    menuOpen,
    setMenuOpen,
    statusOpen,
    setStatusOpen,
    manageOpen,
    setManageOpen,
    authOpen,
    setAuthOpen,
    pendingSwitch,
    setPendingSwitch,
    selectProfile,
    requestSwitch,
    viewMyProfile,
    toggleStatus,
    pickStatus,
    openNotifications,
    openHarborAuth,
    signOutHarbor,
  };
}

export type AccountMenuController = ReturnType<typeof useAccountMenu>;
