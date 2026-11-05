const TOKEN_KEY = "impression.token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API with the saved token. A 401 clears it, which sends the user back to login. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const token = init.token ?? getToken();
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && init.token === undefined) setToken(null);
    throw new ApiError(res.status, json?.error ?? res.statusText);
  }
  return json as T;
}

export interface Project {
  key: string;
  name: string;
}
