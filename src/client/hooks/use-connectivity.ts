import { useEffect, useState } from "preact/hooks";
import { isUsingSavedData, LIVE_DATA_EVENT, OFFLINE_DATA_EVENT } from "../offline";

export function useConnectivity() {
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine);
  const [usingSavedData, setUsingSavedData] = useState(isUsingSavedData);

  useEffect(() => {
    const wentOnline = () => setIsOffline(false);
    const wentOffline = () => setIsOffline(true);
    const usedSavedData = () => setUsingSavedData(true);
    const receivedLiveData = () => setUsingSavedData(false);
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);
    window.addEventListener(OFFLINE_DATA_EVENT, usedSavedData);
    window.addEventListener(LIVE_DATA_EVENT, receivedLiveData);
    return () => {
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener(OFFLINE_DATA_EVENT, usedSavedData);
      window.removeEventListener(LIVE_DATA_EVENT, receivedLiveData);
    };
  }, []);

  return { isOffline, usingSavedData, readOnly: isOffline || usingSavedData };
}
