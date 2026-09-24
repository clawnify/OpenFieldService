import { useEffect, useState } from "preact/hooks";
import {
  hasSavedFieldData,
  isUsingSavedData,
  LIVE_DATA_EVENT,
  OFFLINE_DATA_EVENT,
  SAVED_DATA_CHANGE_EVENT,
} from "../offline";

export function useConnectivity() {
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine);
  const [usingSavedData, setUsingSavedData] = useState(isUsingSavedData);
  const [hasSavedData, setHasSavedData] = useState(false);

  useEffect(() => {
    let active = true;
    const wentOnline = () => setIsOffline(false);
    const wentOffline = () => setIsOffline(true);
    const usedSavedData = () => setUsingSavedData(true);
    const receivedLiveData = () => setUsingSavedData(false);
    const savedDataChanged = () => {
      void hasSavedFieldData()
        .then((available) => { if (active) setHasSavedData(available); })
        .catch(() => { if (active) setHasSavedData(false); });
    };
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);
    window.addEventListener(OFFLINE_DATA_EVENT, usedSavedData);
    window.addEventListener(LIVE_DATA_EVENT, receivedLiveData);
    window.addEventListener(SAVED_DATA_CHANGE_EVENT, savedDataChanged);
    savedDataChanged();
    return () => {
      active = false;
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener(OFFLINE_DATA_EVENT, usedSavedData);
      window.removeEventListener(LIVE_DATA_EVENT, receivedLiveData);
      window.removeEventListener(SAVED_DATA_CHANGE_EVENT, savedDataChanged);
    };
  }, []);

  return { isOffline, usingSavedData, hasSavedData, readOnly: isOffline || usingSavedData };
}
