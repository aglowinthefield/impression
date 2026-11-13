import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";

interface UserSettings {
  extractionFloor: number;
}

export function Settings() {
  const [floor, setFloor] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<UserSettings>("/settings")
      .then((s) => {
        setSaved(s.extractionFloor);
        setFloor(String(s.extractionFloor));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const value = Number(floor);
  const valid = floor.trim() !== "" && value >= 0 && value <= 1;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      const s = await api<UserSettings>("/settings", {
        method: "PUT",
        body: { extractionFloor: value },
      });
      setSaved(s.extractionFloor);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section>
      <form className="flex items-end gap-2" onSubmit={save}>
        <label className="flex flex-col gap-1">
          <span>Extraction floor</span>
          <input
            className="input input-sm w-28"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
          />
        </label>
        <button
          className="btn btn-sm btn-primary"
          type="submit"
          disabled={!valid || value === saved}
        >
          Save
        </button>
      </form>
      <p>
        <small>
          Session-end extraction drops anything it is less sure of than this,
          from 0 to 1.
        </small>
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
