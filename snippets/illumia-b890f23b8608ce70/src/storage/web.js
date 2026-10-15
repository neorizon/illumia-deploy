// Browser side of `storage/web.rs`: file pickers through the File System
// Access API, with the picked `FileSystemFileHandle`s kept in IndexedDB so a
// later Save (or a recent-file entry, after a reload) can reach the same file
// again. Where the API is missing (Firefox, Safari) opening falls back to a
// plain file input and saving to a download.

const DB_NAME = "illumia";
const STORE = "file-handles";
const TYPES = [{ description: "Illumia scene", accept: { "application/json": [".json"] } }];

/// This session's handles by key — saves an IndexedDB round trip, and still
/// works if IndexedDB is unavailable (private browsing).
const handles = new Map();

let db = null;

function openDb() {
  db = db || new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Try again next time rather than caching the failure.
  db.catch(() => (db = null));
  return db;
}

/// Runs `body` against the handle store and resolves once its transaction
/// completes, with whatever `body` returned (read `.result` from requests
/// only after that).
async function transact(mode, body) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const value = body(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function storedHandles() {
  const { keys, values } = await transact("readonly", (store) => ({ keys: store.getAllKeys(), values: store.getAll() }));
  return keys.result.map((key, i) => [key, values.result[i]]);
}

async function getHandle(key) {
  if (handles.has(key)) return handles.get(key);
  const request = await transact("readonly", (store) => store.get(key));
  if (request.result) handles.set(key, request.result);
  return request.result;
}

function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/// The key `handle` is stored under — an existing one if this same file was
/// stored before, so it keeps a single entry in the recent list.
async function rememberHandle(handle) {
  for (const [key, known] of handles) {
    if (await known.isSameEntry(handle)) return key;
  }
  let key = null;
  try {
    for (const [storedKey, stored] of await storedHandles()) {
      if (await stored.isSameEntry(handle)) {
        key = storedKey;
        break;
      }
    }
  } catch (_) {
    // No IndexedDB: the handle still lasts for this session.
  }
  key = key || newKey();
  handles.set(key, handle);
  try {
    await transact("readwrite", (store) => store.put(handle, key));
  } catch (_) {}
  return key;
}

/// Asks for `mode` access if not already granted — needed again for handles
/// restored after a reload, and allowed because this runs off a click or key
/// press.
async function permitted(handle, mode) {
  const options = { mode };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

function isAbort(err) {
  return err && err.name === "AbortError";
}

function openWithInput() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, key: null, text: await file.text() });
      } catch (err) {
        reject(err);
      }
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/// Resolves to `[{ name, bytes }]` for every picture picked — none if the
/// picker was dismissed. A plain file input, which every browser has (on a
/// phone it offers the photo library and camera too); there's no handle to
/// keep, an import not being a file to save back to.
export function illumia_pick_images() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg";
    input.addEventListener("change", async () => {
      try {
        const files = Array.from(input.files || []);
        resolve(await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))));
      } catch (err) {
        reject(err);
      }
    });
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/// Resolves to `{ name, key, text }`, or `null` if the picker was dismissed.
/// `key` is `null` when the file came from the fallback input.
export async function illumia_open_file() {
  if (!window.showOpenFilePicker) return openWithInput();
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ types: TYPES });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
  const file = await handle.getFile();
  return { name: file.name, key: await rememberHandle(handle), text: await file.text() };
}

/// Reopens a previously stored file by its key.
export async function illumia_open_key(key) {
  const handle = await getHandle(key);
  if (!handle) throw new DOMException("This file is no longer available here. Open it again from disk.", "NotFoundError");
  if (!(await permitted(handle, "read"))) throw new DOMException("Permission to read the file was denied.", "NotAllowedError");
  const file = await handle.getFile();
  return { name: file.name, key, text: await file.text() };
}

/// Writes `text` to the file stored under `key`, or — with no key — to a
/// file the user picks. Resolves to `{ name, key }`, or `null` if the picker
/// was dismissed. Without a save picker at all, downloads the file instead
/// (and resolves with a `null` key: there's no way back to it).
export async function illumia_save(key, suggestedName, text) {
  let handle = key ? await getHandle(key) : null;
  if (handle) {
    if (!(await permitted(handle, "readwrite"))) throw new Error("Permission to write the file was denied.");
  } else {
    if (!window.showSaveFilePicker) {
      download(suggestedName, text);
      return { name: suggestedName, key: null };
    }
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types: TYPES });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    key = await rememberHandle(handle);
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return { name: handle.name, key };
}

function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/// Writes an exported image (`bytes`, of MIME type `type`) to a file the
/// user picks, suggested as `suggestedName`. Resolves to its name, or
/// `null` if the picker was dismissed. Without a save picker, downloads it.
/// The handle isn't kept: an export isn't a file to reopen.
export async function illumia_export(suggestedName, description, type, extension, bytes) {
  if (!window.showSaveFilePicker) {
    download(suggestedName, bytes, type);
    return suggestedName;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [type]: [extension] } }] });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
  const writable = await handle.createWritable();
  await writable.write(new Blob([bytes], { type }));
  await writable.close();
  return handle.name;
}

/// Drops every stored handle whose key isn't in `keep` — the recent list
/// has let go of them. Fire and forget.
export function illumia_forget_handles_except(keep) {
  const wanted = new Set(keep);
  transact("readwrite", (store) => {
    const request = store.getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result) {
        if (!wanted.has(key)) store.delete(key);
      }
    };
  }).catch(() => {});
}
