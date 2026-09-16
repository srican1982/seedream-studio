import type { LocalImage } from "./types";

const DB_NAME = "ai_story_people";
const STORE = "people";

export type PersonPack = {
  id: string;
  name: string;
  photos: LocalImage[];
  createdAt: number;
};

let cache: PersonPack[] = [];
let ready: Promise<PersonPack[]> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function allFromDb(): Promise<PersonPack[]> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get("all");
        req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as PersonPack[]) : []);
        req.onerror = () => reject(req.error);
      })
  );
}

function writeDb(people: PersonPack[]) {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(people, "all");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
  );
}

export function getPeople() {
  return cache;
}

export async function loadPeople() {
  if (!ready) {
    ready = allFromDb()
      .then((people) => {
        cache = people.filter((person) => person?.name && Array.isArray(person.photos));
        return cache;
      })
      .catch(() => {
        cache = [];
        return cache;
      });
  }
  return ready;
}

export async function savePerson(name: string, photos: LocalImage[]) {
  const people = await loadPeople();
  const cleanName = name.replace(/\s+/g, " ").trim();
  const usable = photos.filter((img) => img.dataUri || img.preview).slice(0, 5);
  if (!cleanName || !usable.length) throw new Error("Need a name and at least one photo.");
  const existing = people.find((person) => person.name.toLowerCase() === cleanName.toLowerCase());
  const next: PersonPack = existing
    ? { ...existing, name: cleanName, photos: usable }
    : { id: `person-${Date.now()}`, name: cleanName, photos: usable, createdAt: Date.now() };
  cache = existing ? people.map((person) => (person.id === existing.id ? next : person)) : [...people, next];
  await writeDb(cache);
  return next;
}

export async function forgetPerson(name: string) {
  const people = await loadPeople();
  const cleanName = name.replace(/\s+/g, " ").trim().toLowerCase();
  cache = people.filter((person) => person.name.toLowerCase() !== cleanName);
  await writeDb(cache);
}

export function peopleNames(people = cache) {
  return people.map((person) => person.name).filter(Boolean);
}
