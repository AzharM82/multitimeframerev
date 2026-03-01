import { useState, useEffect } from "react";

export function useMarketHours() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function check() {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = et.getDay();
      if (day === 0 || day === 6) {
        setIsOpen(false);
        return;
      }
      const mins = et.getHours() * 60 + et.getMinutes();
      setIsOpen(mins >= 570 && mins <= 960); // 9:30-16:00 ET
    }

    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  return isOpen;
}
