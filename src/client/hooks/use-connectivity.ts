import { useEffect, useState } from "preact/hooks";
import {
  hasSavedFieldData,
  isOfflineStorageEnabled,
  isUsingSavedData,
  LIVE_DATA_EVENT,
  OFFLINE_DATA_EVENT,
  OFFLINE_STORAGE_CHANGE_EVENT,
} from "../offline";

export function useConnectivity() {
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine);
  const [usingSavedData, setUsingSavedData] = useState(isUsingSavedData);
  const [hasSavedData, setHasSavedData] = useState(false);
  const [offlineStorageEnabled, setOfflineStorageEnabled] = useState(true);

  useEffect(() => {
    let active = true;
    const wentOnline = () => setIsOffline(false);
    const wentOffline = () => setIsOffline(true);
    const usedSavedData = () => setUsingSavedData(true);
    const receivedLiveData = () => setUsingSavedData(false);
    const offlineStorageChanged = () => {
      void Promise.all([hasSavedFieldData(), isOfflineStorageEnabled()])
        .then(([available, enabled]) => {
          if (!active) return;
          setHasSavedData(available);
          setOfflineStorageEnabled(enabled);
        })
        .catch(() => {
          if (!active) return;
          setHasSavedData(false);
          setOfflineStorageEnabled(false);
        });
    };
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);
    window.addEventListener(OFFLINE_DATA_EVENT, usedSavedData);
    window.addEventListener(LIVE_DATA_EVENT, receivedLiveData);
    window.addEventListener(OFFLINE_STORAGE_CHANGE_EVENT, offlineStorageChanged);
    offlineStorageChanged();
    return () => {
      active = false;
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener(OFFLINE_DATA_EVENT, usedSavedData);
      window.removeEventListener(LIVE_DATA_EVENT, receivedLiveData);
      window.removeEventListener(OFFLINE_STORAGE_CHANGE_EVENT, offlineStorageChanged);
    };
  }, []);

  return { isOffline, usingSavedData, hasSavedData, offlineStorageEnabled, readOnly: isOffline || usingSavedData };
}
