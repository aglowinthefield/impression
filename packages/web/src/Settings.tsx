import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";
import { CONTACT } from "./contact";
import { Tokens } from "./Tokens";

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
          <span>How sure a memory must be to keep</span>
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
          From 0 to 1. Higher keeps fewer memories that are more often right;
          lower keeps more, with more noise. 0.7 suits most people.
        </small>
      </p>
      {error && <p role="alert">{error}</p>}
      <Tokens />
      <h2 className="mt-6 text-base font-semibold">Your data</h2>
      <p className="text-sm">
        To delete your sessions and memories from this server, email{" "}
        <a className="link" href={`mailto:${CONTACT}`}>
          {CONTACT}
        </a>
        .{" "}
        <a className="link" href="/start#data">
          What Impression stores
        </a>
      </p>
    </section>
  );
}
