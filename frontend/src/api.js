const DEFAULT_API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export function getApiUrl() {
  return localStorage.getItem("flashfix_api_url") || DEFAULT_API_URL;
}

export function setApiUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (normalized) localStorage.setItem("flashfix_api_url", normalized);
  else localStorage.removeItem("flashfix_api_url");
  return getApiUrl();
}

export async function api(path, { token, method = "GET", body } = {}) {
  const apiUrl = getApiUrl();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error(`Cannot reach backend API at ${apiUrl}. Start backend or update the backend URL.`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

export const API_URL = getApiUrl();
