import type { Project } from "./api";

/** Narrows a page to one repo. Empty means every repo you can see. */
export function RepoFilter({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <select
      className="select select-sm w-auto"
      aria-label="Repo"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">All repos</option>
      {projects.map((p) => (
        <option key={p.key} value={p.key}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
