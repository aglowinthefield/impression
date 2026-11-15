/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  const [n, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 60 * 24
        ? [Math.floor(minutes / 60), "hour"]
        : [Math.floor(minutes / (60 * 24)), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
