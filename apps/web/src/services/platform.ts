/**
 * The few things that differ between a browser tab and the Tauri desktop shell:
 * opening links, saving and picking backup files. Tauri APIs are loaded lazily so the
 * same bundle runs in both.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function saveTextFile(suggestedName: string, contents: string): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: suggestedName, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return false;
    await writeTextFile(path, contents);
    return true;
  }
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export const MAXIMUM_IMPORT_BYTES = 30_000_000;

/** Returns the file's text, or null when the user cancelled. */
export async function pickTextFile(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile, stat } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || typeof path !== "string") return null;
    const info = await stat(path);
    if (info.size > MAXIMUM_IMPORT_BYTES) throw new Error("This backup is too large to import.");
    return readTextFile(path);
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      if (file.size > MAXIMUM_IMPORT_BYTES) { reject(new Error("This backup is too large to import.")); return; }
      file.text().then(resolve, reject);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
